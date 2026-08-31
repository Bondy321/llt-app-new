'use strict';

// @ts-check

const {
  DASHBOARD_ROOT,
  DASHBOARD_SCHEMA_VERSION,
  fingerprint,
} = require('./dashboardProjection');
const {
  acquireCountLock,
  commitConsistentSummaryDomain,
  readValue,
  reconcileAggregateContribution,
  releaseCountLock,
} = require('./dashboardProjectionState');

const TOUR_SUMMARY_SHARD_COUNT = 32;
const DASHBOARD_MAX_FUTURE_DAYS = 14;
const DASHBOARD_MAX_OVERDUE_DAYS = 7;
const DASHBOARD_TIME_ZONE = 'Europe/London';
const SUMMARY_PUBLISH_ATTEMPTS = 3;
const ALL_TIME_SUMMARY_GENERATION_KEY = 'all_time_v1';

const dashboardDayKey = (epochMs) => {
  if (!Number.isFinite(Number(epochMs))) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DASHBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Number(epochMs)));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
};

const shiftDashboardDayKey = (dayKey, days) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return null;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};

const dashboardWindowDayKeys = (nowMs = Date.now()) => {
  const today = dashboardDayKey(nowMs);
  if (!today) return [];
  return Array.from(
    { length: DASHBOARD_MAX_OVERDUE_DAYS + DASHBOARD_MAX_FUTURE_DAYS + 1 },
    (_, index) => shiftDashboardDayKey(today, index - DASHBOARD_MAX_OVERDUE_DAYS),
  ).filter(Boolean);
};

const tourSummaryShardId = (tourId) => String(
  Number.parseInt(fingerprint({ tourId }).slice(0, 8), 16) % TOUR_SUMMARY_SHARD_COUNT,
).padStart(2, '0');

const sumAggregateRows = (rows) => rows.reduce((total, row) => {
  Object.entries(row && typeof row === 'object' ? row : {}).forEach(([field, value]) => {
    if (['schemaVersion', 'revision', 'updatedAtMs'].includes(field)) return;
    if (Number.isFinite(Number(value))) total[field] = Number(total[field] || 0) + Number(value);
  });
  return total;
}, {});

const aggregateRevision = (orderedRows) => orderedRows.reduce((total, { row }) => {
  const revision = Number(row?.revision || 0);
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(total + revision)) {
    throw new TypeError('Dashboard aggregate source revision must remain a non-negative safe integer');
  }
  return total + revision;
}, 0);

const summarySourceFingerprint = ({ domain, generation, orderedRows, fields }) => fingerprint({
  domain,
  generation,
  sourceRevisions: orderedRows.map(({ key, row }) => ({
    key,
    revision: Math.max(0, Number(row?.revision || 0)),
  })),
  fields,
});

const commitLoadedSummary = async ({ db, domain, loadCandidate, nowMs }) => {
  let lastError = null;
  for (let attempt = 0; attempt < SUMMARY_PUBLISH_ATTEMPTS; attempt += 1) {
    const candidate = await loadCandidate();
    try {
      const commit = await commitConsistentSummaryDomain({
        db,
        domain,
        generationKey: candidate.generationKey,
        generationStartDayKey: candidate.generationStartDayKey,
        generationEndDayKey: candidate.generationEndDayKey,
        sourceRevision: candidate.sourceRevision,
        sourceFingerprint: candidate.sourceFingerprint,
        fields: candidate.fields,
        nowMs,
      });
      return { ...candidate, commit };
    } catch (error) {
      if (error?.code !== 'DASHBOARD_SUMMARY_INCONSISTENT') throw error;
      lastError = error;
    }
  }
  throw lastError;
};

const toCommittedSummaryResult = ({ domain, candidate, commit }) => {
  const value = commit.value || {};
  const generation = {
    key: value[`${domain}GenerationKey`] || null,
  };
  if (typeof value[`${domain}GenerationStartDayKey`] === 'string') {
    generation.startDayKey = value[`${domain}GenerationStartDayKey`];
  }
  if (typeof value[`${domain}GenerationEndDayKey`] === 'string') {
    generation.endDayKey = value[`${domain}GenerationEndDayKey`];
  }
  return {
    generation,
    sourceRevision: Number(value[`${domain}SourceRevision`] || 0),
    commitOutcome: commit.outcome,
    summary: Object.fromEntries(Object.keys(candidate.fields).map((field) => [field, value[field]])),
  };
};

const buildStableTourContribution = (currentProjection) => { // eslint-disable-line complexity -- mirrors the stable all-time dashboard scorecards
  if (!currentProjection || currentProjection.deleted === true) return {};
  const operational = currentProjection.isActive !== false;
  const knownCapacity = operational && currentProjection.hasKnownCapacity === true;
  const hasValidStart = currentProjection.startAtMs !== null
    && currentProjection.startAtMs !== undefined
    && Number.isFinite(Number(currentProjection.startAtMs));
  return {
    totalTours: 1,
    operationalTours: operational ? 1 : 0,
    assignedOperationalTours: operational && currentProjection.isAssigned ? 1 : 0,
    totalPassengers: operational ? Number(currentProjection.passengerCount || 0) : 0,
    totalKnownCapacity: knownCapacity ? Number(currentProjection.capacity || 0) : 0,
    unknownCapacityTours: operational && !knownCapacity ? 1 : 0,
    missingDateOperationalTours: operational && !hasValidStart ? 1 : 0,
    highLoadTours: knownCapacity
      && (Number(currentProjection.loadPercent || 0) >= 85
        || Number(currentProjection.passengerCount || 0) > Number(currentProjection.capacity || 0)) ? 1 : 0,
  };
};

const loadStableTourSummaryCandidate = async (db, instrumentation) => {
  const rawRows = await readValue(
    db,
    `${DASHBOARD_ROOT}/internal/tour_summary_shards`,
    instrumentation,
  );
  const orderedRows = Array.from({ length: TOUR_SUMMARY_SHARD_COUNT }, (_, index) => {
    const key = String(index).padStart(2, '0');
    const row = rawRows?.[key];
    return { key, row: row && typeof row === 'object' ? row : {} };
  });
  const summary = sumAggregateRows(orderedRows.map(({ row }) => row));
  const operationalTours = Number(summary.operationalTours || 0);
  const totalKnownCapacity = Number(summary.totalKnownCapacity || 0);
  const fields = {
    totalTours: Number(summary.totalTours || 0),
    operationalTours,
    activeAssignmentCoveragePercent: operationalTours > 0
      ? Math.round((Number(summary.assignedOperationalTours || 0) / operationalTours) * 100)
      : null,
    totalPassengers: Number(summary.totalPassengers || 0),
    totalKnownCapacity,
    passengerLoadPercent: totalKnownCapacity > 0
      ? Math.round((Number(summary.totalPassengers || 0) / totalKnownCapacity) * 100)
      : null,
    unknownCapacityTours: Number(summary.unknownCapacityTours || 0),
    missingDateOperationalTours: Number(summary.missingDateOperationalTours || 0),
    highLoadTours: Number(summary.highLoadTours || 0),
  };
  const generation = { key: ALL_TIME_SUMMARY_GENERATION_KEY };
  return {
    generationKey: generation.key,
    sourceRevision: aggregateRevision(orderedRows),
    sourceFingerprint: summarySourceFingerprint({ domain: 'tour', generation, orderedRows, fields }),
    fields,
  };
};

const publishStableTourSummary = async ({ db, nowMs = Date.now(), instrumentation }) => {
  const candidate = await commitLoadedSummary({
    db,
    domain: 'tour',
    nowMs,
    loadCandidate: () => loadStableTourSummaryCandidate(db, instrumentation),
  });
  return toCommittedSummaryResult({ domain: 'tour', candidate, commit: candidate.commit });
};

const publishDashboardWindowSummary = async ({ db, nowMs = Date.now(), instrumentation }) => {
  const dayKeys = dashboardWindowDayKeys(nowMs);
  const generation = {
    startDayKey: dayKeys[0],
    endDayKey: dayKeys.at(-1),
  };
  const candidate = await commitLoadedSummary({
    db,
    domain: 'window',
    nowMs,
    loadCandidate: async () => {
      if (instrumentation) instrumentation.queries = Number(instrumentation.queries || 0) + 1;
      const snapshot = await db.ref(`${DASHBOARD_ROOT}/internal/tour_day_summaries`)
        .orderByKey()
        .startAt(dayKeys[0])
        .endAt(dayKeys.at(-1))
        .once('value');
      const rawRows = snapshot.val() || {};
      const orderedRows = dayKeys.map((key) => ({
        key,
        row: rawRows?.[key] && typeof rawRows[key] === 'object' ? rawRows[key] : {},
      }));
      const rows = orderedRows.map(({ row }) => row);
      const upcomingRows = rows.slice(DASHBOARD_MAX_OVERDUE_DAYS);
      const upcomingTours = upcomingRows.reduce((sum, row) => sum + Number(row?.activeTours || 0), 0);
      const assignedUpcomingTours = upcomingRows
        .reduce((sum, row) => sum + Number(row?.assignedActiveTours || 0), 0);
      const attentionTours = rows.reduce((sum, row) => sum + Number(row?.activeTours || 0), 0);
      const assignedAttentionTours = rows
        .reduce((sum, row) => sum + Number(row?.assignedActiveTours || 0), 0);
      const fields = {
        upcomingTours,
        assignedUpcomingTours,
        unassignedUpcomingTours: Math.max(0, attentionTours - assignedAttentionTours),
        upcomingAssignmentCoveragePercent: upcomingTours > 0
          ? Math.round((assignedUpcomingTours / upcomingTours) * 100)
          : null,
        attentionWindowTours: attentionTours,
      };
      return {
        generationStartDayKey: generation.startDayKey,
        generationEndDayKey: generation.endDayKey,
        sourceRevision: aggregateRevision(orderedRows),
        sourceFingerprint: summarySourceFingerprint({ domain: 'window', generation, orderedRows, fields }),
        fields,
      };
    },
  });
  return toCommittedSummaryResult({ domain: 'window', candidate, commit: candidate.commit });
};

const reconcileTourDaySummary = async ({ db, tourId, order, instrumentation }) => {
  const owner = `tour-day:${order.sourceEventId || order.sourceEventAtMs}`;
  const stateLockPath = `${DASHBOARD_ROOT}/internal/count_locks/tour_day_state/${tourId}`;
  if (!(await acquireCountLock({ db, lockPath: stateLockPath, owner }))) {
    const error = new Error('Dashboard tour-day reconciliation is already in progress');
    error.code = 'DASHBOARD_TOUR_DAY_LOCKED';
    throw error;
  }
  try {
    const [currentProjection, priorState] = await Promise.all([
      readValue(db, `${DASHBOARD_ROOT}/tours/${tourId}`, instrumentation),
      readValue(db, `${DASHBOARD_ROOT}/internal/tour_day_state/${tourId}`, instrumentation),
    ]);
    const currentDayKey = currentProjection && currentProjection.deleted !== true
      ? dashboardDayKey(currentProjection.startAtMs)
      : null;
    const priorDayKey = typeof priorState?.dayKey === 'string' ? priorState.dayKey : null;
    const affectedDayKeys = [...new Set([priorDayKey, currentDayKey].filter(Boolean))];
    for (const dayKey of affectedDayKeys) {
      await reconcileAggregateContribution({
        db,
        type: 'tour_day',
        scopeId: dayKey,
        memberId: tourId,
        owner: `${owner}:${dayKey}`,
        nowMs: order.sourceEventAtMs,
        aggregatePath: `${DASHBOARD_ROOT}/internal/tour_day_summaries/${dayKey}`,
        loadCurrentContribution: async () => (
          currentDayKey === dayKey && currentProjection?.isActive !== false
            ? {
              activeTours: 1,
              assignedActiveTours: currentProjection?.isAssigned ? 1 : 0,
            }
            : {}
        ),
      });
    }
    await db.ref(`${DASHBOARD_ROOT}/internal/tour_day_state/${tourId}`).set(currentDayKey ? {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      dayKey: currentDayKey,
      updatedAtMs: Math.max(Number(priorState?.updatedAtMs || 0), Number(order.sourceEventAtMs || 0)),
    } : null);
  } finally {
    await releaseCountLock({ db, lockPath: stateLockPath, owner });
  }
};

const recomputeTourSummaryDomains = async ({ db, tourId, order, instrumentation }) => {
  const shardId = tourSummaryShardId(tourId);
  await reconcileAggregateContribution({
    db,
    type: 'tour',
    scopeId: shardId,
    memberId: tourId,
    owner: `tour:${order.sourceEventId || order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/tour_summary_shards/${shardId}`,
    loadCurrentContribution: async () => buildStableTourContribution(
      await readValue(db, `${DASHBOARD_ROOT}/tours/${tourId}`, instrumentation),
    ),
  });
  await publishStableTourSummary({ db, nowMs: Date.now(), instrumentation });
  await reconcileTourDaySummary({ db, tourId, order, instrumentation });
  await publishDashboardWindowSummary({ db, nowMs: Date.now(), instrumentation });
};

module.exports = {
  aggregateRevision,
  dashboardDayKey,
  dashboardWindowDayKeys,
  loadStableTourSummaryCandidate,
  publishDashboardWindowSummary,
  publishStableTourSummary,
  reconcileTourDaySummary,
  recomputeTourSummaryDomains,
  tourSummaryShardId,
};
