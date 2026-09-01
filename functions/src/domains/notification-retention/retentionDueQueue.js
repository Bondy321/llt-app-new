'use strict';

// @ts-check

const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { maxMetric, orderedEntries, safeInteger } = require('./retentionEngineRuntime');

const validDueCursor = (value) => value && Number.isSafeInteger(value.retentionDueAtMs)
  && value.retentionDueAtMs > 0 && typeof value.jobId === 'string' && value.jobId;

const loadDueQueueSegment = async ({
  db, nowMs, limit, metrics, afterCursor = null, beforeCursor = null,
}) => {
  let query = db.ref(NOTIFICATION_RETENTION_PATHS.jobs).orderByChild('retentionDueAtMs');
  const supportsStartAfter = validDueCursor(afterCursor) && typeof query.startAfter === 'function';
  if (supportsStartAfter) {
    query = query.startAfter(afterCursor.retentionDueAtMs, afterCursor.jobId);
  } else if (validDueCursor(afterCursor)) {
    query = query.startAt(afterCursor.retentionDueAtMs, afterCursor.jobId);
  } else query = query.startAt(1);
  if (validDueCursor(beforeCursor)) {
    query = query.endAt(beforeCursor.retentionDueAtMs, beforeCursor.jobId);
  } else query = query.endAt(nowMs);
  const snapshot = await query.limitToFirst(limit).once('value');
  metrics.queries += 1;
  let entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.retentionDueAtMs || 0) - Number(right?.retentionDueAtMs || 0)
      || leftKey.localeCompare(rightKey)
  ));
  if (validDueCursor(afterCursor) && !supportsStartAfter) {
    entries = entries.filter(([jobId, state]) => (
      Number(state?.retentionDueAtMs || 0) > afterCursor.retentionDueAtMs
      || (Number(state?.retentionDueAtMs || 0) === afterCursor.retentionDueAtMs
        && jobId > afterCursor.jobId)
    ));
  }
  if (validDueCursor(beforeCursor)) {
    entries = entries.filter(([jobId, state]) => (
      Number(state?.retentionDueAtMs || 0) < beforeCursor.retentionDueAtMs
      || (Number(state?.retentionDueAtMs || 0) === beforeCursor.retentionDueAtMs
        && jobId <= beforeCursor.jobId)
    ));
  }
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  return entries.map(([jobId, state]) => [state?.queueKey || jobId, { ...state, jobId }]);
};

const cursorFromDueEntry = (entry) => entry ? {
  retentionDueAtMs: Number(entry[1]?.retentionDueAtMs || 0),
  jobId: entry[1]?.jobId || null,
} : null;

const loadDueRetentionQueue = async ({ db, nowMs, limit, metrics, cursor = null }) => {
  const primary = await loadDueQueueSegment({
    db, nowMs, limit: limit + 1, metrics, afterCursor: cursor,
  });
  let combined = primary;
  if (validDueCursor(cursor) && primary.length <= limit) {
    const wrapped = await loadDueQueueSegment({
      db,
      nowMs,
      limit: (limit + 1) - primary.length,
      metrics,
      beforeCursor: cursor,
    });
    combined = [...primary, ...wrapped];
  }
  maxMetric(metrics, 'maxRecordsInMemory', combined.length);
  const entries = combined.slice(0, limit);
  return {
    entries,
    hasMore: combined.length > limit,
    lastCursor: cursorFromDueEntry(entries.at(-1)),
  };
};

const loadExactCanaryDue = async ({ db, nowMs, metrics, fixture }) => {
  const state = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${fixture.jobId}`)
    .once('value')).val();
  metrics.queries += 1;
  if (!state || state.jobId !== fixture.jobId
    || Number(state.retentionDueAtMs || 0) > nowMs) return { entries: [], hasMore: false };
  return {
    entries: [[state.queueKey || fixture.jobId, { ...state, jobId: fixture.jobId }]],
    hasMore: false,
    lastCursor: { retentionDueAtMs: state.retentionDueAtMs, jobId: fixture.jobId },
  };
};

const readSchedulerCursor = async ({ db, metrics }) => {
  const value = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/scheduler`).once('value')).val();
  metrics.queries += 1;
  return validDueCursor(value?.cursor) ? value.cursor : null;
};

const persistSchedulerCursor = async ({ db, cursor, nowMs, metrics }) => {
  if (!validDueCursor(cursor)) return;
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/scheduler`).transaction((current) => ({
    schemaVersion: 1,
    revision: safeInteger(current?.revision) + 1,
    cursor,
    updatedAtMs: nowMs,
  }), undefined, false);
  metrics.transactions += 1;
};

module.exports = {
  loadDueRetentionQueue,
  loadExactCanaryDue,
  persistSchedulerCursor,
  readSchedulerCursor,
};
