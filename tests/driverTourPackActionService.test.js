const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyOptimistic,
  createDriverTourPackActionService,
  normalizeChange,
  validatePayload,
} = require('../services/driverTourPackActionService');

const SCOPE = Object.freeze({
  departureKey: '2026-09-10::5001D_1',
  tourId: '5001D_1',
  driverId: 'D-1',
  authUid: 'uid-1',
});

const memoryStorage = () => {
  const values = new Map();
  return {
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => values.set(key, value),
    deleteItemAsync: async (key) => values.delete(key),
  };
};

test('queues an exact identity-scoped pickup action while offline', async () => {
  let queuedAction;
  const service = createDriverTourPackActionService({
    queue: {
      enqueueAction: async (value) => {
        queuedAction = value;
        return { success: true, data: value };
      },
    },
    storage: memoryStorage(),
    getDatabase: () => null,
    now: () => 100,
  });

  const result = await service.submit(SCOPE, {
    packRevision: 2,
    kind: 'pickup',
    targetId: 'stop_1',
    state: 'COMPLETED',
  }, { online: false });

  assert.equal(result.success, true);
  assert.equal(result.data.queued, true);
  assert.equal(queuedAction.type, 'DRIVER_TOUR_PACK_ACTION');
  assert.equal(queuedAction.scope.principalId, 'driver:D-1');
  assert.equal(queuedAction.payload.departureKey, SCOPE.departureKey);
  assert.equal(queuedAction.payload.authUid, SCOPE.authUid);
  assert.equal(result.data.actions.pickupStops.stop_1.state, 'COMPLETED');
});

test('writes a bounded pickup action directly while online', async () => {
  let path;
  let update;
  const service = createDriverTourPackActionService({
    db: {
      ref: (value) => ({
        update: async (next) => {
          path = value;
          update = next;
        },
      }),
    },
    storage: memoryStorage(),
    now: () => 100,
  });

  const result = await service.submit(SCOPE, {
    packRevision: 2,
    kind: 'pickup',
    targetId: 'stop_1',
    state: 'ARRIVED',
  });

  assert.equal(result.success, true);
  assert.equal(path, `driver_tour_pack_actions/${SCOPE.departureKey}/${SCOPE.driverId}`);
  assert.equal(update['pickupStops/stop_1/state'], 'ARRIVED');
  assert.equal(update['pickupStops/stop_1/updatedAtMs'], 100);
  assert.equal(update['pickupStops/stop_1'], undefined);
  assert.equal(update.packRevision, 2);
  assert.equal(update.updatedAtMs, 100);
});

test('writes service and hotel progress through rule-approved leaf paths', async () => {
  const updates = [];
  const service = createDriverTourPackActionService({
    db: { ref: () => ({ update: async (value) => updates.push(value) }) },
    storage: memoryStorage(),
    now: () => 100,
  });

  await service.submit(SCOPE, { packRevision: 2, kind: 'service', targetId: 'service_1', state: 'SKIPPED' });
  await service.submit(SCOPE, { packRevision: 2, kind: 'hotel', targetId: 'hotel_1', state: 'COMPLETED' });

  assert.equal(updates[0]['serviceCompletion/service_1/state'], 'SKIPPED');
  assert.equal(updates[0]['serviceCompletion/service_1/updatedAtMs'], 100);
  assert.equal(updates[0]['serviceCompletion/service_1'], undefined);
  assert.equal(updates[1]['hotelCompletion/hotel_1/state'], 'COMPLETED');
  assert.equal(updates[1]['hotelCompletion/hotel_1/updatedAtMs'], 100);
  assert.equal(updates[1]['hotelCompletion/hotel_1'], undefined);
});

test('writes structured issue fields as an atomic leaf update and allocates a bounded slot', async () => {
  let update;
  const service = createDriverTourPackActionService({
    db: { ref: () => ({ update: async (value) => { update = value; } }) },
    storage: memoryStorage(),
    now: () => 100,
  });

  const result = await service.submit(SCOPE, {
    packRevision: 2,
    kind: 'issue',
    category: 'vehicle',
    severity: 'critical',
    summary: 'Engine warning light is on',
  });

  assert.equal(result.success, true);
  assert.equal(result.data.issueId, 'issue_001');
  assert.equal(update['issues/issue_001/category'], 'vehicle');
  assert.equal(update['issues/issue_001/severity'], 'critical');
  assert.equal(update['issues/issue_001/summary'], 'Engine warning light is on');
  assert.equal(update['issues/issue_001'], undefined);
});

test('does not persist optimistic state when an online write is denied', async () => {
  const service = createDriverTourPackActionService({
    db: { ref: () => ({ update: async () => { throw new Error('permission denied'); } }) },
    storage: memoryStorage(),
    now: () => 100,
  });
  const result = await service.submit(SCOPE, {
    packRevision: 2,
    kind: 'pickup',
    targetId: 'stop_1',
    state: 'ARRIVED',
  });
  const cached = await service.readCache(SCOPE);

  assert.equal(result.success, false);
  assert.deepEqual(cached.data.actions.pickupStops, {});
});

test('rejects invalid action scopes and free-text issue email addresses', () => {
  assert.equal(validatePayload({ ...SCOPE, packRevision: 2, kind: 'pickup', targetId: 'stop_1', state: 'INVALID' }).valid, false);
  assert.equal(validatePayload({
    ...SCOPE,
    packRevision: 2,
    kind: 'issue',
    targetId: 'issue_001',
    issue: {
      schemaVersion: 1,
      issueId: 'issue_001',
      category: 'delay',
      severity: 'warning',
      status: 'open',
      summary: 'Contact passenger@example.com',
      revision: 2,
      createdAtMs: 100,
      updatedAtMs: 100,
      statusUpdatedAtMs: 100,
      statusUpdatedBy: 'driver',
    },
  }).valid, false);
});

test('normalizes only safe semantic change metadata', () => {
  const change = normalizeChange({
    schemaVersion: 1,
    changeId: 'change-2',
    departureKey: SCOPE.departureKey,
    tourId: SCOPE.tourId,
    revision: 2,
    previousRevision: 1,
    changedSections: { hotels: true, passengers: true, rawEmail: true },
    critical: true,
    requiresAcknowledgement: true,
    createdAtMs: 100,
    passengerName: 'Must not flow',
  }, SCOPE);

  assert.deepEqual(change.changedSections, ['hotels', 'passengers']);
  assert.equal(change.passengerName, undefined);
  assert.equal(change.critical, true);
});

test('optimistic action updates never alter manifest boarding state', () => {
  const actions = applyOptimistic(null, {
    ...SCOPE,
    packRevision: 3,
    kind: 'service',
    targetId: 'service_1',
    state: 'COMPLETED',
  }, 200);

  assert.deepEqual(actions.serviceCompletion.service_1, { state: 'COMPLETED', updatedAtMs: 200 });
  assert.equal(actions.boarded, undefined);
  assert.equal(actions.passengers, undefined);
});
