import {
  endAt,
  get,
  limitToFirst,
  limitToLast,
  onValue,
  orderByChild,
  query,
  ref,
  startAt,
} from 'firebase/database';
import { nowAsISOString } from '../utils/dateUtils';

export const DASHBOARD_PROJECTION_ROOT = 'admin_dashboard/v1';
export const DASHBOARD_ROLLOUT_PATH = 'admin_dashboard_rollout/v1';
export const DASHBOARD_PROJECTION_SCHEMA_VERSION = 1;
export const DASHBOARD_TOUR_LIMIT = 500;
export const DASHBOARD_SAFETY_LIMIT = 80;
export const DASHBOARD_BROADCAST_LIMIT = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const BROADCAST_RETENTION_MS = 30 * DAY_MS;
const VALID_PHASES = new Set(['legacy', 'shadow', 'projection']);
const SAFETY_SEVERITY_WEIGHT = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const SUMMARY_COMPARISON_FIELDS = Object.freeze([
  'totalDrivers',
  'assignedDrivers',
  'availableDrivers',
  'totalTours',
  'operationalTours',
  'upcomingTours',
  'assignedUpcomingTours',
  'unassignedUpcomingTours',
  'missingDateOperationalTours',
  'upcomingAssignmentCoveragePercent',
  'activeAssignmentCoveragePercent',
  'totalPassengers',
  'totalKnownCapacity',
  'passengerLoadPercent',
  'unknownCapacityTours',
  'highLoadTours',
  'safetyAttentionAlerts',
  'broadcastTotalCount',
  'broadcastLast24hCount',
  'broadcastTourCount',
]);

const asRecord = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const clampLimit = (value, maximum) => (
  Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : maximum
);

const withoutTombstones = (value) => Object.fromEntries(
  Object.entries(asRecord(value)).filter(([, row]) => row?.deleted !== true),
);

export function resolveDashboardRolloutPhase(value) {
  return value?.schemaVersion === DASHBOARD_PROJECTION_SCHEMA_VERSION && VALID_PHASES.has(value?.phase)
    ? value.phase
    : 'legacy';
}

export function getDashboardProjectionQueryPlan({
  nowMs = Date.now(),
  maxFutureDays = 14,
  maxOverdueDays = 7,
  tourLimit = DASHBOARD_TOUR_LIMIT,
  safetyLimit = DASHBOARD_SAFETY_LIMIT,
  broadcastLimit = DASHBOARD_BROADCAST_LIMIT,
} = {}) {
  const tourWindowStart = new Date(nowMs);
  tourWindowStart.setHours(0, 0, 0, 0);
  tourWindowStart.setDate(tourWindowStart.getDate() - maxOverdueDays);
  const tourWindowEnd = new Date(nowMs);
  tourWindowEnd.setHours(23, 59, 59, 999);
  tourWindowEnd.setDate(tourWindowEnd.getDate() + maxFutureDays);
  return {
    tours: {
      path: `${DASHBOARD_PROJECTION_ROOT}/tours`,
      orderByChild: 'startAtMs',
      startAt: tourWindowStart.getTime(),
      endAt: tourWindowEnd.getTime(),
      limitToFirst: clampLimit(tourLimit, DASHBOARD_TOUR_LIMIT),
    },
    safetyAttention: {
      path: `${DASHBOARD_PROJECTION_ROOT}/safety_attention`,
      orderByChild: 'attentionSortKey',
      startAt: 1,
      limitToLast: clampLimit(safetyLimit, DASHBOARD_SAFETY_LIMIT),
    },
    recentBroadcasts: {
      path: `${DASHBOARD_PROJECTION_ROOT}/recent_broadcasts`,
      orderByChild: 'createdAtMs',
      startAt: nowMs - BROADCAST_RETENTION_MS,
      limitToLast: clampLimit(broadcastLimit, DASHBOARD_BROADCAST_LIMIT),
    },
    summary: { path: `${DASHBOARD_PROJECTION_ROOT}/summary` },
  };
}

const buildQuery = (database, plan) => {
  const constraints = [orderByChild(plan.orderByChild)];
  if (Number.isFinite(plan.startAt)) constraints.push(startAt(plan.startAt));
  if (Number.isFinite(plan.endAt)) constraints.push(endAt(plan.endAt));
  if (Number.isSafeInteger(plan.limitToFirst)) constraints.push(limitToFirst(plan.limitToFirst));
  if (Number.isSafeInteger(plan.limitToLast)) constraints.push(limitToLast(plan.limitToLast));
  return query(ref(database, plan.path), ...constraints);
};

export function subscribeToDashboardRollout(database, onPhase, onError) {
  return onValue(ref(database, DASHBOARD_ROLLOUT_PATH), (snapshot) => {
    onPhase(resolveDashboardRolloutPhase(snapshot.val()));
  }, onError);
}

const normalizeSnapshot = (key, snapshot) => {
  const value = snapshot.val() || {};
  return key === 'summary' ? asRecord(value) : withoutTombstones(value);
};

export function subscribeToDashboardProjection(database, options = {}, handlers = {}) {
  const plans = getDashboardProjectionQueryPlan(options);
  return Object.entries(plans).map(([key, plan]) => {
    const source = key === 'summary' ? ref(database, plan.path) : buildQuery(database, plan);
    return onValue(source, (snapshot) => {
      handlers.onData?.(key, normalizeSnapshot(key, snapshot), nowAsISOString(), {
        limit: plan.limitToFirst || plan.limitToLast || 1,
        count: Number.isSafeInteger(snapshot.size) ? snapshot.size : Object.keys(asRecord(snapshot.val())).length,
      });
    }, (error) => handlers.onError?.(key, error));
  });
}

export async function fetchDashboardProjection(database, options = {}, instrumentation = null) {
  const plans = getDashboardProjectionQueryPlan(options);
  const entries = await Promise.all(Object.entries(plans).map(async ([key, plan]) => {
    if (instrumentation) instrumentation.queries = Number(instrumentation.queries || 0) + 1;
    const source = key === 'summary' ? ref(database, plan.path) : buildQuery(database, plan);
    const snapshot = await get(source);
    const value = normalizeSnapshot(key, snapshot);
    if (instrumentation) {
      instrumentation.recordsReturned = Number(instrumentation.recordsReturned || 0)
        + (key === 'summary' ? 1 : Object.keys(value).length);
      instrumentation.payloadBytes = Number(instrumentation.payloadBytes || 0)
        + new TextEncoder().encode(JSON.stringify(value)).length;
    }
    return [key, value];
  }));
  return { ...Object.fromEntries(entries), revalidatedAt: nowAsISOString() };
}

const comparableTour = (row = {}) => ({
  name: row.displayName ?? row.name ?? null,
  tourCode: row.tourCode ?? null,
  startAtMs: row.startAtMs ?? row.dateMeta?.startAtMs ?? null,
  isActive: row.isActive !== false,
  isAssigned: Boolean(row.isAssigned),
  passengerCount: Number(row.passengerCount || 0),
  passengerCountSource: row.passengerCountSource || 'none',
  capacity: row.capacity ?? null,
  loadPercent: row.loadPercent ?? null,
});

export function compareDashboardProjectionRows(legacyRows = [], projectionRows = {}, options = {}) {
  const plan = getDashboardProjectionQueryPlan(options).tours;
  const boundedLegacyRows = legacyRows
    .filter((row) => {
      const startAtMs = Number(row?.startAtMs ?? row?.dateMeta?.startAtMs);
      return Number.isFinite(startAtMs) && startAtMs >= plan.startAt && startAtMs <= plan.endAt;
    })
    .sort((left, right) => {
      const startDelta = Number(left?.startAtMs ?? left?.dateMeta?.startAtMs)
        - Number(right?.startAtMs ?? right?.dateMeta?.startAtMs);
      return startDelta || String(left?.id || '').localeCompare(String(right?.id || ''));
    })
    .slice(0, plan.limitToFirst);
  const boundedProjectionEntries = Object.entries(asRecord(projectionRows))
    .sort(([leftId, left], [rightId, right]) => (
      Number(left?.startAtMs || 0) - Number(right?.startAtMs || 0)
      || leftId.localeCompare(rightId)
    ))
    .slice(0, plan.limitToFirst);
  const legacyById = new Map(boundedLegacyRows.map((row) => [row.id, comparableTour(row)]));
  const projectedById = new Map(boundedProjectionEntries.map(([id, row]) => [id, comparableTour(row)]));
  let missingProjection = 0;
  let unexpectedProjection = 0;
  let fieldMismatch = 0;
  legacyById.forEach((row, id) => {
    const projected = projectedById.get(id);
    if (!projected) missingProjection += 1;
    else if (JSON.stringify(row) !== JSON.stringify(projected)) fieldMismatch += 1;
  });
  projectedById.forEach((_row, id) => {
    if (!legacyById.has(id)) unexpectedProjection += 1;
  });
  return {
    legacyCount: legacyById.size,
    projectionCount: projectedById.size,
    missingProjection,
    unexpectedProjection,
    fieldMismatch,
    matches: missingProjection === 0 && unexpectedProjection === 0 && fieldMismatch === 0,
  };
}

const normalizedEventId = (row = {}) => {
  if (typeof row.eventId === 'string' && row.eventId) return row.eventId;
  const id = String(row.id || '');
  const separator = id.indexOf(':');
  return separator >= 0 ? id.slice(separator + 1) : id;
};

const compareBoundedRows = ({ legacyRows, projectionRows, keyFor, fields }) => {
  const legacyById = new Map(legacyRows.map((row) => [keyFor(row), row]));
  const projectedById = new Map(projectionRows.map((row) => [keyFor(row), row]));
  const reasonCounts = Object.fromEntries(fields.map((field) => [`${field}Mismatch`, 0]));
  let missingProjection = 0;
  let unexpectedProjection = 0;
  let fieldMismatch = 0;
  legacyById.forEach((legacy, id) => {
    const projected = projectedById.get(id);
    if (!projected) {
      missingProjection += 1;
      return;
    }
    let rowMismatch = false;
    fields.forEach((field) => {
      if (!Object.is(legacy[field], projected[field])) {
        reasonCounts[`${field}Mismatch`] += 1;
        rowMismatch = true;
      }
    });
    if (rowMismatch) fieldMismatch += 1;
  });
  projectedById.forEach((_row, id) => {
    if (!legacyById.has(id)) unexpectedProjection += 1;
  });
  return {
    legacyCount: legacyById.size,
    projectionCount: projectedById.size,
    missingProjection,
    unexpectedProjection,
    fieldMismatch,
    reasonCounts,
    matches: missingProjection === 0 && unexpectedProjection === 0 && fieldMismatch === 0,
  };
};

const comparableSafety = (row = {}) => ({
  tourId: String(row.tourId || ''),
  eventId: normalizedEventId(row),
  status: String(row.status || 'pending'),
  severity: String(row.severity || 'medium'),
  requiresAttention: Boolean(row.requiresAttention),
  timestampMs: Number(row.timestampMs || 0),
});

const compareSafetyAttention = (legacyModel = {}, projectionModel = {}, limit) => {
  const legacyRows = (Array.isArray(legacyModel.safetyAlerts) ? legacyModel.safetyAlerts : [])
    .map(comparableSafety)
    .filter((row) => row.requiresAttention)
    .sort((left, right) => (
      (SAFETY_SEVERITY_WEIGHT[right.severity] || 0) - (SAFETY_SEVERITY_WEIGHT[left.severity] || 0)
      || right.timestampMs - left.timestampMs
      || left.tourId.localeCompare(right.tourId)
      || left.eventId.localeCompare(right.eventId)
    ))
    .slice(0, limit);
  const projectionRows = (Array.isArray(projectionModel.safetyAlerts) ? projectionModel.safetyAlerts : [])
    .map(comparableSafety)
    .slice(0, limit);
  return compareBoundedRows({
    legacyRows,
    projectionRows,
    keyFor: (row) => `${row.tourId}\u0000${row.eventId}`,
    fields: ['status', 'severity', 'requiresAttention'],
  });
};

const comparableBroadcast = ({ tourId, broadcastId, row }) => ({
  tourId: String(tourId || ''),
  broadcastId: String(broadcastId || ''),
  deliveryStatus: String(row?.deliveryStatus || 'queued'),
  createdAtMs: Number(row?.createdAtMs || 0),
  recipientCount: row?.recipientCount !== null && row?.recipientCount !== undefined
    && Number.isFinite(Number(row.recipientCount)) ? Number(row.recipientCount) : null,
});

const boundedLegacyBroadcasts = (broadcasts, plan) => Object.entries(asRecord(broadcasts))
  .flatMap(([tourId, rows]) => Object.entries(asRecord(rows)).map(([broadcastId, row]) => (
    comparableBroadcast({ tourId, broadcastId, row })
  )))
  .filter((row) => row.createdAtMs >= plan.startAt)
  .sort((left, right) => left.createdAtMs - right.createdAtMs
    || left.tourId.localeCompare(right.tourId)
    || left.broadcastId.localeCompare(right.broadcastId))
  .slice(-plan.limitToLast);

const boundedProjectionBroadcasts = (broadcasts, plan) => Object.entries(withoutTombstones(broadcasts))
  .map(([id, row]) => comparableBroadcast({
    tourId: row?.tourId,
    broadcastId: row?.broadcastId || id,
    row,
  }))
  .filter((row) => row.createdAtMs >= plan.startAt)
  .sort((left, right) => left.createdAtMs - right.createdAtMs
    || left.tourId.localeCompare(right.tourId)
    || left.broadcastId.localeCompare(right.broadcastId))
  .slice(-plan.limitToLast);

const compareRecentBroadcasts = (legacyBroadcasts, projectionBroadcasts, plan) => compareBoundedRows({
  legacyRows: boundedLegacyBroadcasts(legacyBroadcasts, plan),
  projectionRows: boundedProjectionBroadcasts(projectionBroadcasts, plan),
  keyFor: (row) => `${row.tourId}\u0000${row.broadcastId}`,
  fields: ['deliveryStatus', 'createdAtMs', 'recipientCount'],
});

const displayedSummary = (model = {}) => ({
  ...Object.fromEntries(SUMMARY_COMPARISON_FIELDS
    .filter((field) => !field.startsWith('broadcast'))
    .map((field) => [field, model.metrics?.[field] ?? null])),
  broadcastTotalCount: model.broadcastActivity?.totalCount ?? null,
  broadcastLast24hCount: model.broadcastActivity?.last24hCount ?? null,
  broadcastTourCount: model.broadcastActivity?.tourCount ?? null,
});

const compareDisplayedSummary = (legacyModel, projectionModel) => {
  const legacy = displayedSummary(legacyModel);
  const projection = displayedSummary(projectionModel);
  const reasonCounts = Object.fromEntries(SUMMARY_COMPARISON_FIELDS.map((field) => [
    `${field}Mismatch`, Object.is(legacy[field], projection[field]) ? 0 : 1,
  ]));
  const fieldMismatch = Object.values(reasonCounts).reduce((total, count) => total + count, 0);
  return { fieldCount: SUMMARY_COMPARISON_FIELDS.length, fieldMismatch, reasonCounts, matches: fieldMismatch === 0 };
};

export function compareDashboardProjectionSections({
  legacyModel = {},
  projectionModel = {},
  projectionTours = {},
  legacyBroadcasts = {},
  projectionBroadcasts = {},
  options = {},
} = {}) {
  const plan = getDashboardProjectionQueryPlan(options);
  const sections = {
    tours: compareDashboardProjectionRows(legacyModel.tourRows, projectionTours, options),
    safetyAttention: compareSafetyAttention(legacyModel, projectionModel, plan.safetyAttention.limitToLast),
    recentBroadcasts: compareRecentBroadcasts(
      legacyBroadcasts,
      projectionBroadcasts,
      plan.recentBroadcasts,
    ),
    summary: compareDisplayedSummary(legacyModel, projectionModel),
  };
  const reasonCounts = {
    tourMissing: sections.tours.missingProjection,
    tourUnexpected: sections.tours.unexpectedProjection,
    tourFieldMismatch: sections.tours.fieldMismatch,
    safetyMissing: sections.safetyAttention.missingProjection,
    safetyUnexpected: sections.safetyAttention.unexpectedProjection,
    safetyFieldMismatch: sections.safetyAttention.fieldMismatch,
    broadcastMissing: sections.recentBroadcasts.missingProjection,
    broadcastUnexpected: sections.recentBroadcasts.unexpectedProjection,
    broadcastFieldMismatch: sections.recentBroadcasts.fieldMismatch,
    summaryFieldMismatch: sections.summary.fieldMismatch,
  };
  return {
    matches: Object.values(sections).every((section) => section.matches),
    reasonCounts,
    sections,
  };
}
