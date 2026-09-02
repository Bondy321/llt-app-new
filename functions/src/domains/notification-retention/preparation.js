'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
} = require('./constants');
const { compiledRetentionProtocol, protocolEvidenceMatches } = require('./protocol');
const { readNotificationRetentionRollout } = require('./state');
const { transactionWithAuthoritativeExistingValue } = require('./retentionEngineRuntime');

const PREPARATION_SCHEMA_VERSION = 1;
const {
  addCounts,
  clampPageSize,
  emptyCounts,
  loadAttemptMigrationPage,
  loadOrphanDiscoveryPage,
  loadPreparationPage,
  processAttemptMigrationPage,
  processPreparationPage,
  readCursor,
  serializeCursor,
  snapshotEntriesInQueryOrder,
  unwrapPreparationCounts,
} = require('./preparationPages');

const boundedEvidenceDigest = (value) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex').slice(0, 32);

const normalizeProgress = (value) => {
  const cursor = readCursor(value?.cursor);
  if (!value || value.schemaVersion !== PREPARATION_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !cursor) {
    return {
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      revision: 0,
      rolloutRevision: null,
      cursor: serializeCursor({ stage: 'ordinary', value: 0, key: null }),
      attemptCursor: null,
      attemptScanEndAtMs: null,
      attemptMigrationComplete: false,
      orphanCursor: null,
      cumulative: emptyCounts(),
      status: 'not_started',
      preparationComplete: false,
      evidenceDigest: null,
      ...compiledRetentionProtocol(),
    };
  }
  return {
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    revision: value.revision,
    rolloutRevision: Number.isSafeInteger(value.rolloutRevision) && value.rolloutRevision >= 0
      ? value.rolloutRevision
      : null,
    cursor: serializeCursor(cursor),
    attemptCursor: serializeAttemptCursor(readAttemptCursor(value.attemptCursor)),
    attemptScanEndAtMs: Number.isSafeInteger(value.attemptScanEndAtMs)
      && value.attemptScanEndAtMs > 0 ? value.attemptScanEndAtMs : null,
    attemptMigrationComplete: value.attemptMigrationComplete === true,
    orphanCursor: value.orphanCursor || null,
    cumulative: addCounts(emptyCounts(), value.cumulative),
    status: value.status || 'processing',
    preparationComplete: value.preparationComplete === true,
    evidenceDigest: typeof value.evidenceDigest === 'string' ? value.evidenceDigest : null,
    retentionEngineProtocolId: value.retentionEngineProtocolId || null,
    engineSourceDigest: value.engineSourceDigest || null,
    engineRulesDigest: value.engineRulesDigest || null,
    engineTriggerDigest: value.engineTriggerDigest || null,
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

const readAttemptCursor = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string' || !parsed[1]) {
      return null;
    }
    const cursorValue = parsed[0];
    return cursorValue === null || ['boolean', 'number', 'string'].includes(typeof cursorValue)
      ? { value: cursorValue, key: parsed[1] }
      : null;
  } catch (_error) {
    return readOrphanCursor(value);
  }
};

const serializeAttemptCursor = (cursor) => cursor
  ? JSON.stringify([cursor.value ?? null, cursor.key])
  : null;

const buildPageResult = ({
  mode, pageCounts, cumulative, page, attempt, orphan, cursor, progressConflict = false,
}) => ({
  mode,
  ...compiledRetentionProtocol(),
  ...pageCounts,
  cumulative,
  hasMore: progressConflict || !page.allStagesComplete || !attempt.complete || orphan.hasMore,
  cursor: serializeCursor(cursor),
  attemptCursor: serializeAttemptCursor(attempt.nextCursor),
  attemptScanEndAtMs: attempt.scanEndAtMs,
  attemptMigrationComplete: attempt.complete,
  orphanCursor: serializeOrphanCursor(orphan.nextCursor),
  queries: 1 + attempt.queries + orphan.queries,
  maxRecordsInMemory: Math.max(page.recordsInMemory, attempt.recordsInMemory, orphan.recordsInMemory),
  preparationComplete: !progressConflict && page.allStagesComplete && attempt.complete && !orphan.hasMore
    && cumulative.requiresAttention === 0,
  progressConflict,
});

const invalidPreparationResult = (mode, reason) => ({
  mode,
  ...compiledRetentionProtocol(),
  hasMore: reason === 'cursor_conflict',
  preparationComplete: false,
  progressConflict: reason === 'cursor_conflict',
  reason,
});

const loadPreparationWork = async ({
  db, nowMs, boundedPageSize, cursor, attemptCursor, attemptScanEndAtMs,
  attemptMigrationComplete, orphanCursor, budgets,
}) => {
  const page = await loadPreparationPage({ db, nowMs, pageSize: boundedPageSize, cursor });
  if (!attemptMigrationComplete) {
    const loaded = await loadAttemptMigrationPage({
      db, pageSize: boundedPageSize, cursor: attemptCursor, scanEndAtMs: attemptScanEndAtMs,
    });
    return {
      page,
      attempt: { ...loaded, scanEndAtMs: attemptScanEndAtMs, complete: !loaded.hasMore },
      orphan: {
        scanned: 0, found: 0, malformed: 0, hasMore: true, nextCursor: orphanCursor,
        recordsInMemory: 0, queries: 0,
      },
    };
  }
  const orphan = await loadOrphanDiscoveryPage({
    db, nowMs,
    pageSize: clampPageSize(budgets.orphanPageSize, DEFAULT_RETENTION_BUDGETS.orphanPageSize),
    cursor: orphanCursor,
  });
  return {
    page,
    attempt: {
      nextCursor: attemptCursor, scanEndAtMs: attemptScanEndAtMs, complete: true,
      recordsInMemory: 0, queries: 0,
    },
    orphan,
  };
};

const commitPreparationProgress = async ({
  db, base, page, attempt, orphan, cumulative, preparationComplete, evidenceDigest, nowMs,
  rolloutRevision,
}) => {
  let advanced = false;
  const progressRef = db.ref(NOTIFICATION_RETENTION_PATHS.preparation);
  const updateProgress = (currentValue) => {
    const current = normalizeProgress(currentValue);
    if (current.revision !== base.revision || current.cursor !== base.cursor
      || current.attemptCursor !== base.attemptCursor
      || current.attemptScanEndAtMs !== base.attemptScanEndAtMs
      || current.attemptMigrationComplete !== base.attemptMigrationComplete
      || current.orphanCursor !== base.orphanCursor
      || current.rolloutRevision !== base.rolloutRevision) return undefined;
    advanced = true;
    return {
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      revision: current.revision + 1,
      rolloutRevision,
      cursor: serializeCursor(page.nextCursor),
      attemptCursor: serializeAttemptCursor(attempt.nextCursor),
      attemptScanEndAtMs: attempt.scanEndAtMs,
      attemptMigrationComplete: attempt.complete,
      orphanCursor: serializeOrphanCursor(orphan.nextCursor),
      cumulative,
      status: preparationComplete ? 'complete'
        : (cumulative.requiresAttention > 0 ? 'blocked' : 'processing'),
      preparationComplete,
      evidenceDigest,
      ...compiledRetentionProtocol(),
      updatedAtMs: nowMs,
    };
  };
  const progress = base.revision > 0
    ? await transactionWithAuthoritativeExistingValue(progressRef, updateProgress)
    : await progressRef.transaction(updateProgress, undefined, false);
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
  const scanEndAtMs = Number.isSafeInteger(budgets.attemptScanEndAtMs)
    ? budgets.attemptScanEndAtMs : nowMs;
  const attemptPage = await loadAttemptMigrationPage({
    db, pageSize: boundedPageSize, cursor: readAttemptCursor(budgets.attemptCursor), scanEndAtMs,
  });
  const attemptCounts = unwrapPreparationCounts(await processAttemptMigrationPage({
    db, page: attemptPage, nowMs, apply: false,
  }));
  const attempt = {
    ...attemptPage, scanEndAtMs, complete: !attemptPage.hasMore,
  };
  Object.assign(pageCounts, addCounts(pageCounts, attemptCounts));
  const orphan = attempt.complete ? await loadOrphanDiscoveryPage({
    db, nowMs,
    pageSize: clampPageSize(budgets.orphanPageSize, DEFAULT_RETENTION_BUDGETS.orphanPageSize),
    cursor: readOrphanCursor(budgets.orphanCursor),
  }) : {
    scanned: 0, found: 0, malformed: 0, hasMore: true,
    nextCursor: readOrphanCursor(budgets.orphanCursor), recordsInMemory: 0, queries: 0,
  };
  pageCounts.orphanAttemptsScanned = orphan.scanned;
  pageCounts.orphanAttemptsFound = orphan.found;
  pageCounts.orphanAttemptsMalformed = orphan.malformed;
  pageCounts.requiresAttention += orphan.malformed;
  const cumulative = addCounts(emptyCounts(), pageCounts);
  const result = buildPageResult({
    mode: 'dry-run', pageCounts, cumulative, page, attempt, orphan, cursor: page.nextCursor,
  });
  return {
    ...result,
    pageSize: boundedPageSize,
    evidenceDigest: boundedEvidenceDigest({
      schemaVersion: PREPARATION_SCHEMA_VERSION, ...compiledRetentionProtocol(), cumulative,
    }),
  };
};

/** Complete bounded dry-run scan for the production CLI. */
const runNotificationRetentionPreflightAll = async ({
  db, nowMs = Date.now(), pageSize, maxPages = 2_000, rolloutRevision = null, budgets = {},
}) => { // eslint-disable-line complexity -- each resumable discovery stage has an independent bound
  const boundedPageSize = clampPageSize(pageSize);
  const boundedMaxPages = Number.isSafeInteger(maxPages) && maxPages > 0
    ? Math.min(maxPages, 2_000)
    : 2_000;
  let cursor = readCursor(null);
  let attemptCursor = null;
  let orphanCursor = null;
  let preparationDone = false;
  let attemptDone = false;
  let orphanDone = false;
  let pagesScanned = 0;
  let queries = 0;
  let maxRecordsInMemory = 0;
  let cumulative = emptyCounts();

  while (pagesScanned < boundedMaxPages && (!preparationDone || !attemptDone || !orphanDone)) {
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
    if (!attemptDone && pagesScanned < boundedMaxPages) {
      const attempt = await loadAttemptMigrationPage({
        db, pageSize: boundedPageSize, cursor: attemptCursor, scanEndAtMs: nowMs,
      });
      const counts = unwrapPreparationCounts(await processAttemptMigrationPage({
        db, page: attempt, nowMs, apply: false,
      }));
      cumulative = addCounts(cumulative, counts);
      attemptCursor = attempt.nextCursor;
      attemptDone = !attempt.hasMore;
      pagesScanned += 1;
      queries += attempt.queries;
      maxRecordsInMemory = Math.max(maxRecordsInMemory, attempt.recordsInMemory);
    }
    if (attemptDone && !orphanDone && pagesScanned < boundedMaxPages) {
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

  const hasMore = !preparationDone || !attemptDone || !orphanDone;
  const preparationComplete = !hasMore && cumulative.requiresAttention === 0;
  return {
    mode: 'dry-run-complete',
    ...compiledRetentionProtocol(),
    ...cumulative,
    cumulative,
    hasMore,
    preparationComplete,
    cursor: serializeCursor(cursor),
    attemptCursor: serializeAttemptCursor(attemptCursor),
    attemptScanEndAtMs: nowMs,
    attemptMigrationComplete: attemptDone,
    orphanCursor: serializeOrphanCursor(orphanCursor),
    pagesScanned,
    queries,
    maxRecordsInMemory,
    pageSize: boundedPageSize,
    evidenceDigest: boundedEvidenceDigest({
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      ...compiledRetentionProtocol(),
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
    return rollout.phase === 'paused' && protocolEvidenceMatches(rollout)
      && rollout.revision === expectedRolloutRevision;
  };
  if (apply && !(await authorizeWrite())) {
    return invalidPreparationResult('apply', 'rollout_changed');
  }
  const boundedPageSize = clampPageSize(pageSize);
  const snapshot = await db.ref(NOTIFICATION_RETENTION_PATHS.preparation).once('value');
  const persisted = normalizeProgress(snapshot.val());
  if (apply && persisted.revision > 0 && !protocolEvidenceMatches(persisted) && !budgets.restart) {
    return invalidPreparationResult('apply', 'protocol_restart_required');
  }
  if (apply && persisted.rolloutRevision !== null
    && persisted.rolloutRevision !== expectedRolloutRevision && !budgets.restart) {
    return invalidPreparationResult('apply', 'rollout_revision_restart_required');
  }
  if (apply && rawCursor && !budgets.restart && serializeCursor(readCursor(rawCursor)) !== persisted.cursor) {
    return invalidPreparationResult('apply', 'cursor_conflict');
  }
  const base = persisted;
  const initialCursor = serializeCursor({ stage: 'ordinary', value: 0, key: null });
  const cursor = readCursor(budgets.restart ? initialCursor : (rawCursor || base.cursor));
  const attemptScanEndAtMs = budgets.restart ? nowMs : (base.attemptScanEndAtMs || nowMs);
  const attemptMigrationComplete = budgets.restart ? false : base.attemptMigrationComplete;
  const attemptCursor = budgets.restart ? null : readAttemptCursor(base.attemptCursor);
  const mode = apply ? 'apply' : 'dry-run';
  if (!cursor) return invalidPreparationResult(mode, 'invalid_cursor');
  const { page, attempt, orphan } = await loadPreparationWork({
    db,
    nowMs,
    boundedPageSize,
    cursor,
    attemptCursor,
    attemptScanEndAtMs,
    attemptMigrationComplete,
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
  const attemptProcessed = attemptMigrationComplete
    ? { counts: emptyCounts(), rolloutChanged: false, attemptConflict: false }
    : await processAttemptMigrationPage({
      db, page: attempt, nowMs, apply, authorizeWrite: apply ? authorizeWrite : null,
    });
  const attemptCounts = unwrapPreparationCounts(attemptProcessed);
  const combinedPageCounts = addCounts(pageCounts, attemptCounts);
  if (attemptProcessed.rolloutChanged) {
    return {
      ...invalidPreparationResult(mode, 'rollout_changed'),
      ...combinedPageCounts,
      cumulative: addCounts(budgets.restart ? emptyCounts() : base.cumulative, combinedPageCounts),
      hasMore: true,
    };
  }
  if (attemptProcessed.attemptConflict) {
    return {
      ...invalidPreparationResult(mode, 'attempt_changed'),
      ...combinedPageCounts,
      cumulative: addCounts(budgets.restart ? emptyCounts() : base.cumulative, combinedPageCounts),
      hasMore: true,
      progressConflict: true,
    };
  }
  combinedPageCounts.orphanAttemptsScanned = orphan.scanned;
  combinedPageCounts.orphanAttemptsFound = orphan.found;
  combinedPageCounts.orphanAttemptsMalformed = orphan.malformed;
  combinedPageCounts.requiresAttention += orphan.malformed;
  const cumulative = addCounts(budgets.restart ? emptyCounts() : base.cumulative, combinedPageCounts);
  let result = buildPageResult({
    mode, pageCounts: combinedPageCounts, cumulative, page, attempt, orphan, cursor: page.nextCursor,
  });
  const evidenceDigest = boundedEvidenceDigest({
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    ...compiledRetentionProtocol(),
    rolloutRevision: expectedRolloutRevision,
    cumulative,
    complete: result.preparationComplete,
  });
  if (apply && (!(await authorizeWrite()) || !(await commitPreparationProgress({
    db, base, page, attempt, orphan, cumulative,
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
