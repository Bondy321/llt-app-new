'use strict';

// @ts-check

const {
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
} = require('../../../lib/operationsTerminalWarnings');
const {
  DEFAULT_RETENTION_BUDGETS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
} = require('./constants');
const { classifyNotificationRetentionEligibility } = require('./eligibility');
const { transactionWithAuthoritativeExistingValue } = require('./retentionEngineRuntime');
const { ensureNotificationRetentionScheduled } = require('./state');

const PREPARATION_STAGES = new Set(['ordinary', 'privacy']);
const NON_TERMINAL_NOTIFICATION_ATTEMPT_STATUSES = new Set([
  'prepared', 'request_started', 'receipt_pending', 'retrying',
]);
const INVALID_FIREBASE_KEY = /[.#$\[\]\/]/;

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
  attemptsScanned: 0,
  attemptBoundariesMaterialized: 0,
  attemptBoundariesAlreadyPrepared: 0,
  attemptNonTerminalExcluded: 0,
  attemptMigrationWarnings: 0,
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
  const result = await transactionWithAuthoritativeExistingValue(
    db.ref(`notification_jobs/${jobId}`), (current) => {
    if (!current || current.jobId !== jobId || current.status !== observed.status
      || current.completedAtMs !== observed.completedAtMs) return undefined;
    if (Number.isSafeInteger(current.retentionDueAtMs) && current.retentionDueAtMs > 0) {
      return current.retentionDueAtMs === retentionDueAtMs ? current : undefined;
    }
    changed = true;
    return { ...current, retentionDueAtMs };
    },
  );
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

const validFirebaseKey = (value) => typeof value === 'string' && value.length > 0
  && value.length <= 768 && !INVALID_FIREBASE_KEY.test(value);

const loadAttemptMigrationPage = async ({ db, pageSize, cursor, scanEndAtMs }) => {
  let query = db.ref('notification_delivery_attempts').orderByChild('updatedAtMs');
  query = cursor?.key
    ? callQuery(query, 'startAfter', [cursor.value, cursor.key])
    : query;
  // A numeric endAt would silently exclude malformed string/object timestamps,
  // so this bounded cursor walks the complete RTDB type ordering. The captured
  // scan time remains evidence, not an authority boundary.
  query = query.limitToFirst(pageSize + 1);
  const entries = snapshotEntriesInQueryOrder(await query.once('value'))
    .filter(([key, attempt]) => !cursor?.key
      || compareFirebaseCursorValues(attempt?.updatedAtMs ?? null, cursor.value) > 0
      || (compareFirebaseCursorValues(attempt?.updatedAtMs ?? null, cursor.value) === 0
        && key > cursor.key));
  const selected = entries.slice(0, pageSize);
  const last = selected.at(-1);
  const lastValue = last?.[1]?.updatedAtMs ?? null;
  // RTDB rejects object query endpoints. If an object-valued timestamp spans
  // another page, stop on the first bounded warning instead of claiming the
  // migration completed or skipping unseen malformed records.
  const cursorSupported = lastValue === null
    || ['boolean', 'number', 'string'].includes(typeof lastValue);
  const cursorBlocked = entries.length > pageSize && !cursorSupported;
  return {
    selected,
    hasMore: entries.length > pageSize || cursorBlocked,
    nextCursor: last && !cursorBlocked ? { value: lastValue, key: last[0] } : cursor,
    cursorBlocked,
    scanEndAtMs,
    recordsInMemory: Math.min(entries.length, pageSize + 1),
    queries: 1,
  };
};

const compareFirebaseCursorValues = (left, right) => {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (typeof left === 'boolean') return -1;
  if (typeof right === 'boolean') return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return String(left).localeCompare(String(right));
};

// eslint-disable-next-line complexity -- every historical schema and boundary branch fails closed
const inspectHistoricalAttempt = (attemptId, attempt) => {
  if (!validFirebaseKey(attemptId) || ![1, 2].includes(attempt?.schemaVersion)
    || attempt?.attemptId !== attemptId
    || !validFirebaseKey(attempt?.jobId)
    || !Number.isSafeInteger(attempt?.createdAtMs) || attempt.createdAtMs <= 0
    || !Number.isSafeInteger(attempt?.updatedAtMs) || attempt.updatedAtMs < attempt.createdAtMs) {
    return 'malformed';
  }
  if (TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(attempt.status)) {
    const retentionDueAtMs = attempt.updatedAtMs + RETENTION_MS;
    if (!Number.isSafeInteger(retentionDueAtMs)) return 'malformed';
    if (Number.isSafeInteger(attempt.retentionDueAtMs)
      && attempt.retentionDueAtMs >= retentionDueAtMs) {
      return 'prepared';
    }
    if (attempt.retentionDueAtMs !== undefined && attempt.retentionDueAtMs !== null) {
      return 'malformed';
    }
    return 'missing';
  }
  return NON_TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(attempt.status)
    ? 'nonterminal'
    : 'malformed';
};

const materializeAttemptBoundary = async ({ db, attemptId, observed }) => {
  const retentionDueAtMs = observed.updatedAtMs + RETENTION_MS;
  let changed = false;
  const result = await transactionWithAuthoritativeExistingValue(
    db.ref(`notification_delivery_attempts/${attemptId}`), (current) => {
    if (!current || ![1, 2].includes(current.schemaVersion)
      || current.attemptId !== attemptId || current.jobId !== observed.jobId
      || current.status !== observed.status || current.createdAtMs !== observed.createdAtMs
      || current.updatedAtMs !== observed.updatedAtMs) return undefined;
    const currentBoundary = current.updatedAtMs + RETENTION_MS;
    if (!Number.isSafeInteger(currentBoundary)) return undefined;
    if (Number.isSafeInteger(current.retentionDueAtMs)
      && current.retentionDueAtMs >= currentBoundary) return current;
    if (current.retentionDueAtMs !== undefined && current.retentionDueAtMs !== null) {
      return undefined;
    }
    changed = true;
    return { ...current, retentionDueAtMs };
    },
  );
  return { committed: Boolean(result?.committed), changed };
};

const persistAttemptMigrationWarning = async ({ db, attemptId, observed, nowMs }) => {
  const warning = buildOperationsTerminalWarning({
    jobType: 'notification_retention_preparation',
    reason: 'unsafe_historical_attempt',
    identifiers: { attemptId },
    attemptCount: 1,
    firstAttemptAtMs: Number.isSafeInteger(observed?.createdAtMs) ? observed.createdAtMs : nowMs,
    lastAttemptAtMs: Number.isSafeInteger(observed?.updatedAtMs) ? observed.updatedAtMs : nowMs,
    expiresAtMs: nowMs,
    nowMs,
  });
  await persistOperationsTerminalWarning({ db, warning });
};

const processAttemptMigrationPage = async ({
  db, page, nowMs, apply, authorizeWrite = null,
}) => {
  const counts = emptyCounts();
  counts.attemptsScanned = page.selected.length;
  for (const [attemptId, observed] of page.selected) {
    const inspection = inspectHistoricalAttempt(attemptId, observed);
    if (inspection === 'nonterminal') {
      counts.attemptNonTerminalExcluded += 1;
      continue;
    }
    if (inspection === 'prepared') {
      counts.attemptBoundariesAlreadyPrepared += 1;
      continue;
    }
    if (inspection === 'malformed') {
      counts.attemptMigrationWarnings += 1;
      counts.requiresAttention += 1;
      if (apply) {
        if (authorizeWrite && !(await authorizeWrite())) return { counts, rolloutChanged: true };
        await persistAttemptMigrationWarning({ db, attemptId, observed, nowMs });
      }
      continue;
    }
    counts.attemptBoundariesMaterialized += 1;
    if (!apply) continue;
    if (authorizeWrite && !(await authorizeWrite())) return { counts, rolloutChanged: true };
    const materialized = await materializeAttemptBoundary({ db, attemptId, observed });
    if (!materialized.committed) {
      counts.attemptBoundariesMaterialized -= 1;
      counts.attemptMigrationWarnings += 1;
      counts.requiresAttention += 1;
      if (authorizeWrite && !(await authorizeWrite())) return { counts, rolloutChanged: true };
      await persistAttemptMigrationWarning({ db, attemptId, observed, nowMs });
      continue;
    }
    if (!materialized.changed) {
      counts.attemptBoundariesMaterialized -= 1;
      counts.attemptBoundariesAlreadyPrepared += 1;
    }
  }
  return { counts, rolloutChanged: false, attemptConflict: false };
};

module.exports = {
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
};
