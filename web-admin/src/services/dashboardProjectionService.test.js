import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  endAt: vi.fn((value) => ({ type: 'endAt', value })),
  get: vi.fn(),
  limitToFirst: vi.fn((value) => ({ type: 'limitToFirst', value })),
  limitToLast: vi.fn((value) => ({ type: 'limitToLast', value })),
  onValue: vi.fn(),
  orderByChild: vi.fn((field) => ({ type: 'orderByChild', field })),
  query: vi.fn((baseRef, ...constraints) => ({ baseRef, constraints })),
  ref: vi.fn((_database, path) => ({ path })),
  startAt: vi.fn((value) => ({ type: 'startAt', value })),
}));

vi.mock('firebase/database', () => firebaseMocks);

import {
  DASHBOARD_BROADCAST_LIMIT,
  DASHBOARD_SAFETY_LIMIT,
  DASHBOARD_TOUR_LIMIT,
  compareDashboardProjectionSections,
  compareDashboardProjectionRows,
  fetchDashboardProjection,
  getDashboardProjectionQueryPlan,
  resolveDashboardRolloutPhase,
  subscribeToDashboardProjection,
  subscribeToDashboardRollout,
} from './dashboardProjectionService';

const snapshot = (value) => ({
  val: () => value,
  size: value && typeof value === 'object' ? Object.keys(value).length : 0,
});

const executeInMemoryPlan = (records, plan) => {
  let entries = Object.entries(records).filter(([, row]) => {
    const value = Number(row?.[plan.orderByChild]);
    return (!Number.isFinite(plan.startAt) || value >= plan.startAt)
      && (!Number.isFinite(plan.endAt) || value <= plan.endAt);
  }).sort(([leftId, left], [rightId, right]) => (
    Number(left?.[plan.orderByChild] || 0) - Number(right?.[plan.orderByChild] || 0)
    || leftId.localeCompare(rightId)
  ));
  if (Number.isSafeInteger(plan.limitToFirst)) entries = entries.slice(0, plan.limitToFirst);
  if (Number.isSafeInteger(plan.limitToLast)) entries = entries.slice(-plan.limitToLast);
  return Object.fromEntries(entries);
};

const shadowFixture = () => ({
  legacyModel: {
    tourRows: [{
      id: 'TOUR_1', name: 'Tour', tourCode: 'T1', startAtMs: 1_000,
      isAssigned: true, passengerCount: 10,
    }],
    safetyAlerts: [{
      id: 'tour:EVENT_1', eventId: 'EVENT_1', tourId: 'TOUR_1', status: 'pending',
      severity: 'high', requiresAttention: true, timestampMs: 900,
    }],
    metrics: { totalDrivers: 2, assignedDrivers: 1, totalTours: 1, safetyAttentionAlerts: 1 },
    broadcastActivity: { totalCount: 1, last24hCount: 1, tourCount: 1 },
  },
  projectionModel: {
    safetyAlerts: [{
      id: 'projection:EVENT_1', eventId: 'EVENT_1', tourId: 'TOUR_1', status: 'pending',
      severity: 'high', requiresAttention: true, timestampMs: 900,
    }],
    metrics: { totalDrivers: 2, assignedDrivers: 1, totalTours: 1, safetyAttentionAlerts: 1 },
    broadcastActivity: { totalCount: 1, last24hCount: 1, tourCount: 1 },
  },
  projectionTours: {
    TOUR_1: { displayName: 'Tour', tourCode: 'T1', startAtMs: 1_000, isAssigned: true, passengerCount: 10 },
  },
  legacyBroadcasts: {
    TOUR_1: { BROADCAST_1: { deliveryStatus: 'delivered', createdAtMs: 900, recipientCount: 3 } },
  },
  projectionBroadcasts: {
    BROADCAST_1: {
      broadcastId: 'BROADCAST_1', tourId: 'TOUR_1', deliveryStatus: 'delivered',
      createdAtMs: 900, recipientCount: 3,
    },
  },
  options: { nowMs: 1_000 },
});

describe('dashboardProjectionService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds hard-bounded indexed query plans for the visible operating window', () => {
    const nowMs = Date.UTC(2026, 4, 28);
    const plan = getDashboardProjectionQueryPlan({
      nowMs,
      tourLimit: 50_000,
      safetyLimit: 50_000,
      broadcastLimit: 50_000,
    });
    const expectedStart = new Date(nowMs);
    expectedStart.setHours(0, 0, 0, 0);
    expectedStart.setDate(expectedStart.getDate() - 7);
    const expectedEnd = new Date(nowMs);
    expectedEnd.setHours(23, 59, 59, 999);
    expectedEnd.setDate(expectedEnd.getDate() + 14);
    expect(plan.tours.orderByChild).toBe('startAtMs');
    expect(plan.tours.startAt).toBe(expectedStart.getTime());
    expect(plan.tours.endAt).toBe(expectedEnd.getTime());
    expect(plan.tours.limitToFirst).toBe(DASHBOARD_TOUR_LIMIT);
    expect(plan.safetyAttention.limitToLast).toBe(DASHBOARD_SAFETY_LIMIT);
    expect(plan.recentBroadcasts.limitToLast).toBe(DASHBOARD_BROADCAST_LIMIT);
  });

  it('attaches only three bounded projection queries and one direct summary listener', () => {
    firebaseMocks.onValue.mockReturnValue(vi.fn());
    subscribeToDashboardProjection({}, { nowMs: 1000 }, { onData: vi.fn(), onError: vi.fn() });
    expect(firebaseMocks.onValue).toHaveBeenCalledTimes(4);
    const queriedPaths = firebaseMocks.query.mock.calls.map(([baseRef]) => baseRef.path);
    expect(queriedPaths).toEqual([
      'admin_dashboard/v1/tours',
      'admin_dashboard/v1/safety_attention',
      'admin_dashboard/v1/recent_broadcasts',
    ]);
    expect(firebaseMocks.ref).not.toHaveBeenCalledWith({}, 'tours');
    expect(firebaseMocks.ref).not.toHaveBeenCalledWith({}, 'tour_manifests');
    expect(firebaseMocks.ref).not.toHaveBeenCalledWith({}, 'drivers');
    expect(firebaseMocks.ref).not.toHaveBeenCalledWith({}, 'broadcasts');
    expect(firebaseMocks.ref).not.toHaveBeenCalledWith({}, 'globalSafetyAlerts');
  });

  it('filters tombstones and records deterministic query, record and payload counts', async () => {
    firebaseMocks.get
      .mockResolvedValueOnce(snapshot({ A: { startAtMs: 1 }, OLD: { deleted: true } }))
      .mockResolvedValueOnce(snapshot({ S: { attentionSortKey: 1 } }))
      .mockResolvedValueOnce(snapshot({ B: { createdAtMs: 1 } }))
      .mockResolvedValueOnce(snapshot({ totalTours: 5000 }));
    const instrumentation = {};
    const result = await fetchDashboardProjection({}, { nowMs: 1000 }, instrumentation);
    expect(Object.keys(result.tours)).toEqual(['A']);
    expect(instrumentation.queries).toBe(4);
    expect(instrumentation.recordsReturned).toBe(4);
    expect(instrumentation.payloadBytes).toBeGreaterThan(0);
  });

  it('keeps projected records and payload bounded at the full synthetic acceptance scale', async () => {
    const nowMs = 1_780_000_000_000;
    const tours = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [
      `TOUR_${String(index).padStart(5, '0')}`,
      { name: `Tour ${index}`, startAtMs: nowMs + (index * 1_000) },
    ]));
    const manifestBookings = Object.fromEntries(Array.from({ length: 5_000 }, (_, tourIndex) => [
      `TOUR_${String(tourIndex).padStart(5, '0')}`,
      Object.fromEntries(Array.from({ length: 10 }, (_, bookingIndex) => [
        `BOOKING_${tourIndex}_${bookingIndex}`,
        { passengerStatus: { 0: 'PENDING' } },
      ])),
    ]));
    const drivers = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
      `DRIVER_${index}`,
      { currentTourId: `TOUR_${String(index).padStart(5, '0')}` },
    ]));
    const resolvedSafetyHistory = Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [
      `SAFETY_${index}`,
      { status: 'resolved', timestampMs: index },
    ]));
    const openSafety = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
      `OPEN_${index}`,
      { status: 'pending', attentionSortKey: index + 1, severity: 'high' },
    ]));
    const broadcastHistory = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `BROADCAST_${index}`,
      { createdAtMs: nowMs - 10_000 + index },
    ]));

    expect(Object.keys(tours)).toHaveLength(5_000);
    expect(Object.values(manifestBookings).reduce((total, bookings) => total + Object.keys(bookings).length, 0)).toBe(50_000);
    expect(Object.keys(drivers)).toHaveLength(1_000);
    expect(Object.keys(resolvedSafetyHistory)).toHaveLength(12_000);
    expect(Object.keys(broadcastHistory)).toHaveLength(10_000);

    const driverTours = new Set(Object.values(drivers).map((driver) => driver.currentTourId));
    const fullTourProjection = Object.fromEntries(Object.entries(tours).map(([tourId, tour]) => [tourId, {
      displayName: tour.name,
      startAtMs: tour.startAtMs,
      passengerCount: Object.keys(manifestBookings[tourId]).length,
      isAssigned: driverTours.has(tourId),
    }]));
    const fullSafetyProjection = Object.fromEntries(
      Object.entries({ ...resolvedSafetyHistory, ...openSafety })
        .filter(([, row]) => row.status !== 'resolved'),
    );
    const fullBroadcastProjection = Object.fromEntries(Object.entries(broadcastHistory).map(([id, row]) => [
      id,
      { ...row, safeSummary: 'Bounded broadcast summary' },
    ]));
    expect(Object.values(fullTourProjection).reduce((total, row) => total + row.passengerCount, 0)).toBe(50_000);
    expect(Object.values(fullTourProjection).filter((row) => row.isAssigned)).toHaveLength(1_000);
    expect(Object.keys(fullSafetyProjection)).toHaveLength(120);
    expect(Object.keys(fullBroadcastProjection)).toHaveLength(10_000);

    const plans = getDashboardProjectionQueryPlan({ nowMs, tourLimit: 50_000 });
    const boundedTours = executeInMemoryPlan(fullTourProjection, plans.tours);
    const boundedSafety = executeInMemoryPlan(fullSafetyProjection, plans.safetyAttention);
    const boundedBroadcasts = executeInMemoryPlan(fullBroadcastProjection, plans.recentBroadcasts);
    firebaseMocks.get
      .mockResolvedValueOnce(snapshot(boundedTours))
      .mockResolvedValueOnce(snapshot(boundedSafety))
      .mockResolvedValueOnce(snapshot(boundedBroadcasts))
      .mockResolvedValueOnce(snapshot({ totalTours: 5_000, totalDrivers: 1_000 }));

    const instrumentation = {};
    const result = await fetchDashboardProjection({}, { nowMs, tourLimit: 50_000 }, instrumentation);
    expect(Object.keys(result.tours)).toHaveLength(DASHBOARD_TOUR_LIMIT);
    expect(Object.keys(result.safetyAttention)).toHaveLength(DASHBOARD_SAFETY_LIMIT);
    expect(Object.keys(result.recentBroadcasts)).toHaveLength(DASHBOARD_BROADCAST_LIMIT);
    expect(instrumentation.queries).toBe(4);
    expect(instrumentation.recordsReturned).toBe(
      DASHBOARD_TOUR_LIMIT + DASHBOARD_SAFETY_LIMIT + DASHBOARD_BROADCAST_LIMIT + 1,
    );
    expect(instrumentation.payloadBytes).toBeLessThan(250_000);
  });

  it('defaults malformed rollout state to legacy and subscribes to the private rollout path', () => {
    expect(resolveDashboardRolloutPhase(null)).toBe('legacy');
    expect(resolveDashboardRolloutPhase({ schemaVersion: 1, phase: 'wat' })).toBe('legacy');
    expect(resolveDashboardRolloutPhase({ schemaVersion: 1, phase: 'shadow' })).toBe('shadow');
    firebaseMocks.onValue.mockImplementation((_ref, onData) => {
      onData(snapshot({ schemaVersion: 1, phase: 'projection' }));
      return vi.fn();
    });
    const onPhase = vi.fn();
    subscribeToDashboardRollout({}, onPhase, vi.fn());
    expect(firebaseMocks.ref).toHaveBeenCalledWith({}, 'admin_dashboard_rollout/v1');
    expect(onPhase).toHaveBeenCalledWith('projection');
  });

  it('compares only bounded safe row fields in shadow mode', () => {
    const comparison = compareDashboardProjectionRows([{
      id: 'TOUR_1', name: 'Tour', tourCode: 'T1', startAtMs: 1_000, isAssigned: true, passengerCount: 10,
    }], {
      TOUR_1: { displayName: 'Tour', tourCode: 'T1', startAtMs: 1_000, isAssigned: true, passengerCount: 10 },
    }, { nowMs: 1_000 });
    expect(comparison.matches).toBe(true);
    expect(comparison).not.toHaveProperty('tourIds');
  });

  it('shadow comparison filters and caps legacy work to the same projection window', () => {
    const nowMs = 1_780_000_000_000;
    const legacyRows = Array.from({ length: 5_001 }, (_, index) => ({
      id: `TOUR_${String(index).padStart(5, '0')}`,
      name: `Tour ${index}`,
      tourCode: `T${index}`,
      startAtMs: nowMs + (index % 10),
      isAssigned: false,
      passengerCount: 0,
    }));
    const selected = [...legacyRows]
      .sort((left, right) => left.startAtMs - right.startAtMs || left.id.localeCompare(right.id))
      .slice(0, DASHBOARD_TOUR_LIMIT);
    const projectionRows = Object.fromEntries(selected.map((row) => [row.id, {
      displayName: row.name,
      tourCode: row.tourCode,
      startAtMs: row.startAtMs,
      isAssigned: false,
      passengerCount: 0,
    }]));

    const comparison = compareDashboardProjectionRows(legacyRows, projectionRows, { nowMs });
    expect(comparison.legacyCount).toBe(DASHBOARD_TOUR_LIMIT);
    expect(comparison.projectionCount).toBe(DASHBOARD_TOUR_LIMIT);
    expect(comparison.missingProjection).toBe(0);
    expect(comparison.matches).toBe(true);
  });

  it('shadow comparison covers tours, safety, broadcasts and displayed summary metrics', () => {
    const comparison = compareDashboardProjectionSections(shadowFixture());
    expect(comparison.matches).toBe(true);
    expect(Object.keys(comparison.sections)).toEqual([
      'tours', 'safetyAttention', 'recentBroadcasts', 'summary',
    ]);
    expect(comparison.sections.summary.fieldCount).toBe(20);
  });

  it('detects a safety mismatch when tour rows still match', () => {
    const fixture = shadowFixture();
    fixture.projectionModel.safetyAlerts[0].severity = 'critical';
    const comparison = compareDashboardProjectionSections(fixture);
    expect(comparison.sections.tours.matches).toBe(true);
    expect(comparison.sections.safetyAttention.matches).toBe(false);
    expect(comparison.sections.safetyAttention.reasonCounts.severityMismatch).toBe(1);
  });

  it('detects a broadcast mismatch when tour rows still match', () => {
    const fixture = shadowFixture();
    fixture.projectionBroadcasts.BROADCAST_1.deliveryStatus = 'failed';
    const comparison = compareDashboardProjectionSections(fixture);
    expect(comparison.sections.tours.matches).toBe(true);
    expect(comparison.sections.recentBroadcasts.reasonCounts.deliveryStatusMismatch).toBe(1);
  });

  it('detects displayed summary drift when all bounded rows match', () => {
    const fixture = shadowFixture();
    fixture.projectionModel.metrics.totalDrivers = 3;
    const comparison = compareDashboardProjectionSections(fixture);
    expect(comparison.sections.tours.matches).toBe(true);
    expect(comparison.sections.safetyAttention.matches).toBe(true);
    expect(comparison.sections.recentBroadcasts.matches).toBe(true);
    expect(comparison.sections.summary.reasonCounts.totalDriversMismatch).toBe(1);
  });

  it('detects an incorrectly retained resolved safety row', () => {
    const fixture = shadowFixture();
    fixture.legacyModel.safetyAlerts = [{
      id: 'tour:EVENT_1', eventId: 'EVENT_1', tourId: 'TOUR_1', status: 'resolved',
      severity: 'high', requiresAttention: false, timestampMs: 900,
    }];
    fixture.projectionModel.safetyAlerts = [{
      id: 'projection:EVENT_1', eventId: 'EVENT_1', tourId: 'TOUR_1', status: 'resolved',
      severity: 'high', requiresAttention: false, timestampMs: 900,
    }];
    const comparison = compareDashboardProjectionSections(fixture);
    expect(comparison.sections.safetyAttention.unexpectedProjection).toBe(1);
  });

  it('detects one missing recent broadcast', () => {
    const fixture = shadowFixture();
    fixture.projectionBroadcasts = {};
    const comparison = compareDashboardProjectionSections(fixture);
    expect(comparison.sections.recentBroadcasts.missingProjection).toBe(1);
  });

  it('never emits private safety or broadcast fields in shadow diagnostics', () => {
    const fixture = shadowFixture();
    fixture.legacyModel.safetyAlerts[0] = {
      ...fixture.legacyModel.safetyAlerts[0],
      message: 'PRIVATE INCIDENT MESSAGE',
      coordinates: { latitude: 1, longitude: 2 },
      reporterAuthUid: 'PRIVATE REPORTER',
    };
    fixture.legacyBroadcasts.TOUR_1.BROADCAST_1.message = 'PRIVATE BROADCAST MESSAGE';
    const serialized = JSON.stringify(compareDashboardProjectionSections(fixture));
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('message');
    expect(serialized).not.toContain('coordinates');
    expect(serialized).not.toContain('reporterAuthUid');
  });
});
