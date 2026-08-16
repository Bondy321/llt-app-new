const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-llt-safety';

const values = new Map();
let failWrites = false;
const firebaseWrites = [];
const authMock = { currentUser: null };
let pushedId = 0;
let setWriteHook = null;
const fetchCalls = [];
let fetchHandler = null;
global.fetch = async (url, options) => {
  fetchCalls.push({ url, options, body: JSON.parse(options?.body || '{}') });
  if (fetchHandler) return fetchHandler(url, options);
  const body = JSON.parse(options?.body || '{}');
  return {
    ok: true,
    status: 201,
    json: async () => ({ success: true, eventId: body.clientEventId, receivedAtMs: Date.now() }),
  };
};
const realtimeDbMock = {
  ref: (path = '') => ({
    update: async (updates) => {
      for (const [updatePath, value] of Object.entries(updates || {})) {
        if (setWriteHook) await setWriteHook(updatePath, value);
        firebaseWrites.push({ path: updatePath, value });
      }
    },
    push: () => {
      const key = `event-${++pushedId}`;
      return {
        key,
        set: async (value) => {
          if (setWriteHook) await setWriteHook(path, value);
          firebaseWrites.push({ path: `${path}/${key}`, value });
        },
      };
    },
    set: async (value) => firebaseWrites.push({ path, value }),
    remove: async () => firebaseWrites.push({ path, value: null }),
    onDisconnect: () => ({
      remove: async () => firebaseWrites.push({ path: `${path}:onDisconnect`, value: null }),
      cancel: async () => firebaseWrites.push({ path: `${path}:onDisconnectCancel`, value: null }),
    }),
  }),
};
const asyncStorage = {
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => {
    if (failWrites) throw new Error('device storage full');
    values.set(key, value);
  },
  removeItem: async (key) => values.delete(key),
};

const logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: asyncStorage };
  }
  if (request === '../firebase') {
    return {
      auth: authMock,
      realtimeDb: realtimeDbMock,
    };
  }
  if (request === './loggerService') {
    return { __esModule: true, default: logger };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  __testables,
  getOfflineQueueCount,
  getOfflineQueuedSafetyEvents,
  getTrustedContacts,
  addTrustedContact,
  removeTrustedContact,
  processOfflineQueue,
  queueOfflineSafetyEvent,
  logSafetyEvent,
  updateLiveLocationSharing,
} = require('../services/safetyService');
Module._load = originalLoad;

test.beforeEach(() => {
  values.clear();
  failWrites = false;
  firebaseWrites.length = 0;
  authMock.currentUser = null;
  pushedId = 0;
  setWriteHook = null;
  fetchCalls.length = 0;
  fetchHandler = null;
});

const authenticate = (uid = 'auth-user') => {
  authMock.currentUser = { uid, getIdToken: async () => `token-for-${uid}` };
};

const scope = (principalId, tourId = 'TOUR-1', role = 'passenger') => ({
  tourId,
  userId: principalId,
  role,
});

test('offline safety queue caps growth while prioritizing critical reports', () => {
  const { MAX_OFFLINE_SAFETY_EVENTS, boundOfflineSafetyQueue } = __testables;
  const routine = Array.from({ length: MAX_OFFLINE_SAFETY_EVENTS + 40 }, (_, index) => ({
    id: `routine-${index}`,
    severity: 'low',
    timestamp: new Date(1700000000000 + index).toISOString(),
  }));
  const critical = Array.from({ length: 5 }, (_, index) => ({
    id: `critical-${index}`,
    severity: 'critical',
    timestamp: new Date(1700001000000 + index).toISOString(),
  }));

  const bounded = boundOfflineSafetyQueue([...routine, ...critical]);

  assert.equal(bounded.length, MAX_OFFLINE_SAFETY_EVENTS);
  assert.equal(bounded.filter((event) => event.severity === 'critical').length, 5);
  assert.equal(bounded.some((event) => event.id === 'routine-0'), false);
  assert.equal(bounded.some((event) => event.id === `routine-${routine.length - 1}`), true);
});

test('malformed queue is backed up and does not block the next safety report', async () => {
  values.set('@LLT:safetyOfflineQueue', '{broken-json');

  const result = await queueOfflineSafetyEvent({
    category: 'incident',
    severity: 'high',
    message: 'Need assistance',
    ...scope('passenger-1'),
  });

  assert.equal(result.success, true);
  assert.equal(result.queueLength, 1);
  assert.equal(values.get('@LLT:safetyOfflineQueue:corruptBackup'), '{broken-json');
  const saved = JSON.parse(values.get('@LLT:safetyOfflineQueue'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].message, 'Need assistance');
});

test('offline queue write failures are surfaced instead of claiming the report was saved', async () => {
  failWrites = true;

  await assert.rejects(
    queueOfflineSafetyEvent({ category: 'incident', severity: 'high', ...scope('passenger-1') }),
    /device storage full/,
  );
});

test('concurrent safety report enqueues preserve every event', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, index) => queueOfflineSafetyEvent({
    id: `report-${index}`,
    category: 'incident',
    severity: 'medium',
    message: `Report ${index}`,
    ...scope('passenger-1'),
  })));

  assert.equal(await getOfflineQueueCount(scope('passenger-1')), 30);
  const raw = JSON.parse(values.get('@LLT:safetyOfflineQueue'));
  assert.equal(new Set(raw.map((event) => event.id)).size, 30);
});

test('safety queue visibility and replay remain isolated by tour principal', async () => {
  await queueOfflineSafetyEvent({ id: 'owned-a', category: 'incident', ...scope('passenger-a') });
  await queueOfflineSafetyEvent({ id: 'owned-b', category: 'medical', ...scope('passenger-b') });

  assert.equal(await getOfflineQueueCount(scope('passenger-a')), 1);
  assert.deepEqual(
    (await getOfflineQueuedSafetyEvents(scope('passenger-a'))).map((event) => event.id),
    ['owned-a'],
  );

  authenticate();
  const result = await processOfflineQueue(scope('passenger-a'));
  assert.equal(result.processed, 1);
  assert.equal(result.retainedForOtherSessions, 1);
  assert.equal(await getOfflineQueueCount(scope('passenger-a')), 0);
  assert.equal(await getOfflineQueueCount(scope('passenger-b')), 1);
  assert.equal(fetchCalls.some(({ body }) => body.id === 'owned-a'), true);
  assert.equal(fetchCalls.some(({ body }) => body.id === 'owned-b'), false);
});

test('unscoped safety reports are rejected instead of becoming cross-session data', async () => {
  await assert.rejects(
    queueOfflineSafetyEvent({ category: 'incident', severity: 'high' }),
    (error) => error?.code === 'SAFETY_QUEUE_SCOPE_REQUIRED',
  );
  assert.equal(values.has('@LLT:safetyOfflineQueue'), false);
});

test('a newly queued report is not blocked or removed by an in-flight replay', async () => {
  authenticate();
  await queueOfflineSafetyEvent({ id: 'snapshot-report', category: 'incident', ...scope('passenger-a') });

  let releaseRemoteWrite;
  const remoteWriteReleased = new Promise((resolve) => { releaseRemoteWrite = resolve; });
  let signalRemoteWriteStarted;
  const remoteWriteStarted = new Promise((resolve) => { signalRemoteWriteStarted = resolve; });
  fetchHandler = async (_url, options) => {
    signalRemoteWriteStarted();
    await remoteWriteReleased;
    const body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ success: true, eventId: body.clientEventId }) };
  };

  const replayPromise = processOfflineQueue(scope('passenger-a'));
  await remoteWriteStarted;
  const enqueueResult = await queueOfflineSafetyEvent({
    id: 'raised-during-replay',
    category: 'medical',
    ...scope('passenger-a'),
  });
  assert.equal(enqueueResult.success, true);
  releaseRemoteWrite();
  const replayResult = await replayPromise;

  assert.equal(replayResult.processed, 1);
  assert.deepEqual(
    (await getOfflineQueuedSafetyEvents(scope('passenger-a'))).map((event) => event.id),
    ['raised-during-replay'],
  );
});

test('critical safety submission uses the authenticated idempotent backend boundary', async () => {
  authenticate();
  const result = await logSafetyEvent({
    userId: 'auth-user',
    principalId: 'passenger-a',
    bookingId: 'BOOKING-A',
    tourId: 'TOUR-1',
    role: 'passenger',
    category: 'sos',
    severity: 'critical',
    message: 'SOS opened',
    isSOS: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.queued, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /submitSafetyReport$/);
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer token-for-auth-user');
  assert.equal(fetchCalls[0].body.clientEventId, result.eventId);
  assert.equal(fetchCalls[0].body.category, 'sos');
  assert.equal(fetchCalls[0].body.isSOS, true);
});

test('atomic remote failure keeps the report queued with the same idempotency key', async () => {
  authenticate();
  fetchHandler = async () => { throw new Error('network unavailable'); };

  const result = await logSafetyEvent({
    userId: 'auth-user',
    principalId: 'passenger-a',
    tourId: 'TOUR-1',
    role: 'passenger',
    category: 'incident',
    severity: 'high',
    message: 'Need help',
  });

  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  const queued = await getOfflineQueuedSafetyEvents(scope('passenger-a'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].clientEventId, result.payload.clientEventId);
});

test('explicitly offline safety submission is saved immediately without waiting on fetch', async () => {
  authenticate();
  const result = await logSafetyEvent({
    userId: 'auth-user',
    principalId: 'passenger-a',
    tourId: 'TOUR-1',
    role: 'passenger',
    category: 'incident',
    severity: 'high',
    message: 'Need help',
    online: false,
  });
  assert.equal(result.queued, true);
  assert.equal(fetchCalls.length, 0);
});

test('live location sharing is auth-owned, versioned, bounded, and disconnect-safe', async () => {
  authenticate();
  assert.equal(await updateLiveLocationSharing('TOUR-1', 'auth-user', true, {
    latitude: 56.0,
    longitude: -4.6,
    accuracy: 10,
  }), true);
  const liveWrite = firebaseWrites.find(({ path }) => path === 'tours/TOUR-1/liveTracking/auth-user');
  assert.equal(liveWrite.value.schemaVersion, 2);
  assert.deepEqual(liveWrite.value.lastUpdate, { '.sv': 'timestamp' });
  assert.equal(firebaseWrites.some(({ path }) => path.endsWith(':onDisconnect')), true);
  assert.equal(await updateLiveLocationSharing('TOUR-1', 'different-user', true, {
    latitude: 56.0,
    longitude: -4.6,
    accuracy: 10,
  }), false);
  assert.equal(await updateLiveLocationSharing('TOUR-1', 'auth-user', false), true);
  assert.equal(firebaseWrites.some(({ path }) => path.endsWith(':onDisconnectCancel')), true);
  assert.equal(firebaseWrites.at(-1).value, null);
});

test('trusted contacts are private to the active principal', async () => {
  const first = await addTrustedContact('passenger-a', { name: 'Alice', phone: '07000000001' });
  await addTrustedContact('passenger-b', { name: 'Bob', phone: '07000000002' });

  assert.deepEqual((await getTrustedContacts('passenger-a')).map((contact) => contact.name), ['Alice']);
  assert.deepEqual((await getTrustedContacts('passenger-b')).map((contact) => contact.name), ['Bob']);
  assert.deepEqual(await getTrustedContacts(null), []);

  await removeTrustedContact('passenger-a', first.id);
  assert.deepEqual(await getTrustedContacts('passenger-a'), []);
  assert.equal((await getTrustedContacts('passenger-b')).length, 1);
});

test('trusted contact mutations are serialized and surface durable-storage failure', async () => {
  await Promise.all(Array.from({ length: 5 }, (_, index) => addTrustedContact('passenger-a', {
    name: `Contact ${index}`,
    phone: `0700000000${index}`,
  })));
  assert.equal((await getTrustedContacts('passenger-a')).length, 5);
  await assert.rejects(
    addTrustedContact('passenger-a', { name: 'Sixth', phone: '07000000006' }),
    (error) => error?.code === 'TRUSTED_CONTACT_LIMIT',
  );

  failWrites = true;
  await assert.rejects(
    removeTrustedContact('passenger-a', (await getTrustedContacts('passenger-a'))[0].id),
    (error) => error?.code === 'TRUSTED_CONTACT_SAVE_FAILED',
  );
  failWrites = false;
  assert.equal((await getTrustedContacts('passenger-a')).length, 5);
});
