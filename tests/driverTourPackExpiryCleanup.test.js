const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanupExpiredDriverTourPacks,
  buildExpiryTombstone,
} = require('../functions/lib/driverTourPackExpiryCleanup');

function createMockDatabase(initialState) {
  const state = structuredClone(initialState);
  const parts = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((node, part) => node?.[part], state);
  const write = (path, value) => {
    const keys = parts(path);
    let cursor = state;
    keys.slice(0, -1).forEach((key) => {
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    });
    if (value === null) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = structuredClone(value);
  };
  const snapshot = (value) => ({ exists: () => value != null, val: () => structuredClone(value ?? null) });
  return {
    state,
    ref(path = '') {
      let query = { orderBy: null, endAt: Infinity, limit: Infinity };
      const ref = {
        orderByChild(key) { query.orderBy = key; return ref; },
        endAt(value) { query.endAt = value; return ref; },
        limitToFirst(value) { query.limit = value; return ref; },
        async get() {
          const value = read(path);
          if (!query.orderBy || !value || typeof value !== 'object') return snapshot(value);
          const selected = Object.entries(value)
            .filter(([, item]) => Number(item?.[query.orderBy]) <= query.endAt)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, query.limit);
          return snapshot(Object.fromEntries(selected));
        },
        async update(updates) { Object.entries(updates).forEach(([key, value]) => write(key, value)); },
      };
      return ref;
    },
  };
}

test('expiry cleanup removes only expired operational packs/actions and writes a PII-free tombstone', async () => {
  const nowMs = 1_800_000_000_000;
  const expiredKey = '2027-01-01::TOUR_1';
  const liveKey = '2027-01-02::TOUR_2';
  const database = createMockDatabase({
    driver_tour_packs: {
      [expiredKey]: {
        schemaVersion: 1, departureKey: expiredKey, tourId: 'TOUR_1', tourCode: 'TOUR 1', dateISO: '2027-01-01',
        sourceSnapshotDate: '2026-12-31', publishedAtMs: nowMs - 2, quality: { state: 'complete' },
        revision: 4, expiresAtMs: nowMs - 1, passengers: { pax: { name: 'Private name' } },
      },
      [liveKey]: { schemaVersion: 1, departureKey: liveKey, tourId: 'TOUR_2', dateISO: '2027-01-02', revision: 1, expiresAtMs: nowMs + 1 },
    },
    driver_tour_pack_actions: { [expiredKey]: { 'D-1': { issues: { issue_001: { summary: 'Private issue text' } } } } },
    driver_tour_pack_changes: { [expiredKey]: { latest: { revision: 4 } } },
    driver_tour_pack_progress: { [expiredKey]: { 'D-1': { pickupCompleted: 1 } } },
    driver_tour_pack_issues: { issue_001: { issueId: 'issue_001', departureKey: expiredKey, category: 'vehicle' } },
    driver_tour_pack_ingestion: { packMetadata: { [expiredKey]: { contentFingerprint: 'sha256:deadbeef' } } },
    driver_tour_pack_admin_status: { [expiredKey]: { departureKey: expiredKey, status: 'active' } },
  });

  const result = await cleanupExpiredDriverTourPacks({ database, nowMs });
  assert.deepEqual(result, { ok: true, scanned: 1, removed: 1, hasMore: false, cleanedAtMs: nowMs });
  assert.equal(database.state.driver_tour_packs[expiredKey], undefined);
  assert.equal(database.state.driver_tour_pack_actions[expiredKey], undefined);
  assert.equal(database.state.driver_tour_pack_changes[expiredKey], undefined);
  assert.equal(database.state.driver_tour_pack_progress[expiredKey], undefined);
  assert.equal(database.state.driver_tour_pack_issues.issue_001, undefined);
  assert.equal(database.state.driver_tour_pack_ingestion.packMetadata[expiredKey], undefined);
  assert.deepEqual(database.state.driver_tour_pack_admin_status[expiredKey], {
    schemaVersion: 1, departureKey: expiredKey, tourId: 'TOUR_1', tourCode: 'TOUR 1', dateISO: '2027-01-01',
    status: 'expired', qualityState: 'complete', revision: 4, publishedAtMs: nowMs - 2,
    expiresAtMs: nowMs - 1, sourceSnapshotDate: '2026-12-31', purgedAtMs: nowMs,
  });
  assert.deepEqual(database.state.driver_tour_pack_tombstones[expiredKey], {
    schemaVersion: 1, departureKey: expiredKey, tourId: 'TOUR_1', dateISO: '2027-01-01',
    status: 'expired', revision: 4, expiresAtMs: nowMs - 1, purgedAtMs: nowMs, reason: 'RETENTION_EXPIRED',
  });
  assert.ok(database.state.driver_tour_packs[liveKey]);

  const retry = await cleanupExpiredDriverTourPacks({ database, nowMs });
  assert.equal(retry.removed, 0);
});

test('expiry cleanup is bounded and rejects unsafe configuration', async () => {
  const nowMs = 1_800_000_000_000;
  const database = createMockDatabase({ driver_tour_packs: {} });
  await assert.rejects(() => cleanupExpiredDriverTourPacks({ database, nowMs, limit: 51 }), /limit must be 1-50/);
  assert.deepEqual(buildExpiryTombstone({ schemaVersion: 1, departureKey: '2027-01-01::TOUR_1', tourId: 'TOUR_1', dateISO: '2027-01-01', revision: 1, expiresAtMs: nowMs }, nowMs), {
    schemaVersion: 1, departureKey: '2027-01-01::TOUR_1', tourId: 'TOUR_1', dateISO: '2027-01-01',
    status: 'expired', revision: 1, expiresAtMs: nowMs, purgedAtMs: nowMs, reason: 'RETENTION_EXPIRED',
  });
});
