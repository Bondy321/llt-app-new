'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
} = require('./constants');
const { classifyNotificationRetentionEligibility } = require('./eligibility');
const {
  ensureNotificationRetentionScheduled,
  readNotificationRetentionRollout,
} = require('./state');

const PREPARATION_SCHEMA_VERSION = 1;
const PREPARATION_STAGES = new Set(['ordinary', 'privacy']);

const emptyCounts = () => ({
  scanned: 0,
  materialized: 0,
  alreadyPrepared: 0,
  scheduled: 0,
  alreadyScheduled: 0,
  deferred: 0,
  requiresAttention: 0,
  orphanAttemptsScanned: 0,
  orphanAttemptsFound: 0,
  orphanAttemptsMalformed: 0,
  ordinaryEligible: 0,
  ordinaryNotDue: 0,
  privacyEligible: 0,
  privacyNotDue: 0,
  nonTerminalExcluded: 0,
  activeLeaseExcluded: 0,
});

const addCounts = (left, right) => Object.fromEntries(Object.keys(emptyCounts())
  .map((key) => [key, Number(left?.[key] || 0) + Number(right?.[key] || 0)]));

const clampPageSize = (value, fallback = DEFAULT_RETENTION_BUDGETS.pageSize) => (
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, 250) : fallback
);

const snapshotEntriesInQueryOrder = (snapshot) => {
  const entries = [];
  if (snapshot && typeof snapshot.forEach === 'function') {
    snapshot.forEach((child) => {
      entries.push([child.key, child.val()]);
      return false;
    });
    return entries;
  }
  return Object.entries(snapshot?.val?.() || {});
};

const readCursor = (value) => {
  if (!value) return { stage: 'ordinary', value: 0, key: null };
  if (typeof value === 'object' && PREPARATION_STAGES.has(value.stage)
    && Number.isSafeInteger(value.value) && (value.key === null || typeof value.key === 'string')) {
    return { stage: value.stage, value: value.value, key: value.key };
  }
  if (typeof value !== 'string') return null;
  const [stage, rawValue, ...keyParts] = value.split('~');
  const numericValue = Number(rawValue);
  const key = keyParts.join('~') || null;
  if (!PREPARATION_STAGES.has(stage) || !Number.isSafeInteger(numericValue)) return null;
  return { stage, value: numericValue, key };
};

const serializeCursor = (cursor) => cursor
  ? `${cursor.stage}~${cursor.value}~${cursor.key || ''}`
  : null;

const boundedEvidenceDigest = (value) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex').slice(0, 32);

const callQuery = (query, method, args) => typeof query?.[method] === 'function'
  ? query[method](...args)
  : query;

const loadOrdinaryPage = async ({ db, nowMs, pageSize, cursor }) => {
  let query = db.ref('notification_jobs').orderByChild('completedAtMs');
  query = cursor.key
    ? callQuery(query, 'startAfter', [cursor.value, cursor.key])
    : callQuery(query, 'startAt', [1]);
  query = query.endAt(nowMs).limitToFirst(pageSize + 1);
  const entries = snapshotEntriesInQueryOrder(await query.once('value'))
    .filter(([key, job]) => !cursor.key
      || Number(job?.completedAtMs || 0) > cursor.value
      || (Number(job?.completedAtMs || 0) === cursor.value && key > cursor.key));
  const selected = entries.slice(0, pageSize);
  const last = selected.at(-1);
  return {
    stage: 'ordinary',
    selected,
    hasMore: entries.length > pageSize,
    nextCursor: last ? {
      stage: 'ordinary', value: Number(last[1]?.completedAtMs || 0), key: last[0],
    } : cursor,
    recordsInMemory: Math.min(entries.length, pageSize + 1),
  };
};

const loadPrivacyPage = async ({ db, pageSize, cursor }) => {
  let query = db.ref('notification_jobs').orderByChild('status');
  if (cursor.key) {
    query = callQuery(query, 'startAfter', ['privacy_deleted', cursor.key]);
    query = query.endAt('privacy_deleted');
  } else if (typeof query.startAt === 'function') {
    query = query.startAt('privacy_deleted').endAt('privacy_deleted');
  } else {
    query = query.equalTo('privacy_deleted');
  }
  query = query.limitToFirst(pageSize + 1);
  const entries = snapshotEntriesInQueryOrder(await query.once('value'))
    .filter(([key, job]) => job?.status === 'privacy_deleted' && (!cursor.key || key > cursor.key));
  const selected = entries.slice(0, pageSize);
  const last = selected.at(-1);
  return {
    stage: 'privacy',
    selected,
    hasMore: entries.length > pageSize,
    nextCursor: last ? { stage: 'privacy', value: 0, key: last[0] } : cursor,
    recordsInMemory: Math.min(entries.length, pageSize + 1),
  };
};

/**
 * One query stage per invocation keeps the +1 sentinel and memory bound exact.
 * Finishing ordinary discovery advances to privacy discovery on the next page.
 */
const loadPreparationPage = async ({ db, nowMs, pageSize, cursor }) => {
  if (cursor.stage === 'privacy') {
    const page = await loadPrivacyPage({ db, pageSize, cursor });
    return { ...page, stageComplete: !page.hasMore, allStagesComplete: !page.hasMore };
  }
  const page = await loadOrdinaryPage({ db, nowMs, pageSize, cursor });
  if (page.hasMore) return { ...page, stageComplete: false, allStagesComplete: false };
  return {
    ...page,
    stageComplete: true,
    allStagesComplete: false,
    nextCursor: { stage: 'privacy', value: 0, key: null },
  };
};

const loadOrphanDiscoveryPage = async ({ db, nowMs, pageSize, cursor }) => {
  let query = db.ref('notification_delivery_attempts').orderByChild('retentionDueAtMs');
  query = cursor?.key
    ? callQuery(query, 'startAfter', [cursor.value, cursor.key])
    : callQuery(query, 'startAt', [1]);
  query = query.endAt(nowMs).limitToFirst(pageSize + 1);
  const entries = snapshotEntriesInQueryOrder(await query.once('value'))
    .filter(([key, attempt]) => !cursor?.key
      || Number(attempt?.retentionDueAtMs || 0) > cursor.value
      || (Number(attempt?.retentionDueAtMs || 0) === cursor.value && key > cursor.key));
  const selected = entries.slice(0, pageSize);
  let found = 0;
  let malformed = 0;
  for (const [, attempt] of selected) {
    if (!TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(attempt?.status)
      || Number(attempt?.retentionDueAtMs || 0) > nowMs
      || typeof attempt?.jobId !== 'string') {
      malformed += 1;
      continue;
    }
    const parent = (await db.ref(`notification_jobs/${attempt.jobId}`).once('value')).val();
    if (!parent) found += 1;
  }
  const last = selected.at(-1);
  return {
    scanned: selected.length,
    found,
    malformed,
    hasMore: entries.length > pageSize,
    nextCursor: last ? { value: Number(last[1]?.retentionDueAtMs || 0), key: last[0] } : cursor,
    recordsInMemory: Math.min(entries.length, pageSize + 1),
    queries: 1 + selected.length,
  };
};

const inspectOrdinary = (job, nowMs) => {
  if (!ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES.has(job?.status)) return 'deferred';
  const completedAtMs = Number(job.completedAtMs || 0);
  const expectedDueAtMs = completedAtMs + RETENTION_MS;
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs <= 0
    || !Number.isSafeInteger(expectedDueAtMs)) return 'attention';
  if (!Number.isSafeInteger(job.retentionDueAtMs) || job.retentionDueAtMs <= 0) return 'missing';
  const classification = classifyNotificationRetentionEligibility({ job, nowMs });
  if (classification.reason === 'eligible' || classification.reason === 'not_due') return 'prepared';
  if (classification.reason === 'active_delivery_lease') return 'prepared';
  return 'attention';
};

const inspectPrivacy = (job) => (
  job?.status === 'privacy_deleted' && Number.isSafeInteger(job.expiresAtMs) && job.expiresAtMs > 0
    ? 'prepared'
    : 'attention'
);

const materializeOrdinaryBoundary = async ({ db, jobId, observed }) => {
  const retentionDueAtMs = observed.completedAtMs + RETENTION_MS;
  let changed = false;
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.jobId !== jobId || current.status !== observed.status
      || current.completedAtMs !== observed.completedAtMs) return undefined;
    if (Number.isSafeInteger(current.retentionDueAtMs) && current.retentionDueAtMs > 0) {
      return current.retentionDueAtMs === retentionDueAtMs ? current : undefined;
    }
    changed = true;
    return { ...current, retentionDueAtMs };
  }, undefined, false);
  return { committed: Boolean(result?.committed), changed, job: result?.snapshot?.val?.() || null };
};

const recordEligibilityCounts = ({ counts, page, observed, inspection, nowMs }) => {
  if (inspection === 'deferred') {
    counts.nonTerminalExcluded += 1;
    return;
  }
  if (page.stage === 'privacy' && inspection === 'prepared') {
    counts[Number(observed.expiresAtMs) <= nowMs ? 'privacyEligible' : 'privacyNotDue'] += 1;
    return;
  }
  if (page.stage !== 'ordinary' || !['missing', 'prepared'].includes(inspection)) return;
  if (observed.lease && Number(observed.lease.expiresAtMs || 0) > nowMs) {
    counts.activeLeaseExcluded += 1;
    return;
  }
  const dueAtMs = inspection === 'missing'
    ? Number(observed.completedAtMs || 0) + RETENTION_MS
    : Number(observed.retentionDueAtMs || 0);
  counts[dueAtMs <= nowMs ? 'ordinaryEligible' : 'ordinaryNotDue'] += 1;
};

const processPreparationPage = async ({ db, page, nowMs, apply, authorizeWrite = null }) => {
  const counts = emptyCounts();
  counts.scanned = page.selected.length;
  for (const [jobId, observed] of page.selected) {
    const inspection = page.stage === 'privacy'
      ? inspectPrivacy(observed)
      : inspectOrdinary(observed, nowMs);
    recordEligibilityCounts({ counts, page, observed, inspection, nowMs });
    if (inspection === 'deferred') {
      counts.deferred += 1;
      continue;
    }
    if (inspection === 'attention') {
      counts.requiresAttention += 1;
      continue;
    }
    let candidate = observed;
    if (inspection === 'missing') {
      counts.materialized += 1;
      if (apply) {
        if (authorizeWrite && !(await authorizeWrite())) return { counts, rolloutChanged: true };
        const materialized = await materializeOrdinaryBoundary({ db, jobId, observed });
        if (!materialized.committed) {
          counts.materialized -= 1;
          counts.requiresAttention += 1;
          continue;
        }
        if (!materialized.changed) {
          counts.materialized -= 1;
          counts.alreadyPrepared += 1;
        }
        candidate = materialized.job;
      }
    } else {
      counts.alreadyPrepared += 1;
    }
    if (!apply) continue;
    if (authorizeWrite && !(await authorizeWrite())) return { counts, rolloutChanged: true };
    const scheduled = await ensureNotificationRetentionScheduled({ db, jobId, job: candidate, nowMs });
    if (scheduled.scheduled) counts.scheduled += 1;
    else if (scheduled.reason === 'already_scheduled' || scheduled.reason === 'queue_repaired') {
      counts.alreadyScheduled += 1;
    } else {
      counts.requiresAttention += 1;
    }
  }
  return { counts, rolloutChanged: false };
};

const unwrapPreparationCounts = (processed) => processed?.counts || processed;

const normalizeProgress = (value) => {
  const cursor = readCursor(value?.cursor);
  if (!value || value.schemaVersion !== PREPARATION_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !cursor) {
    return {
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      revision: 0,
      rolloutRevision: null,
      cursor: serializeCursor({ stage: 'ordinary', value: 0, key: null }),
      orphanCursor: null,
      cumulative: emptyCounts(),
      status: 'not_started',
      preparationComplete: false,
      evidenceDigest: null,
    };
  }
  return {
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    revision: value.revision,
    rolloutRevision: Number.isSafeInteger(value.rolloutRevision) && value.rolloutRevision >= 0
      ? value.rolloutRevision
      : null,
    cursor: serializeCursor(cursor),
    orphanCursor: value.orphanCursor || null,
    cumulative: addCounts(emptyCounts(), value.cumulative),
    status: value.status || 'processing',
    preparationComplete: value.preparationComplete === true,
    evidenceDigest: typeof value.evidenceDigest === 'string' ? value.evidenceDigest : null,
  };
};

const readOrphanCursor = (value) => {
  if (!value || typeof value !== 'string') return null;
  const separator = value.indexOf('~');
  const numericValue = Number(value.slice(0, separator));
  const key = value.slice(separator + 1);
  return separator > 0 && Number.isSafeInteger(numericValue) && key
    ? { value: numericValue, key }
    : null;
};

const serializeOrphanCursor = (cursor) => cursor ? `${cursor.value}~${cursor.key}` : null;

const buildPageResult = ({ mode, pageCounts, cumulative, page, orphan, cursor, progressConflict = false }) => ({
  mode,
  ...pageCounts,
  cumulative,
  hasMore: progressConflict || !page.allStagesComplete || orphan.hasMore,
  cursor: serializeCursor(cursor),
  orphanCursor: serializeOrphanCursor(orphan.nextCursor),
  queries: 1 + orphan.queries,
  maxRecordsInMemory: Math.max(page.recordsInMemory, orphan.recordsInMemory),
  preparationComplete: !progressConflict && page.allStagesComplete && !orphan.hasMore
    && cumulative.requiresAttention === 0,
  progressConflict,
});

const invalidPreparationResult = (mode, reason) => ({
  mode,
  hasMore: reason === 'cursor_conflict',
  preparationComplete: false,
  progressConflict: reason === 'cursor_conflict',
  reason,
});

const loadPreparationWork = async ({
  db, nowMs, boundedPageSize, cursor, orphanCursor, budgets,
}) => {
  const page = await loadPreparationPage({ db, nowMs, pageSize: boundedPageSize, cursor });
  const orphan = await loadOrphanDiscoveryPage({
    db,
    nowMs,
    pageSize: clampPageSize(budgets.orphanPageSize, DEFAULT_RETENTION_BUDGETS.orphanPageSize),
    cursor: orphanCursor,
  });
  return { page, orphan };
};

const commitPreparationProgress = async ({
  db, base, page, orphan, cumulative, preparationComplete, evidenceDigest, nowMs,
  rolloutRevision,
}) => {
  let advanced = false;
  const progress = await db.ref(NOTIFICATION_RETENTION_PATHS.preparation).transaction((currentValue) => {
    const current = normalizeProgress(currentValue);
    if (current.revision !== base.revision || current.cursor !== base.cursor
      || current.orphanCursor !== base.orphanCursor
      || current.rolloutRevision !== base.rolloutRevision) return undefined;
    advanced = true;
    return {
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      revision: current.revision + 1,
      rolloutRevision,
      cursor: serializeCursor(page.nextCursor),
      orphanCursor: serializeOrphanCursor(orphan.nextCursor),
      cumulative,
      status: preparationComplete ? 'complete'
        : (cumulative.requiresAttention > 0 ? 'blocked' : 'processing'),
      preparationComplete,
      evidenceDigest,
      updatedAtMs: nowMs,
    };
  }, undefined, false);
  return Boolean(advanced && progress?.committed);
};

const runNotificationRetentionPreflight = async ({
  db, nowMs = Date.now(), pageSize, cursor: rawCursor = null, budgets = {},
}) => {
  const boundedPageSize = clampPageSize(pageSize);
  const cursor = readCursor(rawCursor);
  if (!cursor) return { mode: 'dry-run', hasMore: false, preparationComplete: false, reason: 'invalid_cursor' };
  const page = await loadPreparationPage({ db, nowMs, pageSize: boundedPageSize, cursor });
  const pageCounts = unwrapPreparationCounts(await processPreparationPage({
    db, page, nowMs, apply: false,
  }));
  const orphan = await loadOrphanDiscoveryPage({
    db,
    nowMs,
    pageSize: clampPageSize(budgets.orphanPageSize, DEFAULT_RETENTION_BUDGETS.orphanPageSize),
    cursor: readOrphanCursor(budgets.orphanCursor),
  });
  pageCounts.orphanAttemptsScanned = orphan.scanned;
  pageCounts.orphanAttemptsFound = orphan.found;
  pageCounts.orphanAttemptsMalformed = orphan.malformed;
  pageCounts.requiresAttention += orphan.malformed;
  const cumulative = addCounts(emptyCounts(), pageCounts);
  const result = buildPageResult({ mode: 'dry-run', pageCounts, cumulative, page, orphan, cursor: page.nextCursor });
  return {
    ...result,
    pageSize: boundedPageSize,
    evidenceDigest: boundedEvidenceDigest({ schemaVersion: PREPARATION_SCHEMA_VERSION, cumulative }),
  };
};

/** Complete bounded dry-run scan for the production CLI. */
const runNotificationRetentionPreflightAll = async ({
  db, nowMs = Date.now(), pageSize, maxPages = 2_000, rolloutRevision = null, budgets = {},
}) => {
  const boundedPageSize = clampPageSize(pageSize);
  const boundedMaxPages = Number.isSafeInteger(maxPages) && maxPages > 0
    ? Math.min(maxPages, 2_000)
    : 2_000;
  let cursor = readCursor(null);
  let orphanCursor = null;
  let preparationDone = false;
  let orphanDone = false;
  let pagesScanned = 0;
  let queries = 0;
  let maxRecordsInMemory = 0;
  let cumulative = emptyCounts();

  while (pagesScanned < boundedMaxPages && (!preparationDone || !orphanDone)) {
    const pageCounts = emptyCounts();
    if (!preparationDone && pagesScanned < boundedMaxPages) {
      const page = await loadPreparationPage({ db, nowMs, pageSize: boundedPageSize, cursor });
      const counts = unwrapPreparationCounts(await processPreparationPage({
        db, page, nowMs, apply: false,
      }));
      cumulative = addCounts(cumulative, counts);
      cursor = page.nextCursor;
      preparationDone = page.allStagesComplete;
      pagesScanned += 1;
      queries += 1;
      maxRecordsInMemory = Math.max(maxRecordsInMemory, page.recordsInMemory);
    }
    if (!orphanDone && pagesScanned < boundedMaxPages) {
      const orphan = await loadOrphanDiscoveryPage({
        db,
        nowMs,
        pageSize: clampPageSize(budgets.orphanPageSize, DEFAULT_RETENTION_BUDGETS.orphanPageSize),
        cursor: orphanCursor,
      });
      pageCounts.orphanAttemptsScanned = orphan.scanned;
      pageCounts.orphanAttemptsFound = orphan.found;
      pageCounts.orphanAttemptsMalformed = orphan.malformed;
      pageCounts.requiresAttention = orphan.malformed;
      cumulative = addCounts(cumulative, pageCounts);
      orphanCursor = orphan.nextCursor;
      orphanDone = !orphan.hasMore;
      pagesScanned += 1;
      queries += orphan.queries;
      maxRecordsInMemory = Math.max(maxRecordsInMemory, orphan.recordsInMemory);
    }
  }

  const hasMore = !preparationDone || !orphanDone;
  const preparationComplete = !hasMore && cumulative.requiresAttention === 0;
  return {
    mode: 'dry-run-complete',
    ...cumulative,
    cumulative,
    hasMore,
    preparationComplete,
    cursor: serializeCursor(cursor),
    orphanCursor: serializeOrphanCursor(orphanCursor),
    pagesScanned,
    queries,
    maxRecordsInMemory,
    pageSize: boundedPageSize,
    evidenceDigest: boundedEvidenceDigest({
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      rolloutRevision,
      cumulative,
      complete: preparationComplete,
    }),
  };
};

/**
 * Resumable preparation. Canonical boundary writes and scheduling are
 * idempotent; the durable progress cursor advances only through an exact
 * revision/cursor transaction, so stale operators cannot skip or regress work.
 * @param {{ db:any, nowMs?:number, apply?:boolean, pageSize?:number, cursor?:any,
 * expectedRolloutRevision?:number|null, budgets?:any }} options
 */
const runNotificationRetentionPreparation = async ({
  db, nowMs = Date.now(), apply = false, pageSize, cursor: rawCursor = null,
  expectedRolloutRevision = null, budgets = {},
}) => { // eslint-disable-line complexity -- authorization is checked at every write boundary
  if (apply && (!Number.isSafeInteger(expectedRolloutRevision)
    || expectedRolloutRevision < 0)) {
    return invalidPreparationResult('apply', 'expected_rollout_revision_required');
  }
  const authorizeWrite = async () => {
    const rollout = await readNotificationRetentionRollout({ db });
    return rollout.phase === 'legacy'
      && rollout.revision === expectedRolloutRevision;
  };
  if (apply && !(await authorizeWrite())) {
    return invalidPreparationResult('apply', 'rollout_changed');
  }
  const boundedPageSize = clampPageSize(pageSize);
  const snapshot = await db.ref(NOTIFICATION_RETENTION_PATHS.preparation).once('value');
  const persisted = normalizeProgress(snapshot.val());
  if (apply && persisted.rolloutRevision !== null
    && persisted.rolloutRevision !== expectedRolloutRevision && !budgets.restart) {
    return invalidPreparationResult('apply', 'rollout_revision_restart_required');
  }
  if (apply && rawCursor && !budgets.restart && serializeCursor(readCursor(rawCursor)) !== persisted.cursor) {
    return invalidPreparationResult('apply', 'cursor_conflict');
  }
  const base = persisted;
  const initialCursor = serializeCursor({ stage: 'ordinary', value: 0, key: null });
  const cursor = readCursor(rawCursor || (budgets.restart ? initialCursor : base.cursor));
  const mode = apply ? 'apply' : 'dry-run';
  if (!cursor) return invalidPreparationResult(mode, 'invalid_cursor');
  const { page, orphan } = await loadPreparationWork({
    db,
    nowMs,
    boundedPageSize,
    cursor,
    orphanCursor: budgets.restart ? null : readOrphanCursor(base.orphanCursor),
    budgets,
  });
  const processed = await processPreparationPage({
    db, page, nowMs, apply, authorizeWrite: apply ? authorizeWrite : null,
  });
  const pageCounts = unwrapPreparationCounts(processed);
  if (processed.rolloutChanged) {
    return {
      ...invalidPreparationResult(mode, 'rollout_changed'),
      ...pageCounts,
      cumulative: addCounts(budgets.restart ? emptyCounts() : base.cumulative, pageCounts),
      hasMore: true,
    };
  }
  pageCounts.orphanAttemptsScanned = orphan.scanned;
  pageCounts.orphanAttemptsFound = orphan.found;
  pageCounts.orphanAttemptsMalformed = orphan.malformed;
  pageCounts.requiresAttention += orphan.malformed;
  const cumulative = addCounts(budgets.restart ? emptyCounts() : base.cumulative, pageCounts);
  let result = buildPageResult({ mode, pageCounts, cumulative, page, orphan, cursor: page.nextCursor });
  const evidenceDigest = boundedEvidenceDigest({
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    rolloutRevision: expectedRolloutRevision,
    cumulative,
    complete: result.preparationComplete,
  });
  if (apply && (!(await authorizeWrite()) || !(await commitPreparationProgress({
    db, base, page, orphan, cumulative,
    preparationComplete: result.preparationComplete,
    evidenceDigest,
    nowMs,
    rolloutRevision: expectedRolloutRevision,
  })))) {
    const rolloutStillCurrent = await authorizeWrite();
    result = rolloutStillCurrent
      ? { ...result, hasMore: true, preparationComplete: false, progressConflict: true }
      : { ...result, hasMore: true, preparationComplete: false, reason: 'rollout_changed' };
  }
  return { ...result, pageSize: boundedPageSize, evidenceDigest };
};

module.exports = {
  loadOrphanDiscoveryPage,
  loadPreparationPage,
  normalizeProgress,
  readCursor,
  runNotificationRetentionPreflight,
  runNotificationRetentionPreflightAll,
  runNotificationRetentionPreparation,
  serializeCursor,
  snapshotEntriesInQueryOrder,
};
