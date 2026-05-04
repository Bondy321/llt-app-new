const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const originalLoad = Module._load;

const buildSafetyHarness = ({ updateImpl } = {}) => {
  const updateCalls = [];
  const storage = new Map();

  let currentUpdateImpl = updateImpl || (async (payload) => {
    updateCalls.push(payload);
  });

  const setUpdateImpl = (next) => {
    currentUpdateImpl = next;
  };

  Module._load = function mocked(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return {
        __esModule: true,
        default: {
          getItem: async (key) => (storage.has(key) ? storage.get(key) : null),
          setItem: async (key, value) => { storage.set(key, value); },
          removeItem: async (key) => { storage.delete(key); },
        },
      };
    }

    if (request === '../firebase' || request.endsWith('/firebase')) {
      return {
        __esModule: true,
        realtimeDb: {
          ref: () => ({
            update: (payload) => currentUpdateImpl(payload),
          }),
        },
      };
    }

    if (request === './loggerService' || request.endsWith('/loggerService')) {
      return {
        __esModule: true,
        default: {
          info: async () => {},
          warn: async () => {},
          error: async () => {},
          fatal: async () => {},
        },
      };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/safetyService')];
  const service = require('../services/safetyService');

  return { service, updateCalls, storage, setUpdateImpl };
};

test.afterEach(() => {
  Module._load = originalLoad;
});

test('logSafetyEvent writes user log, tour alert, and global alert atomically for SOS', async () => {
  const { service, updateCalls } = buildSafetyHarness();

  const result = await service.logSafetyEvent({
    userId: 'user-1',
    tourId: 'tour-9',
    role: 'passenger',
    category: service.SAFETY_CATEGORIES.SOS,
    severity: service.SEVERITY_LEVELS.CRITICAL,
    message: 'SOS triggered',
    isSOS: true,
  });

  assert.equal(result.success, true);
  assert.match(result.eventId, /^safety_\d+_[a-z0-9]+$/);
  assert.equal(updateCalls.length, 1, 'expected exactly one atomic update');

  const paths = Object.keys(updateCalls[0]).sort();
  assert.deepEqual(paths, [
    `globalSafetyAlerts/${result.eventId}`,
    `logs/user-1/safety/${result.eventId}`,
    `tours/tour-9/safetyAlerts/${result.eventId}`,
  ]);

  assert.equal(updateCalls[0][`logs/user-1/safety/${result.eventId}`].isSOS, true);
  assert.equal(
    updateCalls[0][`globalSafetyAlerts/${result.eventId}`].tourAlertId,
    `tours/tour-9/safetyAlerts/${result.eventId}`
  );
});

test('logSafetyEvent skips global alert path for non-SOS, non-critical events', async () => {
  const { service, updateCalls } = buildSafetyHarness();

  const result = await service.logSafetyEvent({
    userId: 'user-2',
    tourId: 'tour-3',
    role: 'driver',
    category: service.SAFETY_CATEGORIES.DELAY,
    severity: service.SEVERITY_LEVELS.LOW,
    message: 'Running late',
  });

  assert.equal(result.success, true);
  const paths = Object.keys(updateCalls[0]).sort();
  assert.deepEqual(paths, [
    `logs/user-2/safety/${result.eventId}`,
    `tours/tour-3/safetyAlerts/${result.eventId}`,
  ]);
});

test('logSafetyEvent omits tour alert when no tour is supplied', async () => {
  const { service, updateCalls } = buildSafetyHarness();

  const result = await service.logSafetyEvent({
    userId: 'user-3',
    role: 'passenger',
    category: service.SAFETY_CATEGORIES.HARASSMENT,
    severity: service.SEVERITY_LEVELS.HIGH,
    message: 'Report without tour context',
  });

  assert.equal(result.success, true);
  const paths = Object.keys(updateCalls[0]);
  assert.deepEqual(paths, [`logs/user-3/safety/${result.eventId}`]);
});

test('logSafetyEvent queues with the same eventId when the atomic write fails', async () => {
  const { service, storage, setUpdateImpl } = buildSafetyHarness();
  setUpdateImpl(async () => { throw new Error('rtdb offline'); });

  await assert.rejects(service.logSafetyEvent({
    userId: 'user-4',
    tourId: 'tour-1',
    role: 'passenger',
    category: service.SAFETY_CATEGORIES.SOS,
    severity: service.SEVERITY_LEVELS.CRITICAL,
    message: 'offline SOS',
    isSOS: true,
  }), /rtdb offline/);

  const queueRaw = storage.get('@LLT:safetyOfflineQueue');
  assert.ok(queueRaw, 'queue must be persisted');
  const queue = JSON.parse(queueRaw);
  assert.equal(queue.length, 1);
  assert.match(queue[0].eventId, /^safety_/);
  assert.equal(queue[0].attempts, 0);
  assert.equal(queue[0].isSOS, true);
});

test('processOfflineQueue replays with the original eventId so retries are idempotent', async () => {
  const { service, storage, updateCalls, setUpdateImpl } = buildSafetyHarness();

  setUpdateImpl(async () => { throw new Error('rtdb offline'); });
  await assert.rejects(service.logSafetyEvent({
    userId: 'user-5',
    tourId: 'tour-7',
    role: 'passenger',
    category: service.SAFETY_CATEGORIES.SOS,
    severity: service.SEVERITY_LEVELS.CRITICAL,
    message: 'queued SOS',
    isSOS: true,
  }));

  const queuedEventId = JSON.parse(storage.get('@LLT:safetyOfflineQueue'))[0].eventId;

  setUpdateImpl(async (payload) => { updateCalls.push(payload); });

  const result = await service.processOfflineQueue('user-5');
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.dropped, 0);
  assert.equal(updateCalls.length, 1);

  const replayPaths = Object.keys(updateCalls[0]).sort();
  assert.deepEqual(replayPaths, [
    `globalSafetyAlerts/${queuedEventId}`,
    `logs/user-5/safety/${queuedEventId}`,
    `tours/tour-7/safetyAlerts/${queuedEventId}`,
  ]);
  assert.equal(updateCalls[0][`logs/user-5/safety/${queuedEventId}`].processedFromQueue, true);
  assert.equal(storage.has('@LLT:safetyOfflineQueue'), false, 'queue must be cleared on full success');
});

test('processOfflineQueue increments attempts on failure and keeps the eventId stable', async () => {
  const { service, storage, setUpdateImpl } = buildSafetyHarness();

  setUpdateImpl(async () => { throw new Error('still offline'); });
  await assert.rejects(service.logSafetyEvent({
    userId: 'user-6',
    tourId: 'tour-2',
    role: 'passenger',
    category: service.SAFETY_CATEGORIES.INCIDENT,
    severity: service.SEVERITY_LEVELS.HIGH,
    message: 'persistent failure',
  }));

  const initialEventId = JSON.parse(storage.get('@LLT:safetyOfflineQueue'))[0].eventId;

  const result = await service.processOfflineQueue('user-6');
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.dropped, 0);

  const queueAfter = JSON.parse(storage.get('@LLT:safetyOfflineQueue'));
  assert.equal(queueAfter.length, 1);
  assert.equal(queueAfter[0].eventId, initialEventId);
  assert.equal(queueAfter[0].attempts, 1);
  assert.equal(queueAfter[0].lastError, 'still offline');
});

test('processOfflineQueue drops events that exceed the max attempt cap', async () => {
  const { service, storage, setUpdateImpl } = buildSafetyHarness();

  // Pre-seed a queued event already at the threshold so the next failed
  // attempt pushes it over MAX_REPLAY_ATTEMPTS (5).
  storage.set('@LLT:safetyOfflineQueue', JSON.stringify([{
    eventId: 'safety_legacy_abc',
    userId: 'user-7',
    tourId: 'tour-1',
    role: 'passenger',
    category: 'incident',
    severity: 'high',
    message: 'permanently broken',
    timestamp: new Date().toISOString(),
    attempts: 4,
  }]));

  setUpdateImpl(async () => { throw new Error('permanent rejection'); });

  const result = await service.processOfflineQueue('user-7');
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.dropped, 1);
  assert.equal(storage.has('@LLT:safetyOfflineQueue'), false, 'dropped event must clear the queue');
});

test('processOfflineQueue is single-flight; concurrent callers do not double-publish', async () => {
  const { service, storage, updateCalls, setUpdateImpl } = buildSafetyHarness();

  storage.set('@LLT:safetyOfflineQueue', JSON.stringify([{
    eventId: 'safety_concurrent_1',
    userId: 'user-8',
    tourId: 'tour-x',
    role: 'passenger',
    category: 'sos',
    severity: 'critical',
    message: 'concurrent replay',
    isSOS: true,
    timestamp: new Date().toISOString(),
    attempts: 0,
  }]));

  let releaseFirstUpdate;
  const firstUpdateGate = new Promise((resolve) => { releaseFirstUpdate = resolve; });

  let updateInvocations = 0;
  setUpdateImpl(async (payload) => {
    updateInvocations++;
    await firstUpdateGate;
    updateCalls.push(payload);
  });

  const firstCall = service.processOfflineQueue('user-8');
  // Yield so the first call has a chance to grab the lock before the second runs.
  await new Promise((resolve) => setImmediate(resolve));
  const secondCall = service.processOfflineQueue('user-8');

  const secondResult = await secondCall;
  assert.deepEqual(secondResult, { processed: 0, failed: 0, dropped: 0, alreadyRunning: true });

  releaseFirstUpdate();
  const firstResult = await firstCall;

  assert.equal(firstResult.processed, 1);
  assert.equal(updateInvocations, 1, 'rtdb update must run exactly once across concurrent callers');
  assert.equal(updateCalls.length, 1);
  assert.equal(storage.has('@LLT:safetyOfflineQueue'), false);
});

test('queueOfflineSafetyEvent dedupes by eventId so re-queues do not stack', async () => {
  const { service, storage } = buildSafetyHarness();

  await service.queueOfflineSafetyEvent({
    eventId: 'safety_stable_1',
    userId: 'user-9',
    tourId: 'tour-1',
    category: 'sos',
    severity: 'critical',
    message: 'first try',
    isSOS: true,
  });

  await service.queueOfflineSafetyEvent({
    eventId: 'safety_stable_1',
    userId: 'user-9',
    tourId: 'tour-1',
    category: 'sos',
    severity: 'critical',
    message: 'second try with same id',
    isSOS: true,
  });

  const queue = JSON.parse(storage.get('@LLT:safetyOfflineQueue'));
  assert.equal(queue.length, 1, 'duplicate eventIds must not stack');
  assert.equal(queue[0].message, 'second try with same id');
});
