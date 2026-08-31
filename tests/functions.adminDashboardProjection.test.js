'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecentBroadcastProjection,
  buildSafetyAttentionProjection,
  buildTourProjection,
  countManifestBookings,
  hasProhibitedProjectionField,
  measureJsonBytes,
  resolveDashboardRolloutPhase,
} = require('../functions/src/domains/admin-dashboard/dashboardProjection');
const {
  commitCompareSafeProjection,
  commitCompareSafePublicProjection,
  commitConsistentSummaryDomain,
  commitTourProjectionCompletion,
  dashboardDayKey,
  dashboardWindowDayKeys,
  handleBroadcastWrite,
  handleDriverWrite,
  handleSafetyWrite,
  publishDashboardWindowSummary,
  publishStableTourSummary,
  reconcileAggregateContribution,
  refreshDashboardBroadcastWindowSummary,
  recomputeTourProjection,
  tourSummaryShardId,
} = require('../functions/src/domains/admin-dashboard/dashboardProjectionFunctions');
const {
  backfillTourPage,
  cursorHash,
  parseArgs: parseBackfillArgs,
  readKeyPage,
  run: runBackfill,
} = require('../functions/scripts/backfillAdminDashboard');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const makeSnapshot = (value, orderedEntries = Object.entries(value || {})) => ({
  val: () => clone(value),
  exists: () => value !== null && value !== undefined,
  forEach: (callback) => {
    orderedEntries.forEach(([key, childValue]) => callback({ key, val: () => clone(childValue) }));
  },
});

const firebaseKeyCompare = (left, right) => {
  const integer = (value) => (/^(0|[1-9]\d*)$/.test(value) && Number(value) <= 2_147_483_647
    ? Number(value)
    : null);
  const leftInteger = integer(left);
  const rightInteger = integer(right);
  if (leftInteger !== null || rightInteger !== null) {
    if (leftInteger === null) return 1;
    if (rightInteger === null) return -1;
    return leftInteger - rightInteger;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

class FakeDatabase {
  constructor(seed = {}) {
    this.value = clone(seed);
    this.onceInterceptor = null;
  }

  read(path = '') {
    return path.split('/').filter(Boolean).reduce((current, key) => current?.[key], this.value);
  }

  write(path, value) {
    const keys = path.split('/').filter(Boolean);
    if (!keys.length) {
      this.value = clone(value);
      return;
    }
    let current = this.value;
    keys.slice(0, -1).forEach((key) => {
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key];
    });
    const leaf = keys.at(-1);
    if (value === null) delete current[leaf];
    else current[leaf] = clone(value);
  }

  ref(path = '') {
    const db = this;
    const makeRef = (queryOptions = {}) => ({
      once: async () => {
        const raw = db.read(path);
        if ((!queryOptions.orderByChild && !queryOptions.orderByKey) || !raw || typeof raw !== 'object') {
          const plainSnapshot = makeSnapshot(raw);
          return db.onceInterceptor
            ? db.onceInterceptor({ path, queryOptions, snapshot: plainSnapshot })
            : plainSnapshot;
        }
        const orderedValue = (key, value) => (
          queryOptions.orderByChild ? value?.[queryOptions.orderByChild] : key
        );
        const compareValue = (left, right) => {
          if (Number.isFinite(Number(left)) && Number.isFinite(Number(right))) return Number(left) - Number(right);
          return String(left ?? '') < String(right ?? '') ? -1 : String(left ?? '') > String(right ?? '') ? 1 : 0;
        };
        let entries = Object.entries(raw).sort(([leftKey, left], [rightKey, right]) => (
          compareValue(orderedValue(leftKey, left), orderedValue(rightKey, right))
            || firebaseKeyCompare(leftKey, rightKey)
        ));
        if (queryOptions.startAt) entries = entries.filter(([key, value]) => {
          const comparison = compareValue(orderedValue(key, value), queryOptions.startAt.value);
          return comparison > 0 || (comparison === 0
            && (queryOptions.startAt.key === undefined || firebaseKeyCompare(key, queryOptions.startAt.key) >= 0));
        });
        if (queryOptions.startAfter) entries = entries.filter(([key, value]) => {
          const comparison = compareValue(orderedValue(key, value), queryOptions.startAfter.value);
          return comparison > 0 || (comparison === 0
            && queryOptions.startAfter.key !== undefined
            && firebaseKeyCompare(key, queryOptions.startAfter.key) > 0);
        });
        if (queryOptions.endAt !== undefined) {
          entries = entries.filter(([key, value]) => (
            compareValue(orderedValue(key, value), queryOptions.endAt) <= 0
          ));
        }
        if (Number.isSafeInteger(queryOptions.limitToFirst)) entries = entries.slice(0, queryOptions.limitToFirst);
        if (Number.isSafeInteger(queryOptions.limitToLast)) entries = entries.slice(-queryOptions.limitToLast);
        const querySnapshot = makeSnapshot(Object.fromEntries(entries), entries);
        return db.onceInterceptor
          ? db.onceInterceptor({ path, queryOptions, snapshot: querySnapshot })
          : querySnapshot;
      },
      set: async (value) => db.write(path, value),
      update: async (updates) => {
        Object.entries(updates).forEach(([key, value]) => {
          db.write([path, key].filter(Boolean).join('/'), value);
        });
      },
      transaction: async (updater) => {
        const current = clone(db.read(path)) ?? null;
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: makeSnapshot(current) };
        db.write(path, next);
        return { committed: true, snapshot: makeSnapshot(next) };
      },
      orderByChild: (field) => makeRef({ ...queryOptions, orderByChild: field }),
      orderByKey: () => makeRef({ ...queryOptions, orderByKey: true }),
      startAt: (value, key) => makeRef({ ...queryOptions, startAt: { value, key } }),
      startAfter: (value, key) => makeRef({ ...queryOptions, startAfter: { value, key } }),
      endAt: (value) => makeRef({ ...queryOptions, endAt: value }),
      limitToFirst: (value) => makeRef({ ...queryOptions, limitToFirst: value }),
      limitToLast: (value) => makeRef({ ...queryOptions, limitToLast: value }),
    });
    return makeRef();
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
};

test('tour projection preserves every passenger-count fallback without personal fields', () => {
  assert.equal(countManifestBookings({ bookings: {
    a: { passengerStatus: { 0: 'PENDING', 1: 'BOARDED' }, passengerNames: ['ignored'] },
    b: { passengerNames: ['One', 'Two', 'Three'] },
    c: { status: 'PENDING' },
  } }), 6);

  const base = { tourId: 'TOUR_1', tour: { tourCode: '5001D 1', name: 'Tour', maxParticipants: 20 } };
  assert.equal(buildTourProjection({ ...base, tour: { ...base.tour, currentParticipants: 0 }, participantCount: 9, manifestPassengerCount: 7 }).passengerCountSource, 'tour.currentParticipants');
  assert.equal(buildTourProjection({ ...base, participantCount: 9, manifestPassengerCount: 7 }).passengerCountSource, 'tours.participants');
  const manifestRow = buildTourProjection({ ...base, manifestPassengerCount: 7 });
  assert.equal(manifestRow.passengerCountSource, 'tour_manifests.bookings');
  assert.equal(manifestRow.passengerCount, 7);
  assert.equal(hasProhibitedProjectionField(manifestRow), false);
});

test('tour projection assignment includes bounded internal legacy driver contributions', () => {
  const row = buildTourProjection({
    tourId: 'TOUR_1',
    tour: { tourCode: 'TOUR 1', driverName: 'TBA' },
    assignment: { assignedDrivers: { 'D-LEGACY': { name: 'Alice' } } },
    driverProfiles: { 'D-LEGACY': { name: 'Alice' } },
  });
  assert.equal(row.isAssigned, true);
  assert.equal(row.assignedDriverCount, 1);
  assert.equal(row.assignedDriverDisplaySummary, 'Alice');
});

test('safety and broadcast projections strip prohibited canonical fields', () => {
  const safety = buildSafetyAttentionProjection({
    eventId: 'event-1', tourId: 'TOUR_1',
    alert: { status: 'pending', severity: 'critical', message: 'bookingRef=ABC jane@example.com', reporterAuthUid: 'secret', coords: { latitude: 1 } },
  });
  const broadcast = buildRecentBroadcastProjection({
    broadcastId: 'broadcast-1', tourId: 'TOUR_1',
    broadcast: { message: 'token=secret', createdAtMs: 100, createdByUid: 'secret' },
    nowMs: 200,
  });
  assert.equal(hasProhibitedProjectionField(safety), false);
  assert.equal(hasProhibitedProjectionField(broadcast), false);
  assert.doesNotMatch(safety.safeSummary, /ABC|jane@example/);
  assert.doesNotMatch(broadcast.safeSummary, /secret/);
  assert.equal(safety.category, 'safety');
  assert.equal(safety.safeSummary, 'Safety event');
  assert.equal(broadcast.safeSummary, 'Tour broadcast');
  assert.equal(broadcast.source, 'unknown');
  assert.equal(buildSafetyAttentionProjection({ eventId: 'event-1', tourId: 'TOUR_1', alert: { status: 'resolved' } }), null);
});

test('compare-safe tour commit rejects an older event and tombstones deletion', async () => {
  const db = new FakeDatabase();
  const projectionRef = db.ref('admin_dashboard/v1/tours/TOUR_1');
  const newer = { schemaVersion: 1, tourId: 'TOUR_1', displayName: 'New', sourceFingerprint: 'new' };
  await commitCompareSafeProjection({ projectionRef, projection: newer, identity: { tourId: 'TOUR_1' }, order: { sourceEventAtMs: 200, sourceEventId: 'b' } });
  await commitCompareSafeProjection({ projectionRef, projection: { ...newer, displayName: 'Old', sourceFingerprint: 'old' }, identity: { tourId: 'TOUR_1' }, order: { sourceEventAtMs: 100, sourceEventId: 'a' } });
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').displayName, 'New');
  await commitCompareSafeProjection({ projectionRef, projection: null, identity: { tourId: 'TOUR_1' }, order: { sourceEventAtMs: 300, sourceEventId: 'c' } });
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').deleted, true);
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').startAtMs, undefined);
});

test('identical ABA projection advances its event watermark without a semantic revision bump', async () => {
  const db = new FakeDatabase();
  const projectionRef = db.ref('admin_dashboard/v1/tours/TOUR_1');
  const row = { schemaVersion: 1, tourId: 'TOUR_1', displayName: 'A', sourceFingerprint: 'same' };
  await commitCompareSafeProjection({
    projectionRef, projection: row, identity: { tourId: 'TOUR_1' },
    order: { sourceEventAtMs: 100, sourceEventId: 'a' },
  });
  await commitCompareSafeProjection({
    projectionRef, projection: row, identity: { tourId: 'TOUR_1' },
    order: { sourceEventAtMs: 300, sourceEventId: 'c' },
  });
  const current = db.read('admin_dashboard/v1/tours/TOUR_1');
  assert.equal(current.sourceEventAtMs, 300);
  assert.equal(current.sourceEventId, 'c');
  assert.equal(current.projectionRevision, 1);
});

test('public attention deletion removes the row and its private watermark blocks an older restore', async () => {
  const db = new FakeDatabase();
  const projectionRef = db.ref('admin_dashboard/v1/safety_attention/event-1');
  const watermarkRef = db.ref('admin_dashboard/v1/internal/watermarks/safety_attention/event-1');
  const row = { schemaVersion: 1, eventId: 'event-1', sourceFingerprint: 'pending' };
  await commitCompareSafePublicProjection({
    projectionRef, watermarkRef, projection: row,
    order: { sourceEventAtMs: 100, sourceEventId: 'a' }, refreshProjection: async () => row,
  });
  await commitCompareSafePublicProjection({
    projectionRef, watermarkRef, projection: null,
    order: { sourceEventAtMs: 200, sourceEventId: 'b' }, refreshProjection: async () => null,
  });
  await commitCompareSafePublicProjection({
    projectionRef, watermarkRef, projection: row,
    order: { sourceEventAtMs: 150, sourceEventId: 'old' }, refreshProjection: async () => null,
  });
  assert.equal(db.read('admin_dashboard/v1/safety_attention/event-1'), undefined);
  assert.equal(db.read('admin_dashboard/v1/internal/watermarks/safety_attention/event-1').sourceEventAtMs, 200);
});

test('current-state count contribution is retry-safe and out-of-order delete-safe without event pruning', async () => {
  const db = new FakeDatabase();
  let currentCount = 3;
  const reconcile = (owner) => reconcileAggregateContribution({
    db, type: 'manifest', scopeId: 'TOUR_1', memberId: 'PRIVATE-BOOKING', owner, nowMs: 100,
    aggregatePath: 'admin_dashboard/v1/internal/manifest_summaries/TOUR_1',
    loadCurrentContribution: async () => currentCount ? { count: currentCount } : {},
  });
  await reconcile('create');
  await reconcile('retry-after-any-delay');
  assert.equal(db.read('admin_dashboard/v1/internal/manifest_summaries/TOUR_1').count, 3);
  currentCount = 0;
  await reconcile('delete');
  await reconcile('late-create-event-reading-current-state');
  assert.equal(db.read('admin_dashboard/v1/internal/manifest_summaries/TOUR_1').count, 0);
  const contributionRoot = db.read('admin_dashboard/v1/internal/count_contributions/manifest/TOUR_1');
  assert.equal(Object.keys(contributionRoot || {}).some((key) => key.includes('PRIVATE-BOOKING')), false);
});

test('safety updates maintain the global summary and resolving preserves canonical history', async () => {
  const nowMs = Date.now();
  const db = new FakeDatabase({
    tours: { TOUR_1: { safetyAlerts: { EVENT_1: {
      status: 'pending', severity: 'high', timestampMs: nowMs, message: 'Assistance requested',
    } } } },
  });
  const makeEvent = (id, time) => ({
    id,
    time: new Date(time).toISOString(),
    params: { tourId: 'TOUR_1', eventId: 'EVENT_1' },
  });
  await handleSafetyWrite({ db, event: makeEvent('pending', nowMs) });
  assert.equal(db.read('admin_dashboard/v1/summary/safetyAttentionAlerts'), 1);
  assert.equal(db.read('admin_dashboard/v1/safety_attention/EVENT_1').status, 'pending');

  db.write('tours/TOUR_1/safetyAlerts/EVENT_1/status', 'resolved');
  await handleSafetyWrite({ db, event: makeEvent('resolved', nowMs + 1) });
  assert.equal(db.read('admin_dashboard/v1/summary/safetyAttentionAlerts'), 0);
  assert.equal(db.read('admin_dashboard/v1/safety_attention/EVENT_1'), undefined);
  assert.equal(db.read('tours/TOUR_1/safetyAlerts/EVENT_1/status'), 'resolved');
});

test('broadcast updates maintain summary and prune at most twenty expired projection rows', async () => {
  const nowMs = Date.now();
  const expired = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
    `OLD_${index}`,
    { broadcastId: `OLD_${index}`, tourId: 'TOUR_OLD', createdAtMs: nowMs - (31 * 86_400_000) - index },
  ]));
  const db = new FakeDatabase({
    broadcasts: { TOUR_1: { BROADCAST_1: { message: 'Update', createdAtMs: nowMs } } },
    admin_dashboard: { v1: { recent_broadcasts: expired } },
  });
  const instrumentation = {};
  await handleBroadcastWrite({
    db,
    event: {
      id: 'broadcast-event',
      time: new Date(nowMs).toISOString(),
      params: { tourId: 'TOUR_1', broadcastId: 'BROADCAST_1' },
    },
    instrumentation,
  });
  assert.equal(db.read('admin_dashboard/v1/summary/broadcastTotalCount'), 1);
  assert.equal(db.read('admin_dashboard/v1/summary/broadcastTourCount'), 1);
  assert.equal(instrumentation.broadcastPruneQueries, 1);
  assert.equal(Object.keys(db.read('admin_dashboard/v1/recent_broadcasts')).length, 6);
});

test('scheduled broadcast window pages beyond the client cap and ages with the clock', async () => {
  const nowMs = 1_800_000_000_000;
  const recent = Object.fromEntries(Array.from({ length: 251 }, (_, index) => [
    `B_${String(index).padStart(3, '0')}`,
    { createdAtMs: nowMs - (23 * 60 * 60 * 1000) + index },
  ]));
  const db = new FakeDatabase({ admin_dashboard: { v1: { recent_broadcasts: recent } } });
  const instrumentation = {};
  const first = await refreshDashboardBroadcastWindowSummary({ db, nowMs, instrumentation });
  assert.equal(first.broadcastLast24hCount, 251);
  assert.equal(instrumentation.broadcastWindowQueries, 3);
  const aged = await refreshDashboardBroadcastWindowSummary({
    db, nowMs: nowMs + (25 * 60 * 60 * 1000), instrumentation,
  });
  assert.equal(aged.broadcastLast24hCount, 0);
});

test('server-owned day buckets keep upcoming dashboard metrics above the 500-row client cap', async () => {
  const nowMs = 1_800_000_000_000;
  const today = dashboardDayKey(nowMs);
  const db = new FakeDatabase({
    admin_dashboard: { v1: { internal: { tour_day_summaries: {
      [today]: { activeTours: 750, assignedActiveTours: 600 },
    } } } },
  });
  const summary = await publishDashboardWindowSummary({ db, nowMs });
  assert.equal(summary.commitOutcome, 'applied');
  assert.deepEqual(summary.summary, {
    upcomingTours: 750,
    assignedUpcomingTours: 600,
    unassignedUpcomingTours: 150,
    upcomingAssignmentCoveragePercent: 80,
    attentionWindowTours: 750,
  });
  assert.equal(db.read('admin_dashboard/v1/summary/upcomingAssignmentCoveragePercent'), 80);
});

test('empty day summaries roll to a newer midnight generation at source revision zero', async () => {
  const db = new FakeDatabase();
  const beforeMidnight = Date.parse('2026-06-10T22:59:59.999Z');
  const afterMidnight = Date.parse('2026-06-10T23:00:00.000Z');
  const before = await publishDashboardWindowSummary({ db, nowMs: beforeMidnight });
  const after = await publishDashboardWindowSummary({ db, nowMs: afterMidnight });

  assert.equal(before.sourceRevision, 0);
  assert.equal(after.sourceRevision, 0);
  assert.equal(after.commitOutcome, 'applied');
  assert.ok(after.generation.startDayKey > before.generation.startDayKey);
  assert.equal(db.read('admin_dashboard/v1/summary/windowGenerationKey'), after.generation.key);
});

test('an outgoing revision 25 day and incoming revision zero day lower the source sum', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const newNowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const outgoingDay = dashboardWindowDayKeys(oldNowMs)[0];
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [outgoingDay]: { revision: 25, activeTours: 3, assignedActiveTours: 2 },
  } } } } });

  const oldWindow = await publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  const newWindow = await publishDashboardWindowSummary({ db, nowMs: newNowMs });
  assert.equal(oldWindow.sourceRevision, 25);
  assert.equal(newWindow.sourceRevision, 0);
});

test('a newer window generation commits despite a lower revision sum', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const newNowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const outgoingDay = dashboardWindowDayKeys(oldNowMs)[0];
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [outgoingDay]: { revision: 25, activeTours: 3, assignedActiveTours: 2 },
  } } } } });

  const oldWindow = await publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  const newWindow = await publishDashboardWindowSummary({ db, nowMs: newNowMs });
  assert.equal(oldWindow.commitOutcome, 'applied');
  assert.equal(newWindow.commitOutcome, 'applied');
  assert.ok(newWindow.generation.key > oldWindow.generation.key);
  assert.equal(db.read('admin_dashboard/v1/summary/windowSourceRevision'), 0);
  assert.equal(db.read('admin_dashboard/v1/summary/attentionWindowTours'), 0);
});

test('a delayed prior-window worker cannot overwrite or report over a newer generation', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const newNowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const dayPath = 'admin_dashboard/v1/internal/tour_day_summaries';
  const outgoingDay = dashboardWindowDayKeys(oldNowMs)[0];
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [outgoingDay]: { revision: 50, activeTours: 10, assignedActiveTours: 4 },
  } } } } });
  const captured = deferred();
  const release = deferred();
  let delayed = true;
  db.onceInterceptor = async ({ path, snapshot }) => {
    if (path === dayPath && delayed) {
      delayed = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };

  const oldWorker = publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  await captured.promise;
  const newWindow = await publishDashboardWindowSummary({ db, nowMs: newNowMs });
  release.resolve();
  const oldResult = await oldWorker;

  assert.equal(newWindow.commitOutcome, 'applied');
  assert.equal(oldResult.commitOutcome, 'stale');
  assert.deepEqual(oldResult.generation, newWindow.generation);
  assert.equal(oldResult.sourceRevision, 0);
  assert.deepEqual(oldResult.summary, newWindow.summary);
  assert.equal(oldResult.summary.attentionWindowTours, 0);
});

test('several skipped days advance directly to the next scheduled generation', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const resumedNowMs = Date.parse('2026-06-15T12:00:00.000Z');
  const outgoingDay = dashboardWindowDayKeys(oldNowMs)[0];
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [outgoingDay]: { revision: 30, activeTours: 2, assignedActiveTours: 1 },
  } } } } });

  const oldWindow = await publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  const resumedWindow = await publishDashboardWindowSummary({ db, nowMs: resumedNowMs });
  assert.equal(oldWindow.sourceRevision, 30);
  assert.equal(resumedWindow.sourceRevision, 0);
  assert.equal(resumedWindow.commitOutcome, 'applied');
  assert.equal(resumedWindow.generation.startDayKey, '2026-06-08');
  assert.equal(resumedWindow.generation.endDayKey, '2026-06-29');
});

test('March Europe/London DST rollover advances one calendar generation', async () => {
  const db = new FakeDatabase();
  const beforeMidnight = Date.parse('2026-03-28T23:59:59.999Z');
  const afterMidnight = Date.parse('2026-03-29T00:00:00.000Z');
  assert.equal(dashboardDayKey(Date.parse('2026-03-29T00:30:00.000Z')), '2026-03-29');
  assert.equal(dashboardDayKey(Date.parse('2026-03-29T01:30:00.000Z')), '2026-03-29');
  const before = await publishDashboardWindowSummary({ db, nowMs: beforeMidnight });
  const after = await publishDashboardWindowSummary({ db, nowMs: afterMidnight });
  assert.equal(before.generation.startDayKey, '2026-03-21');
  assert.equal(after.generation.startDayKey, '2026-03-22');
  assert.equal(after.generation.endDayKey, '2026-04-12');
  assert.equal(after.commitOutcome, 'applied');
});

test('October Europe/London DST rollover advances one calendar generation', async () => {
  const db = new FakeDatabase();
  const beforeMidnight = Date.parse('2026-10-24T22:59:59.999Z');
  const afterMidnight = Date.parse('2026-10-24T23:00:00.000Z');
  assert.equal(dashboardDayKey(Date.parse('2026-10-25T00:30:00.000Z')), '2026-10-25');
  assert.equal(dashboardDayKey(Date.parse('2026-10-25T01:30:00.000Z')), '2026-10-25');
  const before = await publishDashboardWindowSummary({ db, nowMs: beforeMidnight });
  const after = await publishDashboardWindowSummary({ db, nowMs: afterMidnight });
  assert.equal(before.generation.startDayKey, '2026-10-17');
  assert.equal(after.generation.startDayKey, '2026-10-18');
  assert.equal(after.generation.endDayKey, '2026-11-08');
  assert.equal(after.commitOutcome, 'applied');
});

test('an expired edge-day tour leaves every applicable window count', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const newNowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const outgoingDay = dashboardWindowDayKeys(oldNowMs)[0];
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [outgoingDay]: { revision: 1, activeTours: 2, assignedActiveTours: 1 },
  } } } } });
  const before = await publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  const after = await publishDashboardWindowSummary({ db, nowMs: newNowMs });
  assert.equal(before.summary.attentionWindowTours, 2);
  assert.equal(before.summary.unassignedUpcomingTours, 1);
  assert.equal(after.summary.attentionWindowTours, 0);
  assert.equal(after.summary.unassignedUpcomingTours, 0);
  assert.equal(after.summary.upcomingTours, 0);
  assert.equal(after.summary.assignedUpcomingTours, 0);
});

test('a new future-edge tour enters every appropriate window count', async () => {
  const oldNowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const newNowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const incomingDay = dashboardWindowDayKeys(newNowMs).at(-1);
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [incomingDay]: { revision: 1, activeTours: 2, assignedActiveTours: 1 },
  } } } } });
  const before = await publishDashboardWindowSummary({ db, nowMs: oldNowMs });
  const after = await publishDashboardWindowSummary({ db, nowMs: newNowMs });
  assert.equal(before.summary.attentionWindowTours, 0);
  assert.equal(after.summary.attentionWindowTours, 2);
  assert.equal(after.summary.upcomingTours, 2);
  assert.equal(after.summary.assignedUpcomingTours, 1);
  assert.equal(after.summary.unassignedUpcomingTours, 1);
});

test('window publication performs exactly one bounded day-range query', async () => {
  const nowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const dayKeys = dashboardWindowDayKeys(nowMs);
  const db = new FakeDatabase();
  const instrumentation = {};
  let observedQuery = null;
  db.onceInterceptor = ({ path, queryOptions, snapshot }) => {
    if (path === 'admin_dashboard/v1/internal/tour_day_summaries') observedQuery = queryOptions;
    return snapshot;
  };
  await publishDashboardWindowSummary({ db, nowMs, instrumentation });
  assert.equal(instrumentation.queries, 1);
  assert.equal(instrumentation.directReads || 0, 0);
  assert.equal(observedQuery.orderByKey, true);
  assert.equal(observedQuery.startAt.value, dayKeys[0]);
  assert.equal(observedQuery.endAt, dayKeys.at(-1));
});

test('all-time publication remains one atomic 32-shard parent read with a fixed generation', async () => {
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_summary_shards: {
    '00': { revision: 1, totalTours: 1, operationalTours: 1 },
    '31': { revision: 2, totalTours: 2, operationalTours: 1 },
  } } } } });
  const instrumentation = {};
  const result = await publishStableTourSummary({ db, nowMs: 1, instrumentation });
  assert.equal(instrumentation.directReads, 1);
  assert.equal(instrumentation.queries || 0, 0);
  assert.deepEqual(result.generation, { key: 'all_time_v1' });
  assert.equal(result.sourceRevision, 3);
  assert.equal(result.summary.totalTours, 3);
  assert.equal(db.read('admin_dashboard/v1/summary/tourGenerationKey'), 'all_time_v1');
  assert.equal(db.read('admin_dashboard/v1/summary/tourSourceRevision'), 3);
});

test('stale backfill shard snapshot cannot overwrite a complete live summary regardless of wall clock', async () => {
  const shardPath = 'admin_dashboard/v1/internal/tour_summary_shards';
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_summary_shards: {
    '00': { revision: 1, totalTours: 1, operationalTours: 1, assignedOperationalTours: 1 },
  } } } } });
  const captured = deferred();
  const release = deferred();
  let delayed = true;
  db.onceInterceptor = async ({ path, snapshot }) => {
    if (path === shardPath && delayed) {
      delayed = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const staleInstrumentation = {};
  const staleBackfill = publishStableTourSummary({ db, nowMs: 9_999, instrumentation: staleInstrumentation });
  await captured.promise;
  db.write(`${shardPath}/01`, {
    revision: 1, totalTours: 1, operationalTours: 1, assignedOperationalTours: 0,
  });
  const liveInstrumentation = {};
  await publishStableTourSummary({ db, nowMs: 1, instrumentation: liveInstrumentation });
  release.resolve();
  await staleBackfill;

  const summary = db.read('admin_dashboard/v1/summary');
  assert.equal(summary.totalTours, 2);
  assert.equal(summary.tourRevision, 2);
  assert.equal(summary.tourSourceRevision, 2);
  assert.equal(summary.tourGenerationKey, 'all_time_v1');
  assert.equal(summary.tourUpdatedAtMs, 1);
  assert.equal(staleInstrumentation.directReads, 1);
  assert.equal(liveInstrumentation.directReads, 1);
});

test('two stable-summary workers in the same millisecond retain the complete shard snapshot', async () => {
  const shardPath = 'admin_dashboard/v1/internal/tour_summary_shards';
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_summary_shards: {
    '00': { revision: 1, totalTours: 1, operationalTours: 1 },
  } } } } });
  const captured = deferred();
  const release = deferred();
  let delayed = true;
  db.onceInterceptor = async ({ path, snapshot }) => {
    if (path === shardPath && delayed) {
      delayed = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const workerA = publishStableTourSummary({ db, nowMs: 123 });
  await captured.promise;
  db.write(`${shardPath}/17`, { revision: 1, totalTours: 1, operationalTours: 1 });
  await publishStableTourSummary({ db, nowMs: 123 });
  release.resolve();
  await workerA;
  assert.equal(db.read('admin_dashboard/v1/summary/totalTours'), 2);
  assert.equal(db.read('admin_dashboard/v1/summary/tourRevision'), 2);
});

test('real backfill and live trigger overlap cannot regress the all-time summary', async () => {
  const backfillTourId = 'BACKFILL_TOUR';
  const liveTourId = Array.from({ length: 100 }, (_, index) => `LIVE_TOUR_${index}`)
    .find((tourId) => tourSummaryShardId(tourId) !== tourSummaryShardId(backfillTourId));
  const nowMs = 1_800_000_000_000;
  const shardPath = 'admin_dashboard/v1/internal/tour_summary_shards';
  const db = new FakeDatabase({ tours: {
    [backfillTourId]: {
      tourCode: 'BACKFILL', name: 'Backfill Tour', startDateEpochMs: nowMs, currentParticipants: 2,
    },
    [liveTourId]: {
      tourCode: 'LIVE', name: 'Live Tour', startDateEpochMs: nowMs, currentParticipants: 3,
    },
  } });
  const captured = deferred();
  const release = deferred();
  let delayed = true;
  db.onceInterceptor = async ({ path, snapshot }) => {
    if (path === shardPath && delayed) {
      delayed = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const backfill = backfillTourPage({
    db,
    entries: [[backfillTourId, {}]],
    options: { apply: true, memberPageSize: 10, concurrency: 1 },
    nowMs,
  });
  await captured.promise;
  await recomputeTourProjection({
    db,
    tourId: liveTourId,
    order: { sourceEventAtMs: nowMs, sourceEventId: 'live-trigger' },
  });
  release.resolve();
  await backfill;
  assert.equal(db.read('admin_dashboard/v1/summary/totalTours'), 2);
  assert.equal(db.read('admin_dashboard/v1/summary/totalPassengers'), 5);
  assert.equal(db.read('admin_dashboard/v1/summary/tourRevision'), 2);
});

test('concurrent day-bucket changes cannot regress the bounded window summary', async () => {
  const nowMs = 1_800_000_000_000;
  const dayKeys = dashboardWindowDayKeys(nowMs);
  const today = dayKeys[7];
  const tomorrow = dayKeys[8];
  const dayPath = 'admin_dashboard/v1/internal/tour_day_summaries';
  const db = new FakeDatabase({ admin_dashboard: { v1: { internal: { tour_day_summaries: {
    [today]: { revision: 1, activeTours: 1, assignedActiveTours: 1 },
  } } } } });
  const captured = deferred();
  const release = deferred();
  let delayed = true;
  db.onceInterceptor = async ({ path, snapshot }) => {
    if (path === dayPath && delayed) {
      delayed = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const staleInstrumentation = {};
  const workerA = publishDashboardWindowSummary({ db, nowMs, instrumentation: staleInstrumentation });
  await captured.promise;
  db.write(`${dayPath}/${tomorrow}`, { revision: 1, activeTours: 2, assignedActiveTours: 1 });
  const liveInstrumentation = {};
  await publishDashboardWindowSummary({ db, nowMs, instrumentation: liveInstrumentation });
  release.resolve();
  await workerA;

  const summary = db.read('admin_dashboard/v1/summary');
  assert.equal(summary.upcomingTours, 3);
  assert.equal(summary.attentionWindowTours, 3);
  assert.equal(summary.windowRevision, 2);
  assert.equal(summary.windowSourceRevision, 2);
  assert.equal(staleInstrumentation.queries, 1);
  assert.equal(liveInstrumentation.queries, 1);
  assert.equal(staleInstrumentation.directReads || 0, 0);
});

test('completion markers reject stale revisions and make exact duplicates no-ops', async () => {
  const db = new FakeDatabase();
  const first = await commitTourProjectionCompletion({
    db, tourId: 'TOUR_1', projectionRevision: 2, sourceFingerprint: 'new', completedAtMs: 10,
  });
  assert.equal(first.outcome, 'applied');
  const stale = await commitTourProjectionCompletion({
    db, tourId: 'TOUR_1', projectionRevision: 1, sourceFingerprint: 'old', completedAtMs: 99,
  });
  assert.equal(stale.outcome, 'stale');
  const duplicate = await commitTourProjectionCompletion({
    db, tourId: 'TOUR_1', projectionRevision: 2, sourceFingerprint: 'new', completedAtMs: 99,
  });
  assert.equal(duplicate.outcome, 'idempotent');
  assert.deepEqual(db.read('admin_dashboard/v1/internal/tour_projection_completion/TOUR_1'), {
    schemaVersion: 1,
    projectionRevision: 2,
    sourceFingerprint: 'new',
    completedAtMs: 10,
  });
  await assert.rejects(() => commitTourProjectionCompletion({
    db, tourId: 'TOUR_1', projectionRevision: 2, sourceFingerprint: 'conflict', completedAtMs: 100,
  }), (error) => error?.code === 'DASHBOARD_COMPLETION_INCONSISTENT');
});

test('summary commits accept exact duplicates and fail closed on equal-revision fingerprint conflicts', async () => {
  const db = new FakeDatabase();
  const first = await commitConsistentSummaryDomain({
    db, domain: 'tour', generationKey: 'all_time_v1', sourceRevision: 5,
    sourceFingerprint: 'same', fields: { totalTours: 5 }, nowMs: 10,
  });
  assert.equal(first.outcome, 'applied');
  const duplicate = await commitConsistentSummaryDomain({
    db, domain: 'tour', generationKey: 'all_time_v1', sourceRevision: 5,
    sourceFingerprint: 'same', fields: { totalTours: 5 }, nowMs: 99,
  });
  assert.equal(duplicate.outcome, 'idempotent');
  assert.equal(db.read('admin_dashboard/v1/summary/tourUpdatedAtMs'), 10);
  await assert.rejects(() => commitConsistentSummaryDomain({
    db, domain: 'tour', generationKey: 'all_time_v1', sourceRevision: 5,
    sourceFingerprint: 'different', fields: { totalTours: 4 }, nowMs: 100,
  }), (error) => error?.code === 'DASHBOARD_SUMMARY_INCONSISTENT');
  assert.equal(db.read('admin_dashboard/v1/summary/totalTours'), 5);
});

test('driver move recomputes only symmetric-difference tours when legacy assignments are unchanged', async () => {
  const nowMs = Date.now();
  const assignments = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`LEGACY_${index}`, true]));
  const before = { name: 'Driver', currentTourId: 'OLD_TOUR', assignments };
  const after = { name: 'Driver', currentTourId: 'NEW_TOUR', assignments };
  const db = new FakeDatabase({
    drivers: { DRIVER_1: after },
    admin_dashboard: { v1: { internal: { driver_assignment_state: { DRIVER_1: {
      schemaVersion: 1,
      name: 'Driver',
      tourIds: Object.fromEntries(['OLD_TOUR', ...Object.keys(assignments)].map((tourId) => [tourId, true])),
      updatedAtMs: nowMs - 1,
    } } } } },
  });
  const instrumentation = {};
  await handleDriverWrite({
    db,
    event: {
      id: 'driver-move',
      time: new Date(nowMs).toISOString(),
      params: { driverId: 'DRIVER_1' },
      data: { before: makeSnapshot(before), after: makeSnapshot(after) },
    },
    instrumentation,
  });
  assert.equal(instrumentation.toursRecomputed, 2);
  assert.equal(db.read('admin_dashboard/v1/internal/driver_tour_assignments/OLD_TOUR/DRIVER_1'), undefined);
  assert.equal(db.read('admin_dashboard/v1/internal/driver_tour_assignments/NEW_TOUR/DRIVER_1').name, 'Driver');
});

test('tour recomputation has fixed reads independent of unrelated history and uses legacy assignment index', async () => {
  const unrelated = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [`booking-${index}`, { passengerStatus: { 0: 'PENDING' } }]));
  const db = new FakeDatabase({
    tours: { TOUR_1: { tourCode: 'TOUR 1', name: 'Tour', startDateEpochMs: 1000, maxParticipants: 50 } },
    tour_manifests: { TOUR_1: { bookings: unrelated, assigned_drivers: {} } },
    drivers: { 'D-ONE': { name: 'Alice' } },
    admin_dashboard: { v1: { internal: {
      manifest_summaries: { TOUR_1: { count: 50_000 } },
      participant_summaries: { TOUR_1: { count: 0 } },
      driver_tour_assignments: { TOUR_1: { 'D-ONE': { name: 'Alice' } } },
    } } },
  });
  const instrumentation = {};
  await recomputeTourProjection({ db, tourId: 'TOUR_1', order: { sourceEventAtMs: 10, sourceEventId: 'event' }, instrumentation });
  assert.equal(instrumentation.toursRecomputed, 1);
  assert.equal(instrumentation.directReads, 20);
  assert.equal(instrumentation.queries, 1);
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').passengerCount, 50_000);
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').isAssigned, true);
  assert.equal(db.read('admin_dashboard/v1/summary').totalTours, 1);
  assert.equal(db.read('admin_dashboard/v1/summary').totalPassengers, 50_000);
  assert.ok(measureJsonBytes(db.read('admin_dashboard/v1/tours/TOUR_1')) < 2_000);
  const firstReadCount = instrumentation.directReads;
  await recomputeTourProjection({
    db,
    tourId: 'TOUR_1',
    order: { sourceEventAtMs: 11, sourceEventId: 'duplicate-child-trigger' },
    instrumentation,
  });
  assert.equal(instrumentation.directReads - firstReadCount, 16);
  assert.equal(instrumentation.tourAggregateRecomputationsSkipped, 1);
  db.write('tours/TOUR_1', null);
  await recomputeTourProjection({
    db,
    tourId: 'TOUR_1',
    order: { sourceEventAtMs: 20, sourceEventId: 'delete-event' },
  });
  assert.equal(db.read('admin_dashboard/v1/tours/TOUR_1').deleted, true);
  assert.equal(db.read('admin_dashboard/v1/summary').totalTours, 0);
});

test('dashboard rollout is compatibility safe', () => {
  assert.equal(resolveDashboardRolloutPhase(null), 'legacy');
  assert.equal(resolveDashboardRolloutPhase({ schemaVersion: 1, phase: 'unknown' }), 'legacy');
  assert.equal(resolveDashboardRolloutPhase({ schemaVersion: 1, phase: 'shadow' }), 'shadow');
  assert.equal(resolveDashboardRolloutPhase({ schemaVersion: 1, phase: 'projection' }), 'projection');
});

test('dashboard backfill is dry-run first, clamped, resumable and project guarded', async () => {
  assert.deepEqual(parseBackfillArgs([]), {
    apply: false,
    restart: false,
    confirmProject: '',
    afterTour: '',
    pageSize: 25,
    memberPageSize: 250,
    concurrency: 5,
  });
  const clamped = parseBackfillArgs(['--apply', '--page-size=9999', '--member-page-size=9999', '--concurrency=9999']);
  assert.equal(clamped.apply, true);
  assert.equal(clamped.pageSize, 100);
  assert.equal(clamped.memberPageSize, 500);
  assert.equal(clamped.concurrency, 10);
  await assert.rejects(() => runBackfill({
    admin: { app: () => ({ options: { projectId: 'expected-project' } }) },
    options: clamped,
  }), /--confirm-project=expected-project/);
  await assert.rejects(() => runBackfill({
    admin: {
      app: () => ({ options: { projectId: 'expected-project' } }),
      database: () => new FakeDatabase(),
    },
    options: parseBackfillArgs([
      '--apply', '--confirm-project=expected-project', '--after-tour=A',
    ]),
  }), /cursor override.*--restart/);

  const db = new FakeDatabase({ tours: { A: {}, B: {}, C: {} } });
  const firstPage = await readKeyPage({ sourceRef: db.ref('tours'), afterKey: '', pageSize: 2 });
  const secondPage = await readKeyPage({ sourceRef: db.ref('tours'), afterKey: firstPage.nextCursor, pageSize: 2 });
  assert.deepEqual(firstPage.entries.map(([key]) => key), ['A', 'B']);
  assert.equal(firstPage.nextCursor, 'B');
  assert.deepEqual(secondPage.entries.map(([key]) => key), ['C']);
  assert.equal(secondPage.nextCursor, null);
  assert.match(cursorHash('B'), /^[a-f0-9]{16}$/);
});

test('bounded concurrent backfill keeps sharded tour summaries correct', async () => {
  const nowMs = Date.now();
  const db = new FakeDatabase({
    tours: {
      A: { tourCode: 'A', name: 'Tour A', startDateEpochMs: nowMs, currentParticipants: 2 },
      B: { tourCode: 'B', name: 'Tour B', startDateEpochMs: nowMs, currentParticipants: 3 },
    },
  });
  const summary = await backfillTourPage({
    db,
    entries: [['A', {}], ['B', {}]],
    options: { apply: true, memberPageSize: 10, concurrency: 2 },
    nowMs,
  });
  assert.equal(summary.tours, 2);
  assert.equal(db.read('admin_dashboard/v1/summary/totalTours'), 2);
  assert.equal(db.read('admin_dashboard/v1/summary/totalPassengers'), 5);
});
