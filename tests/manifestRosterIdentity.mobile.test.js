const test = require('node:test');
const assert = require('node:assert/strict');
const { applyManifestUpdateDirect, updateManifestBooking, ensureBookingSchemaConsistency } = require('../services/bookingServiceRealtime');
const offlineSync = require('../services/offlineSyncService');
const { storage, QUEUE_KEY } = require('../services/offline-sync/offlineSyncContext');
const { createDriverManifestCacheService } = require('../services/driverManifestCacheService');

const identity = { passengerIds: [`srcpax_v1_${'a'.repeat(64)}`, `srcpax_v1_${'b'.repeat(64)}`], rosterRevision: 'c'.repeat(64) };
const scope = { tourId: 'ROSTER_TOUR', principalId: 'driver:D-ROSTER', role: 'driver', authUid: 'roster-auth' };
const denyDb = { ref: () => ({ transaction: async () => { const error = new Error('PERMISSION_DENIED'); error.code = 'PERMISSION_DENIED'; throw error; } }) };
const clearQueue = async () => {
  const queue = await offlineSync.getQueuedActions({ includeAll: true });
  for (const action of queue.data || []) await offlineSync.removeAction(action.id, { includeAll: true });
};
test.afterEach(clearQueue);

test('direct boarding writes carry exact roster identity and preserve distinct same-name source passengers', async () => {
  let stored;
  const db = { ref: () => ({ transaction: async updater => {
    stored = updater(null);
    return { committed: true, snapshot: { val: () => stored } };
  } }) };
  const result = await applyManifestUpdateDirect({ ...identity, tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'] }, db);
  assert.equal(result.success, true);
  assert.deepEqual(stored.passengerIds, identity.passengerIds);
  assert.equal(stored.rosterRevision, identity.rosterRevision);
  assert.equal(stored.passengerIdsJson, JSON.stringify(identity.passengerIds));
  assert.equal(stored.passengerStatusCodes, 'BP');
  assert.equal(stored.passengerStatusCodes.length, identity.passengerIds.length);
  const normalized = await ensureBookingSchemaConsistency('ROSTER1', {
    ...identity, boardingReviewRequired: true, passengerNames: ['Same Name', 'Same Name'], seatNumbers: [0, 0], seatLabels: ['TBA', 'TBA'],
  });
  assert.equal(normalized.duplicatePassengerCount, 0);
  assert.deepEqual(normalized.normalizedBooking.passengerIds, identity.passengerIds);
  assert.equal(normalized.normalizedBooking.boardingReviewRequired, true);
});

test('cached source roster roundtrips exact IDs and rejects optimistic updates from a different revision', async () => {
  const values = new Map();
  const cache = createDriverManifestCacheService({ now: () => 1_000, storage: {
    getItemAsync: async key => values.get(key), setItemAsync: async (key, value) => values.set(key, value), deleteItemAsync: async key => values.delete(key),
  } });
  const saved = await cache.replace({ tourId: scope.tourId, driverId: 'D-ROSTER', fetchedAtMs: 900, manifest: {
    tourId: scope.tourId, complete: true, bookings: [{ ...identity, boardingReviewRequired: true, id: 'ROSTER1', passengerNames: ['Same Name', 'Same Name'], passengerStatus: ['PENDING', 'PENDING'] }],
  } });
  assert.equal(saved.success, true);
  assert.deepEqual((await cache.get({ tourId: scope.tourId, driverId: 'D-ROSTER' })).data.bookings[0].passengerIds, identity.passengerIds);
  assert.equal((await cache.get({ tourId: scope.tourId, driverId: 'D-ROSTER' })).data.bookings[0].boardingReviewRequired, true);
  const options = { ...identity, tourId: scope.tourId, driverId: 'D-ROSTER', bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'] };
  assert.equal((await cache.applyOptimisticUpdate(options)).success, true);
  assert.equal((await cache.applyOptimisticUpdate({ ...options, rosterRevision: 'd'.repeat(64) })).success, false);
  assert.equal((await cache.applyOptimisticUpdate({ ...options, passengerIds: undefined, rosterRevision: undefined })).success, false);
});

test('offline queue persists roster identity and replay passes it unchanged to the write boundary', async () => {
  await clearQueue();
  await offlineSync.setActiveSessionScope(scope);
  await updateManifestBooking(scope.tourId, 'ROSTER1', ['BOARDED', 'PENDING'], { ...identity, online: false, actorPrincipalId: scope.principalId, authUid: scope.authUid, idempotencyKey: 'roster-offline' });
  const persisted = JSON.parse(await storage.getItemAsync(QUEUE_KEY));
  assert.deepEqual(persisted[0].payload.passengerIds, identity.passengerIds);
  assert.equal(persisted[0].payload.rosterRevision, identity.rosterRevision);
  const queued = (await offlineSync.getQueuedActions({ scope })).data;
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].payload.passengerIds, identity.passengerIds);
  assert.equal(queued[0].payload.rosterRevision, identity.rosterRevision);
  let replayPayload;
  await offlineSync.replayQueue({ scope, services: { bookingService: { applyManifestUpdateDirect: async payload => { replayPayload = payload; return { success: true }; } } } });
  assert.deepEqual(replayPayload.passengerIds, identity.passengerIds);
  assert.equal(replayPayload.rosterRevision, identity.rosterRevision);
});

test('stale permission rejection never queues an online write and old positional queued actions fail terminally', async () => {
  await clearQueue();
  await offlineSync.setActiveSessionScope(scope);
  await assert.rejects(updateManifestBooking(scope.tourId, 'ROSTER1', ['BOARDED', 'PENDING'], { ...identity, online: true, db: denyDb }), /Refresh the manifest/);
  assert.equal((await offlineSync.getQueuedActions({ scope })).data.length, 0);
  await offlineSync.enqueueAction({ id: 'legacy-roster-offline', type: 'MANIFEST_UPDATE', tourId: scope.tourId, scope, payload: { tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'] } });
  await offlineSync.replayQueue({ scope, db: denyDb, services: { bookingService: { applyManifestUpdateDirect } } });
  const failed = (await offlineSync.getQueuedActions({ scope })).data[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /Refresh the manifest/);
});

test('a fresh typed roster can replace previous history while newer mismatched history requires refresh', async () => {
  const current = { ...identity, rosterRevision: 'd'.repeat(64), passengerIds: [`srcpax_v1_${'e'.repeat(64)}`, `srcpax_v1_${'f'.repeat(64)}`], passengerStatus: ['NO_SHOW', 'BOARDED'], lastUpdated: '2026-08-01T08:00:00Z' };
  let written = false;
  let writtenValue;
  const db = { ref: () => ({ transaction: async updater => {
    const next = updater(current); written = next !== undefined; writtenValue = next;
    return { committed: written, snapshot: { val: () => current } };
  } }) };
  const fresh = await applyManifestUpdateDirect({ ...identity, tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'], lastUpdated: '2026-08-01T09:00:00Z' }, db);
  assert.equal(written, true);
  assert.equal(fresh.success, true);
  assert.deepEqual(writtenValue.passengerIds, identity.passengerIds);
  assert.equal(writtenValue.rosterRevision, identity.rosterRevision);
  assert.deepEqual(writtenValue.passengerStatus, ['BOARDED', 'PENDING']);
  assert.equal(writtenValue.passengerIdsJson, JSON.stringify(identity.passengerIds));
  assert.equal(writtenValue.passengerStatusCodes, 'BP');
  const result = await applyManifestUpdateDirect({ ...identity, tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'], lastUpdated: '2026-08-01T07:00:00Z' }, db);
  assert.equal(written, false);
  assert.equal(result.success, false);
  assert.equal(result.retryable, false);
  const legacy = await applyManifestUpdateDirect({ tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'] }, db);
  assert.equal(written, false);
  assert.equal(legacy.success, false);
  assert.equal(legacy.retryable, false);
});

test('encoded boarding fields are derived from validated current ordering rather than caller strings', async () => {
  let stored;
  const reversed = [...identity.passengerIds].reverse();
  const db = { ref: () => ({ transaction: async updater => { stored = updater(null); return { committed: true, snapshot: { val: () => stored } }; } }) };
  const result = await applyManifestUpdateDirect({ ...identity, passengerIds: reversed,
    passengerIdsJson: 'caller supplied wrong order', passengerStatusCodes: 'caller supplied wrong statuses',
    tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['NO_SHOW', 'PARTIAL'],
  }, db);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(stored.passengerIdsJson), reversed);
  assert.deepEqual(stored.passengerIds, reversed);
  assert.equal(stored.passengerStatusCodes, 'NR');
  assert.deepEqual(Object.fromEntries(JSON.parse(stored.passengerIdsJson).map((id, index) => [id, stored.passengerStatusCodes[index]])), {
    [identity.passengerIds[1]]: 'N', [identity.passengerIds[0]]: 'R',
  });
});

test('same-roster reconciliation trusts encoded statuses over incompatible optional positional arrays', async () => {
  const current = { ...identity, passengerIdsJson: JSON.stringify(identity.passengerIds), passengerStatusCodes: 'NP', passengerStatus: ['BOARDED', 'BOARDED'], status: 'BOARDED', lastUpdated: '2026-08-01T09:00:00Z' };
  const db = { ref: () => ({ transaction: async updater => ({ committed: updater(current) !== undefined, snapshot: { val: () => current } }) }) };
  const result = await applyManifestUpdateDirect({ ...identity, tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'], lastUpdated: '2026-08-01T08:00:00Z' }, db);
  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.passengerStatus, ['NO_SHOW', 'PENDING']);
  assert.deepEqual(result.conflict.serverPassengerStatus, ['NO_SHOW', 'PENDING']);
});

test('an authoritative rules rejection fences an outdated typed roster even when stored history matches it', async () => {
  const result = await applyManifestUpdateDirect({ ...identity, tourCode: scope.tourId, bookingRef: 'ROSTER1', passengerStatuses: ['BOARDED', 'PENDING'] }, denyDb);
  assert.equal(result.success, false);
  assert.equal(result.code, 'ROSTER_REFRESH_REQUIRED');
  assert.equal(result.retryable, false);
});

test('complete 81-passenger party caches intact and an oversized snapshot preserves the last good cache', async () => {
  const values = new Map();
  const cache = createDriverManifestCacheService({ now: () => 1_000, storage: {
    getItemAsync: async key => values.get(key), setItemAsync: async (key, value) => values.set(key, value), deleteItemAsync: async key => values.delete(key),
  } });
  const party = { id: 'PARTY81', passengerNames: Array(81).fill('Party Member'), passengerIds: Array.from({ length: 81 }, (_, index) => `srcpax_v1_${index.toString(16).padStart(64, '0')}`), rosterRevision: 'a'.repeat(64), passengerStatus: Array(81).fill('PENDING') };
  const saved = await cache.replace({ tourId: scope.tourId, driverId: 'D-ROSTER', fetchedAtMs: 900, manifest: { tourId: scope.tourId, complete: true, bookings: [party] } });
  assert.equal(saved.success, true);
  const read = await cache.get({ tourId: scope.tourId, driverId: 'D-ROSTER' });
  assert.equal(read.data.bookings[0].passengerNames.length, 81);
  assert.deepEqual(read.data.bookings[0].passengerIds, party.passengerIds);
  const huge = { tourId: scope.tourId, complete: true, bookings: Array.from({ length: 100 }, (_, index) => ({ id: `LARGE${index}`, passengerNames: Array(100).fill('客'.repeat(180)), passengerStatus: Array(100).fill('PENDING') })) };
  const rejected = await cache.replace({ tourId: scope.tourId, driverId: 'D-ROSTER', fetchedAtMs: 950, manifest: huge });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /snapshot size limit/);
  assert.deepEqual((await cache.get({ tourId: scope.tourId, driverId: 'D-ROSTER' })).data, read.data);
});
