'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCoachTrackingRow,
  buildSafeDriverLocation,
} = require('../functions/src/domains/admin-dashboard/coachTrackingProjection');
const { validateApplyTarget } = require('../functions/scripts/backfillCoachTracking');
const {
  readAssignedDrivers,
  readExistingCoachTrackingPage,
  readLocationPage,
  reconcileCoachTrackingTour,
  runCoachTrackingBackfill,
} = require('../functions/src/domains/admin-dashboard/coachTrackingFunctions');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class FakeDatabase {
  constructor(value = {}) { this.value = clone(value); this.readInterceptor = null; }

  read(path) {
    return path.split('/').filter(Boolean).reduce((current, key) => current?.[key], this.value);
  }

  write(path, value) {
    const keys = path.split('/').filter(Boolean);
    let current = this.value;
    for (const key of keys.slice(0, -1)) {
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key];
    }
    const last = keys.at(-1);
    if (value === null) delete current[last];
    else current[last] = clone(value);
  }

  ref(path) {
    const db = this;
    const query = { field: null, orderByKey: false, value: undefined, start: null, end: null, startAfter: null, limit: Infinity };
    const childValue = (row, field) => String(field || '').split('/').filter(Boolean)
      .reduce((current, key) => current?.[key], row);
    const compareValue = (left, right) => {
      if (left === right) return 0;
      if (left === null || left === undefined) return -1;
      if (right === null || right === undefined) return 1;
      if (typeof left === 'number' && typeof right === 'number') return left - right;
      if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
      return String(left).localeCompare(String(right));
    };
    const comparePair = (aValue, aKey, bValue, bKey) => compareValue(aValue, bValue) || String(aKey).localeCompare(String(bKey));
    const ref = {
      orderByChild(field) { query.field = field; query.orderByKey = false; return ref; },
      orderByKey() { query.orderByKey = true; query.field = null; return ref; },
      equalTo(value) { query.value = value; return ref; },
      startAt(value, key) {
        assert.equal(arguments.length >= 2 && key === '', false, 'RTDB startAt does not accept an explicit empty key');
        query.start = { value, key: key ?? '' };
        return ref;
      },
      endAt(value, key = null) { query.end = { value, key }; return ref; },
      startAfter(key) { query.startAfter = key; return ref; },
      limitToFirst(value) { query.limit = value; return ref; },
      once: async () => {
        const value = db.read(path);
        const valueFor = ([key, row]) => query.orderByKey ? key : childValue(row, query.field);
        let entries = Object.entries(value || {});
        if (query.value !== undefined) entries = entries.filter((entry) => compareValue(valueFor(entry), query.value) === 0);
        entries.sort((left, right) => comparePair(valueFor(left), left[0], valueFor(right), right[0]));
        if (query.startAfter !== null) entries = entries.filter(([key]) => key.localeCompare(query.startAfter) > 0);
        if (query.start) entries = entries.filter((entry) => comparePair(valueFor(entry), entry[0], query.start.value, query.start.key) >= 0);
        if (query.end) entries = entries.filter((entry) => query.end.key === null
          ? compareValue(valueFor(entry), query.end.value) <= 0
          : comparePair(valueFor(entry), entry[0], query.end.value, query.end.key) <= 0);
        const ordered = entries.slice(0, query.limit).map(([key, row]) => [key, clone(row)]);
        if (db.readInterceptor) await db.readInterceptor({ path, query, value });
        return {
          val: () => Object.fromEntries(ordered),
          forEach: (callback) => ordered.forEach(([key, row]) => callback({ key, val: () => clone(row) })),
        };
      },
      set: async (value) => db.write(path, value),
      remove: async () => db.write(path, null),
      transaction: async (update) => {
        const next = update(clone(db.read(path)) ?? null);
        if (next !== undefined) db.write(path, next);
        return { committed: next !== undefined, snapshot: { val: () => clone(db.read(path)) } };
      },
    };
    return ref;
  }
}

test('coach tracking row exposes only whitelisted location and assignment fields', () => {
  const row = buildCoachTrackingRow({
    tourId: 'TOUR_1',
    tour: {
      tourCode: 'TOUR 1', name: 'Highlands', startDateEpochMs: 100, endDateEpochMs: 200,
      isActive: true,
      driverLocation: {
        schemaVersion: 1, isSharing: true, mode: 'live', source: 'auto', latitude: 55.9, longitude: -4.2,
        timestamp: 150, accuracy: 8, authUid: 'private-uid', appSessionId: 'private-session', phone: 'private-phone',
        updatedBy: 'Driver person 1234567890',
        fallbackPickup: { schemaVersion: 1, isSharing: true, mode: 'pickup', source: 'manual', latitude: 55.8, longitude: -4.1, timestamp: 140, driverId: 'private-driver' },
      },
      participants: { passenger: { name: 'Private passenger' } },
    },
    assignedDrivers: [{ driverId: 'D-1', name: 'Driver One', phone: 'private-phone' }],
    nowMs: 500,
  });
  assert.deepEqual(row.location, {
    schemaVersion: 1, isSharing: true, mode: 'live', source: 'auto', latitude: 55.9, longitude: -4.2,
    timestamp: 150, accuracy: 8,
    fallbackPickup: { schemaVersion: 1, isSharing: true, mode: 'pickup', source: 'manual', latitude: 55.8, longitude: -4.1, timestamp: 140 },
  });
  assert.deepEqual(row.assignedDrivers, [{ driverId: 'D-1', name: 'Driver One' }]);
  assert.equal(row.assignmentOverflow, false);
  assert.equal(row.startAtMs, 100);
  assert.equal(row.endAtMs, 200);
  assert.equal(Object.hasOwn(row, 'participants'), false);
  assert.equal(JSON.stringify(row).includes('private-uid'), false);
  assert.equal(JSON.stringify(row).includes('private-phone'), false);
  assert.equal(JSON.stringify(row).includes('Driver person'), false);
});

test('unsafe or withdrawn public locations are omitted', () => {
  assert.equal(buildSafeDriverLocation({ isSharing: true, mode: 'live', source: 'auto', latitude: 56,
    longitude: -4, timestamp: Date.now(), accuracy: 50_001 }).accuracy, 50_001);
  assert.equal(buildSafeDriverLocation({ isSharing: false, latitude: 55, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: 91, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: null, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: false, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: '', longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: 55, longitude: -4, timestamp: null }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: 55, longitude: -4, timestamp: 0 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: 55, longitude: -4, timestamp: false }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: null, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: false, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: true, latitude: 55, longitude: -4, timestamp: '' }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: null, latitude: 55, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ isSharing: 'false', latitude: 55, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ schemaVersion: 2, isSharing: true, latitude: 55, longitude: -4, timestamp: 1 }), null);
  assert.equal(buildSafeDriverLocation({ mode: 'mystery', latitude: 55, longitude: -4, timestamp: 1 }), null);
  const row = buildCoachTrackingRow({ tourId: 'T1', tour: { driverLocation: { isSharing: false } } });
  assert.equal(row, null);
  assert.equal(buildSafeDriverLocation({
    isSharing: true, latitude: 55, longitude: -4, timestamp: '2026-10-09T10:00:00Z',
  }).timestamp, Date.parse('2026-10-09T10:00:00Z'));
  const legacy = buildSafeDriverLocation({ latitude: 55, longitude: -4, timestamp: '2026-10-09T10:00:00Z' });
  assert.equal(legacy.isSharing, true);
  const noDates = buildCoachTrackingRow({ tourId: 'T2', tour: {
    name: 'Tour', startDateEpochMs: null, endDateEpochMs: '', driverLocation: {
      isSharing: true, latitude: 0, longitude: 0, timestamp: 1,
    },
  } });
  assert.equal(noDates.startAtMs, null);
  assert.equal(noDates.endAtMs, null);
});

test('location candidate pagination preserves numeric and ISO timestamp tie cursors', async () => {
  const tours = {
    A: { driverLocation: { timestamp: 10 } },
    B: { driverLocation: { timestamp: 10 } },
    C: { driverLocation: { timestamp: '2026-10-09T10:00:00Z' } },
    D: { driverLocation: { timestamp: '2026-10-09T10:00:00Z' } },
  };
  const db = new FakeDatabase({ tours });
  const first = await readLocationPage({ db, pageSize: 2, cursor: null });
  assert.deepEqual(first.tourIds, ['A', 'B']);
  assert.deepEqual(first.nextCursor, { key: 'B', value: 10 });
  const second = await readLocationPage({ db, pageSize: 2, cursor: first.nextCursor });
  assert.deepEqual(second.tourIds, ['C', 'D']);
  assert.equal(second.hasMore, false);
});

test('assigned driver query is indexed, bounded to sentinel, and marks overflow', async () => {
  const drivers = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`D-${String(index).padStart(3, '0')}`, {
    name: `Driver ${index}`, currentTourId: 'T1', phone: 'not projected',
  }]));
  let observedLimit;
  const query = {
    orderByChild(field) { assert.equal(field, 'currentTourId'); return this; },
    equalTo(value) { assert.equal(value, 'T1'); return this; },
    limitToFirst(value) { observedLimit = value; return this; },
    once: async () => ({ val: () => drivers }),
  };
  const result = await readAssignedDrivers({ ref: (path) => { assert.equal(path, 'drivers'); return query; } }, 'T1');
  assert.equal(observedLimit, 101);
  assert.equal(result.assignedDrivers.length, 100);
  assert.equal(result.assignmentOverflow, true);
  assert.equal(Object.hasOwn(result.assignedDrivers[0], 'phone'), false);
});

test('reconciliation rereads current source and removes a tour after assignment and location end', async () => {
  const db = new FakeDatabase({
    tours: { T1: {
      tourCode: 'T1', name: 'Tour', startDateEpochMs: 100, endDateEpochMs: 200, isActive: true,
      driverLocation: { isSharing: true, mode: 'pickup', source: 'manual', latitude: 55, longitude: -4, timestamp: 10 },
      participants: { passenger: { name: 'must stay private' } },
    } },
    drivers: { 'D-1': { currentTourId: 'T1', name: 'Driver', phone: 'must stay private' } },
  });
  await reconcileCoachTrackingTour({ db, tourId: 'T1' });
  const row = db.read('admin_dashboard/v1/coach_tracking/T1');
  assert.equal(row.assignedDrivers[0].driverId, 'D-1');
  assert.equal(row.listed, true);
  assert.equal(row.location.latitude, 55);
  assert.equal(JSON.stringify(row).includes('must stay private'), false);

  db.write('drivers/D-1/currentTourId', 'T2');
  db.write('tours/T1/driverLocation', { isSharing: false, timestamp: 30 });
  await reconcileCoachTrackingTour({ db, tourId: 'T1' });
  const tombstone = db.read('admin_dashboard/v1/coach_tracking/T1');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.listed, false);
});

test('existing-row backfill uses listed index and ordered composite cursors across many same-value rows', async () => {
  const rows = Object.fromEntries(Array.from({ length: 503 }, (_, index) => [
    index === 502 ? '🚍unicode' : `T${String(index).padStart(3, '0')}`,
    { listed: true, tourId: 'untrusted' },
  ]));
  const db = new FakeDatabase({ admin_dashboard: { v1: { coach_tracking: rows } } });
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await readExistingCoachTrackingPage({ db, pageSize: 37, cursor });
    pages += 1;
    ids.push(...page.tourIds);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (pages < 30);
  assert.equal(ids.length, 503);
  assert.equal(new Set(ids).size, 503);
  assert.equal(ids.includes('🚍unicode'), true);
  assert.equal(pages, 14);
});

test('existing-row pagination advances when the boundary row is deleted between pages', async () => {
  const db = new FakeDatabase({ admin_dashboard: { v1: { coach_tracking: {
    A: { listed: true }, B: { listed: true }, C: { listed: true },
  } } } });
  db.readInterceptor = async ({ path }) => {
    if (path === 'admin_dashboard/v1/coach_tracking') {
      db.readInterceptor = null;
      db.write('admin_dashboard/v1/coach_tracking/A', null);
    }
  };
  const first = await readExistingCoachTrackingPage({ db, pageSize: 1, cursor: null });
  const second = await readExistingCoachTrackingPage({ db, pageSize: 1, cursor: first.nextCursor });
  assert.deepEqual(first.tourIds, ['A']);
  assert.deepEqual(second.tourIds, ['B']);
});

test('coach tracking dry run is bounded and never marks readiness', async () => {
  const db = new FakeDatabase({
    drivers: { D1: { currentTourId: 'T1' } },
    tours: { T1: { name: 'Tour', driverLocation: { isSharing: true, latitude: 55, longitude: -4, timestamp: 1 } } },
  });
  const result = await runCoachTrackingBackfill({ db, dryRun: true, pageSize: 1, maxPages: 1, runId: 'dry-run' });
  assert.equal(result.applied, false);
  assert.equal(result.complete, false);
  assert.equal(db.read('admin_dashboard/v1/coach_tracking_status'), undefined);
  assert.equal(db.read('admin_dashboard/v1/coach_tracking/T1'), undefined);
});

test('backfill apply guard verifies the precise database instance and rejects emulator targets', () => {
  const target = {
    confirmProject: 'loch-lomond-travel',
    projectId: 'loch-lomond-travel',
    databaseUrl: 'https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app/',
    emulatorHost: '',
  };
  assert.doesNotThrow(() => validateApplyTarget(target));
  assert.throws(() => validateApplyTarget({ ...target, databaseUrl: 'https://other-default-rtdb.europe-west1.firebasedatabase.app' }), /exact/);
  assert.throws(() => validateApplyTarget({ ...target, emulatorHost: '127.0.0.1:9000' }), /emulator/i);
});

test('an expired delayed reconciliation cannot overwrite a newer location generation', async () => {
  const db = new FakeDatabase({
    tours: { T1: { name: 'Tour', driverLocation: { isSharing: true, latitude: 55, longitude: -4, timestamp: 1 } } },
    drivers: {},
  });
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  let releaseRead;
  let reachedDelayedRead;
  const blocked = new Promise((resolve) => { reachedDelayedRead = resolve; });
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let delayOnce = true;
  db.readInterceptor = async ({ path }) => {
    if (path === 'tours/T1/name' && delayOnce) {
      delayOnce = false;
      reachedDelayedRead();
      await gate;
    }
  };
  try {
    const stale = reconcileCoachTrackingTour({ db, tourId: 'T1' });
    await blocked;
    now += 6 * 60_000;
    db.write('tours/T1/driverLocation', { isSharing: true, latitude: 56, longitude: -3, timestamp: 2 });
    await reconcileCoachTrackingTour({ db, tourId: 'T1' });
    releaseRead();
    await assert.rejects(stale, { code: 'COACH_TRACKING_RESERVATION_LOST' });
    assert.equal(db.read('admin_dashboard/v1/coach_tracking/T1').location.latitude, 56);
    assert.equal(db.read('admin_dashboard/v1/coach_tracking/T1').projectionRevision, 2);
  } finally {
    releaseRead?.();
    Date.now = originalNow;
  }
});
