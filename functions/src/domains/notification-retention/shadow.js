'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { NOTIFICATION_RETENTION_PATHS, RETENTION_MS } = require('./constants');
const { classifyNotificationRetentionEligibility } = require('./eligibility');
const { readActiveRequeue } = require('./retentionContext');
const { maxMetric, orderedEntries, safeInteger } = require('./retentionEngineRuntime');
const { compiledRetentionProtocol, protocolEvidenceMatches } = require('./protocol');
const { transactionWithAuthoritativeExistingValue } = require('./retentionEngineRuntime');

const SHADOW_PROGRESS_SCHEMA_VERSION = 1;
const ZERO_DIGEST = '0'.repeat(64);
const SHADOW_STAGES = new Set(['compactor', 'legacy', 'complete']);

const xorDigest = (current, jobId) => {
  const left = /^[a-f0-9]{64}$/u.test(current || '') ? BigInt(`0x${current}`) : 0n;
  const right = BigInt(`0x${createHash('sha256').update(jobId).digest('hex')}`);
  return (left ^ right).toString(16).padStart(64, '0');
};

const normalizeCursor = (value, field) => value
  && Number.isSafeInteger(value[field]) && value[field] > 0
  && typeof value.jobId === 'string' && value.jobId
  ? { [field]: value[field], jobId: value.jobId }
  : null;

const initialProgress = ({ rolloutRevision, evaluationNowMs }) => ({
  schemaVersion: SHADOW_PROGRESS_SCHEMA_VERSION,
  rolloutRevision,
  revision: 0,
  evaluationNowMs,
  stage: 'compactor',
  compactorCursor: null,
  legacyCursor: null,
  compactorScanned: 0,
  legacyScanned: 0,
  shadowEligible: 0,
  shadowLegacyEligible: 0,
  compactorDigest: ZERO_DIGEST,
  legacyDigest: ZERO_DIGEST,
  ...compiledRetentionProtocol(),
});

const normalizeProgress = (value, { rolloutRevision, evaluationNowMs }) => {
  if (!value || value.schemaVersion !== SHADOW_PROGRESS_SCHEMA_VERSION
    || value.rolloutRevision !== rolloutRevision
    || !protocolEvidenceMatches(value)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.evaluationNowMs) || value.evaluationNowMs <= 0
    || !SHADOW_STAGES.has(value.stage)) {
    return initialProgress({ rolloutRevision, evaluationNowMs });
  }
  return {
    schemaVersion: SHADOW_PROGRESS_SCHEMA_VERSION,
    rolloutRevision,
    revision: value.revision,
    evaluationNowMs: value.evaluationNowMs,
    stage: value.stage,
    compactorCursor: normalizeCursor(value.compactorCursor, 'retentionDueAtMs'),
    legacyCursor: normalizeCursor(value.legacyCursor, 'updatedAtMs'),
    compactorScanned: safeInteger(value.compactorScanned),
    legacyScanned: safeInteger(value.legacyScanned),
    shadowEligible: safeInteger(value.shadowEligible),
    shadowLegacyEligible: safeInteger(value.shadowLegacyEligible),
    compactorDigest: /^[a-f0-9]{64}$/u.test(value.compactorDigest || '')
      ? value.compactorDigest : ZERO_DIGEST,
    legacyDigest: /^[a-f0-9]{64}$/u.test(value.legacyDigest || '')
      ? value.legacyDigest : ZERO_DIGEST,
    ...compiledRetentionProtocol(),
  };
};

const readOrderedPage = async ({ db, root, field, cursor, endAt, limit, metrics }) => {
  let query = db.ref(root).orderByChild(field);
  const supportsStartAfter = cursor && typeof query.startAfter === 'function';
  if (supportsStartAfter) query = query.startAfter(cursor[field], cursor.jobId);
  else if (cursor) query = query.startAt(cursor[field], cursor.jobId);
  else query = query.startAt(1);
  const snapshot = await query.endAt(endAt).limitToFirst(limit + 1).once('value');
  metrics.queries += 1;
  let entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.[field] || 0) - Number(right?.[field] || 0)
      || leftKey.localeCompare(rightKey)
  ));
  if (cursor && !supportsStartAfter) {
    entries = entries.filter(([jobId, value]) => Number(value?.[field] || 0) > cursor[field]
      || (Number(value?.[field] || 0) === cursor[field] && jobId > cursor.jobId));
  }
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  return { selected: entries.slice(0, limit), hasMore: entries.length > limit };
};

const scheduledStateMatches = ({ state, jobId, job, classification }) => Boolean(
  classification.eligible
  && state?.jobId === jobId
  && !['completed', 'requires_attention'].includes(state.status)
  && Number(state.generation) === Number(classification.generation)
  && state.targetStatus === job.status
  && Number(state.targetCompletedAtMs || 0) === Number(job.completedAtMs || 0)
  && Number(state.retentionDueAtMs || 0) === Number(classification.dueAtMs || 0),
);

const scanCompactorPage = async ({ db, progress, limit, metrics }) => {
  const page = await readOrderedPage({
    db,
    root: NOTIFICATION_RETENTION_PATHS.jobs,
    field: 'retentionDueAtMs',
    cursor: progress.compactorCursor,
    endAt: progress.evaluationNowMs,
    limit,
    metrics,
  });
  let eligible = 0;
  let digest = progress.compactorDigest;
  for (const [jobId, state] of page.selected) {
    const job = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
    metrics.queries += 1;
    if (!job) continue;
    const activeRequeue = await readActiveRequeue(
      db, jobId, progress.evaluationNowMs, metrics,
    );
    const classification = classifyNotificationRetentionEligibility({
      job, nowMs: progress.evaluationNowMs, activeRequeue,
    });
    if (scheduledStateMatches({ state, jobId, job, classification })) {
      eligible += 1;
      digest = xorDigest(digest, jobId);
    }
  }
  const last = page.selected.at(-1);
  return {
    ...progress,
    stage: page.hasMore ? 'compactor' : 'legacy',
    compactorCursor: last ? {
      retentionDueAtMs: Number(last[1]?.retentionDueAtMs || 0), jobId: last[0],
    } : progress.compactorCursor,
    compactorScanned: progress.compactorScanned + page.selected.length,
    shadowEligible: progress.shadowEligible + eligible,
    compactorDigest: digest,
  };
};

const scanLegacyPage = async ({ db, progress, limit, metrics }) => {
  const page = await readOrderedPage({
    db,
    root: 'notification_jobs',
    field: 'updatedAtMs',
    cursor: progress.legacyCursor,
    endAt: progress.evaluationNowMs - RETENTION_MS,
    limit,
    metrics,
  });
  let eligible = 0;
  let digest = progress.legacyDigest;
  for (const [jobId, job] of page.selected) {
    const activeRequeue = await readActiveRequeue(
      db, jobId, progress.evaluationNowMs, metrics,
    );
    if (classifyNotificationRetentionEligibility({
      job, nowMs: progress.evaluationNowMs, activeRequeue,
    }).eligible) {
      eligible += 1;
      digest = xorDigest(digest, jobId);
    }
  }
  const last = page.selected.at(-1);
  return {
    ...progress,
    stage: page.hasMore ? 'legacy' : 'complete',
    legacyCursor: last ? {
      updatedAtMs: Number(last[1]?.updatedAtMs || 0), jobId: last[0],
    } : progress.legacyCursor,
    legacyScanned: progress.legacyScanned + page.selected.length,
    shadowLegacyEligible: progress.shadowLegacyEligible + eligible,
    legacyDigest: digest,
  };
};

const sameProgressVersion = (current, expected) => current.rolloutRevision === expected.rolloutRevision
  && protocolEvidenceMatches(current)
  && protocolEvidenceMatches(expected)
  && current.revision === expected.revision
  && current.evaluationNowMs === expected.evaluationNowMs
  && current.stage === expected.stage
  && JSON.stringify(current.compactorCursor) === JSON.stringify(expected.compactorCursor)
  && JSON.stringify(current.legacyCursor) === JSON.stringify(expected.legacyCursor);

const commitProgress = async ({ db, base, next, nowMs, metrics }) => {
  let committed = false;
  const progressRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/shadow_progress`);
  const updateProgress = (currentValue) => {
      const current = normalizeProgress(currentValue, {
        rolloutRevision: base.rolloutRevision,
        evaluationNowMs: base.evaluationNowMs,
      });
      if (!sameProgressVersion(current, base)) return undefined;
      committed = true;
      return { ...next, revision: base.revision + 1, updatedAtMs: nowMs };
    };
  const result = base.revision > 0
    ? await transactionWithAuthoritativeExistingValue(progressRef, updateProgress)
    : await progressRef.transaction(updateProgress, undefined, false);
  metrics.transactions += 1;
  return committed && result?.committed
    ? normalizeProgress(result.snapshot.val(), {
      rolloutRevision: base.rolloutRevision,
      evaluationNowMs: base.evaluationNowMs,
    })
    : null;
};

const metricsFromProgress = (progress, metrics) => {
  metrics.shadowEligible = progress.shadowEligible;
  metrics.shadowLegacyEligible = progress.shadowLegacyEligible;
  metrics.shadowMismatches = progress.stage === 'complete'
    && (progress.shadowEligible !== progress.shadowLegacyEligible
      || progress.compactorDigest !== progress.legacyDigest)
    ? 1
    : 0;
};

const runDurableShadowPlan = async ({ db, nowMs, rollout, budgets, metrics }) => {
  const progressRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/shadow_progress`);
  const observed = (await progressRef.once('value')).val();
  metrics.queries += 1;
  let progress = normalizeProgress(observed, {
    rolloutRevision: rollout.revision,
    evaluationNowMs: nowMs,
  });
  let remaining = budgets.maxShadowJobs;
  let conflict = false;
  while (remaining > 0 && progress.stage !== 'complete') {
    const limit = Math.min(budgets.maxJobs, remaining);
    const next = progress.stage === 'compactor'
      ? await scanCompactorPage({ db, progress, limit, metrics })
      : await scanLegacyPage({ db, progress, limit, metrics });
    const committed = await commitProgress({ db, base: progress, next, nowMs, metrics });
    if (!committed) {
      const refreshed = normalizeProgress((await progressRef.once('value')).val(), {
        rolloutRevision: rollout.revision,
        evaluationNowMs: progress.evaluationNowMs,
      });
      metrics.queries += 1;
      if (refreshed.evaluationNowMs === progress.evaluationNowMs
        && refreshed.revision > progress.revision) {
        progress = refreshed;
      } else {
        conflict = true;
      }
      break;
    }
    remaining -= Math.max(1,
      (committed.compactorScanned - progress.compactorScanned)
      + (committed.legacyScanned - progress.legacyScanned));
    progress = committed;
  }
  metricsFromProgress(progress, metrics);
  return {
    hasMore: conflict || progress.stage !== 'complete',
    conflict,
    progressRevision: progress.revision,
    evaluationNowMs: progress.evaluationNowMs,
    compactorScanned: progress.compactorScanned,
    legacyScanned: progress.legacyScanned,
  };
};

module.exports = { runDurableShadowPlan };
