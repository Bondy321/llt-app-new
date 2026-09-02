'use strict';

// @ts-check

const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const {
  maxMetric,
  orderedEntries,
  transactionWithAuthoritativeExistingValue,
} = require('./retentionEngineRuntime');

const validRecoveryCursor = (value, expectedRolloutRevision, expectedEvidenceDigest) => (
  value?.schemaVersion === 1
  && Number(value.rolloutRevision) === Number(expectedRolloutRevision)
  && value.evidenceDigest === expectedEvidenceDigest
  && Number.isSafeInteger(value.recoveryDueAtMs)
  && typeof value.jobId === 'string' && value.jobId.length > 0
);

const compareRecoveryCursor = (left, right) => (
  Number(left?.recoveryDueAtMs || 0) - Number(right?.recoveryDueAtMs || 0)
  || String(left?.jobId || '').localeCompare(String(right?.jobId || ''))
);

const persistRecoveryCursor = async ({
  db, metrics, startCursor, lastCursor, hasMore,
  expectedRolloutRevision, expectedEvidenceDigest, nowMs,
}) => {
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/requeue_recovery_cursor`)
    .transaction((current) => {
      const currentCompatible = validRecoveryCursor(
        current, expectedRolloutRevision, expectedEvidenceDigest,
      );
      if (!hasMore) {
        const currentMatchesStart = (!currentCompatible && !startCursor)
          || (currentCompatible && startCursor
            && compareRecoveryCursor(current, startCursor) === 0);
        return currentMatchesStart ? null : undefined;
      }
      if (!lastCursor || (currentCompatible
        && compareRecoveryCursor(current, lastCursor) >= 0)) return undefined;
      return {
        schemaVersion: 1,
        rolloutRevision: expectedRolloutRevision,
        evidenceDigest: expectedEvidenceDigest,
        ...lastCursor,
        updatedAtMs: nowMs,
      };
    }, undefined, false);
  metrics.transactions += 1;
};

const sweepDueRequeueRecovery = async ({
  db, nowMs, budgets, metrics, resumeRequeue, startPage, canContinue,
  expectedRolloutRevision, expectedEvidenceDigest,
}) => { // eslint-disable-line complexity -- cursor, deadline and rollout gates are one bounded sweep
  if (typeof resumeRequeue !== 'function') return { hasMore: false, stopped: false };
  if (startPage && !(await startPage())) return { hasMore: true, stopped: true };
  const cursorRecord = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/requeue_recovery_cursor`)
    .once('value')).val();
  metrics.queries += 1;
  const startCursor = validRecoveryCursor(
    cursorRecord, expectedRolloutRevision, expectedEvidenceDigest,
  ) ? {
      recoveryDueAtMs: cursorRecord.recoveryDueAtMs,
      jobId: cursorRecord.jobId,
    } : null;
  let query = db.ref('notification_requeue_jobs').orderByChild('recoveryDueAtMs');
  query = startCursor
    ? query.startAfter(startCursor.recoveryDueAtMs, startCursor.jobId)
    : query.startAt(1);
  const snapshot = await query.endAt(nowMs).limitToFirst(budgets.auxiliaryPageSize + 1)
    .once('value');
  metrics.queries += 1;
  const entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.recoveryDueAtMs || 0) - Number(right?.recoveryDueAtMs || 0)
      || leftKey.localeCompare(rightKey)
  ));
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  let stopped = false;
  let incomplete = false;
  const selected = entries.slice(0, budgets.auxiliaryPageSize);
  const processed = [];
  for (const [jobId, state] of selected) {
    if (canContinue && !(await canContinue())) { stopped = true; break; }
    processed.push([jobId, state]);
    if (state?.status !== 'processing') {
      await transactionWithAuthoritativeExistingValue(
        db.ref(`notification_requeue_jobs/${jobId}`), (current) => current?.requeueId === state?.requeueId
          && Number(current?.recoveryDueAtMs) === Number(state?.recoveryDueAtMs)
          ? { ...current, recoveryDueAtMs: null } : undefined,
      );
      metrics.transactions += 1;
      continue;
    }
    try {
      const result = await resumeRequeue({ db, jobId, nowMs });
      incomplete = incomplete || result?.complete !== true;
    } catch (_error) {
      metrics.failures += 1;
      incomplete = true;
    }
  }
  const cursorHasMore = stopped || processed.length < selected.length
    || entries.length > budgets.auxiliaryPageSize;
  if (stopped || !startPage || await startPage()) {
    const last = processed.at(-1);
    await persistRecoveryCursor({
      db,
      metrics,
      startCursor,
      lastCursor: last ? { recoveryDueAtMs: Number(last[1]?.recoveryDueAtMs), jobId: last[0] } : null,
      hasMore: cursorHasMore,
      expectedRolloutRevision,
      expectedEvidenceDigest,
      nowMs,
    });
  } else stopped = true;
  return {
    hasMore: stopped || incomplete || entries.length > budgets.auxiliaryPageSize,
    stopped,
  };
};

module.exports = { sweepDueRequeueRecovery };
