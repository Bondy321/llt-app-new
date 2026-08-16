const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyManifestUpdateDirect,
  MANIFEST_STATUS,
  updateManifestBooking,
} = require('../services/bookingServiceRealtime');

const createManifestDb = (initialValue) => {
  let value = initialValue;
  const paths = [];
  return {
    db: {
      ref: (path) => {
        paths.push(path);
        return {
          transaction: async (updater) => {
            const next = updater(value);
            if (next === undefined) return { committed: false, snapshot: { val: () => value } };
            value = next;
            return { committed: true, snapshot: { val: () => value } };
          },
        };
      },
    },
    getValue: () => value,
    getPaths: () => paths,
  };
};

test('manifest transaction returns exact server state when a newer update wins', async () => {
  const serverValue = {
    passengerStatus: [MANIFEST_STATUS.BOARDED],
    status: MANIFEST_STATUS.BOARDED,
    lastUpdated: '2026-08-12T10:30:00.000Z',
    idempotencyKey: 'server-update',
  };
  const harness = createManifestDb(serverValue);
  const result = await applyManifestUpdateDirect({
    tourCode: 'TOUR 1',
    bookingRef: 'ABC123',
    passengerStatuses: [MANIFEST_STATUS.NO_SHOW],
    lastUpdated: '2026-08-12T10:00:00.000Z',
    idempotencyKey: 'offline-update',
  }, harness.db);

  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.status, MANIFEST_STATUS.BOARDED);
  assert.equal(result.conflict.serverStatus, MANIFEST_STATUS.BOARDED);
  assert.equal(result.conflict.attemptedStatus, MANIFEST_STATUS.NO_SHOW);
  assert.equal(result.conflict.serverLastUpdated, serverValue.lastUpdated);
  assert.deepEqual(harness.getValue(), serverValue);
});

test('manifest transaction commits a newer local update and remains idempotent on replay', async () => {
  const harness = createManifestDb({
    passengerStatus: [MANIFEST_STATUS.PENDING],
    status: MANIFEST_STATUS.PENDING,
    lastUpdated: '2026-08-12T09:00:00.000Z',
  });
  const payload = {
    tourCode: 'TOUR_1',
    bookingRef: 'ABC123',
    passengerStatuses: [MANIFEST_STATUS.BOARDED],
    lastUpdated: '2026-08-12T10:00:00.000Z',
    idempotencyKey: 'manifest-idempotent-1',
  };

  const first = await applyManifestUpdateDirect(payload, harness.db);
  const second = await applyManifestUpdateDirect(payload, harness.db);

  assert.equal(first.success, true);
  assert.equal(first.status, MANIFEST_STATUS.BOARDED);
  assert.equal(second.success, true);
  assert.equal(second.duplicateDelivery, true);
  assert.equal(harness.getValue().idempotencyKey, payload.idempotencyKey);
});

test('updateManifestBooking exposes server-preserved status instead of attempted status', async () => {
  const harness = createManifestDb({
    passengerStatus: [MANIFEST_STATUS.NO_SHOW],
    status: MANIFEST_STATUS.NO_SHOW,
    lastUpdated: '2099-01-01T00:00:00.000Z',
  });
  const result = await updateManifestBooking(
    'TOUR_1',
    'ABC123',
    [MANIFEST_STATUS.BOARDED],
    { online: true, db: harness.db, idempotencyKey: 'attempt-1' },
  );

  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.status, MANIFEST_STATUS.NO_SHOW);
  assert.equal(result.conflict.serverStatus, MANIFEST_STATUS.NO_SHOW);
  assert.match(result.conflictMessage, /server kept the newer no show status/i);
});
