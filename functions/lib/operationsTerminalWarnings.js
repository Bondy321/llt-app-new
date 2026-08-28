'use strict';

// @ts-check

const { createHash } = require('node:crypto');

const OPERATIONS_TERMINAL_WARNING_ROOT = 'operations_terminal_warnings/v1';
const OPERATIONS_TERMINAL_WARNING_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const WARNING_ID_PATTERN = /^warning_v1_[a-f0-9]{32}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]*$/;
const SAFE_IDENTIFIER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const WARNING_STATUSES = new Set(['open', 'acknowledged', 'resolved']);

/** @param {unknown} value @param {string} fallback @param {number} maxLength */
const boundedWarningCode = (value, fallback = 'operation_failed', maxLength = 80) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, maxLength);
  return normalized && SAFE_CODE_PATTERN.test(normalized) ? normalized : fallback;
};

/** @param {unknown} value */
const hashTerminalWarningIdentifier = (value) => createHash('sha256')
  .update(String(value ?? ''))
  .digest('hex')
  .slice(0, 24);

/** @param {Record<string, unknown>} identifiers */
const hashWarningIdentifiers = (identifiers) => {
  const entries = Object.entries(identifiers || {})
    .filter(([name, value]) => SAFE_IDENTIFIER_NAME_PATTERN.test(name)
      && value !== null && value !== undefined && String(value).length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new Error('Terminal warning requires at least one identifier');
  return Object.fromEntries(entries.map(([name, value]) => [name, hashTerminalWarningIdentifier(value)]));
};

/** @param {unknown} value @param {number} fallback */
const nonNegativeInteger = (value, fallback = 0) => (
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
);

/** @param {unknown} value @param {number} fallback */
const positiveInteger = (value, fallback) => (
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
);

/** @type {(...args: any[]) => any} */
const buildOperationsTerminalWarning = ({
  jobType,
  reason,
  identifiers,
  attemptCount = 0,
  firstAttemptAtMs,
  lastAttemptAtMs,
  expiresAtMs,
  nowMs = Date.now(),
  retentionMs = OPERATIONS_TERMINAL_WARNING_RETENTION_MS,
}) => {
  const safeJobType = boundedWarningCode(jobType, 'unknown_job_type', 64);
  const safeReason = boundedWarningCode(reason, 'retention_expired', 80);
  const identifierHashes = hashWarningIdentifiers(identifiers);
  const safeNowMs = positiveInteger(nowMs, Date.now());
  const safeExpiresAtMs = positiveInteger(expiresAtMs, safeNowMs);
  const safeFirstAttemptAtMs = positiveInteger(firstAttemptAtMs, safeNowMs);
  const safeLastAttemptAtMs = Math.max(
    safeFirstAttemptAtMs,
    positiveInteger(lastAttemptAtMs, safeFirstAttemptAtMs),
  );
  const safeRetentionMs = positiveInteger(retentionMs, OPERATIONS_TERMINAL_WARNING_RETENTION_MS);
  const warningFingerprint = JSON.stringify({
    jobType: safeJobType,
    identifierHashes,
    expiresAtMs: safeExpiresAtMs,
  });
  const warningId = `warning_v1_${createHash('sha256').update(warningFingerprint).digest('hex').slice(0, 32)}`;
  return {
    schemaVersion: 1,
    warningId,
    jobType: safeJobType,
    reason: safeReason,
    identifierHashes,
    attemptCount: nonNegativeInteger(attemptCount),
    firstAttemptAtMs: safeFirstAttemptAtMs,
    lastAttemptAtMs: safeLastAttemptAtMs,
    expiresAtMs: safeExpiresAtMs,
    createdAtMs: safeNowMs,
    updatedAtMs: safeNowMs,
    status: 'open',
    acknowledged: false,
    acknowledgedAtMs: null,
    acknowledgedByHash: null,
    resolved: false,
    resolvedAtMs: null,
    resolvedByHash: null,
    retainUntilMs: safeNowMs + safeRetentionMs,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const persistOperationsTerminalWarning = async ({ db, warning }) => {
  if (!db?.ref || !WARNING_ID_PATTERN.test(warning?.warningId || '')) {
    throw new Error('Invalid operations terminal warning persistence request');
  }
  const path = `${OPERATIONS_TERMINAL_WARNING_ROOT}/${warning.warningId}`;
  let created = false;
  const result = await db.ref(path).transaction((current) => {
    if (!current) {
      created = true;
      return warning;
    }
    if (current.warningId !== warning.warningId || current.jobType !== warning.jobType) return undefined;
    const currentStatus = WARNING_STATUSES.has(current.status) ? current.status : 'open';
    return {
      ...warning,
      ...current,
      attemptCount: Math.max(nonNegativeInteger(current.attemptCount), warning.attemptCount),
      firstAttemptAtMs: Math.min(
        positiveInteger(current.firstAttemptAtMs, warning.firstAttemptAtMs),
        warning.firstAttemptAtMs,
      ),
      lastAttemptAtMs: Math.max(
        positiveInteger(current.lastAttemptAtMs, warning.lastAttemptAtMs),
        warning.lastAttemptAtMs,
      ),
      updatedAtMs: Math.max(positiveInteger(current.updatedAtMs, warning.updatedAtMs), warning.updatedAtMs),
      retainUntilMs: Math.max(
        positiveInteger(current.retainUntilMs, warning.retainUntilMs),
        warning.retainUntilMs,
      ),
      status: currentStatus,
      acknowledged: currentStatus === 'acknowledged' || currentStatus === 'resolved'
        || current.acknowledged === true,
      resolved: currentStatus === 'resolved' || current.resolved === true,
    };
  }, undefined, false);
  if (!result?.committed) throw new Error('Operations terminal warning write was contended');
  return { created, path, warning: result.snapshot.val() };
};

/** @param {unknown} current @param {Record<string, unknown>} sourceIdentity */
const sourceMatchesIdentity = (current, sourceIdentity) => Boolean(current && Object.entries(sourceIdentity || {})
  .every(([field, expected]) => current[field] === expected));

/** @param {unknown} current @param {unknown} claimed */
const sourceMatchesClaimedAttempt = (current, claimed) => Boolean(current && claimed && [
  'attemptCount',
  'firstAttemptAtMs',
  'lastAttemptAtMs',
  'lastFailureReason',
].every((field) => current[field] === claimed[field]));

/**
 * Claims the exact observed source job, persists its deterministic warning and
 * only then compare-deletes that claimed source. A warning persistence failure
 * intentionally leaves the claimed source for a later idempotent retry.
 *
 * @type {(...args: any[]) => Promise<any>}
 */
const terminalizeOperationJob = async ({
  db,
  sourcePath,
  observedJob,
  sourceIdentity,
  jobType,
  reason = 'retention_expired',
  identifiers,
  nowMs = Date.now(),
  retentionMs = OPERATIONS_TERMINAL_WARNING_RETENTION_MS,
}) => {
  if (!db?.ref || typeof sourcePath !== 'string' || !sourcePath
    || !observedJob || typeof observedJob !== 'object'
    || !sourceIdentity || typeof sourceIdentity !== 'object') {
    throw new Error('Invalid terminal operation job request');
  }
  const initialWarning = buildOperationsTerminalWarning({
    jobType,
    reason,
    identifiers,
    attemptCount: observedJob.attemptCount,
    firstAttemptAtMs: observedJob.firstAttemptAtMs || observedJob.createdAtMs,
    lastAttemptAtMs: observedJob.lastAttemptAtMs || observedJob.createdAtMs,
    expiresAtMs: observedJob.expiresAtMs,
    nowMs,
    retentionMs,
  });
  const sourceRef = db.ref(sourcePath);
  const claimed = await sourceRef.transaction((current) => {
    if (!sourceMatchesIdentity(current, sourceIdentity)
      || !Number.isSafeInteger(current.expiresAtMs)
      || current.expiresAtMs > nowMs) return undefined;
    if (current.terminalWarningId && current.terminalWarningId !== initialWarning.warningId) return undefined;
    return {
      ...current,
      terminalWarningId: initialWarning.warningId,
      terminalizationReason: initialWarning.reason,
      terminalizationStartedAtMs: current.terminalizationStartedAtMs || nowMs,
    };
  }, undefined, false);
  if (!claimed?.committed) return { status: 'source_changed', terminalized: false, sourceDeleted: false };

  const claimedJob = claimed.snapshot.val() || observedJob;
  const warning = buildOperationsTerminalWarning({
    jobType,
    reason,
    identifiers,
    attemptCount: claimedJob.attemptCount,
    firstAttemptAtMs: claimedJob.firstAttemptAtMs || claimedJob.createdAtMs,
    lastAttemptAtMs: claimedJob.lastAttemptAtMs || claimedJob.createdAtMs,
    expiresAtMs: claimedJob.expiresAtMs,
    nowMs,
    retentionMs,
  });
  const persisted = await persistOperationsTerminalWarning({ db, warning });
  const deleted = await sourceRef.transaction((current) => (
    sourceMatchesIdentity(current, sourceIdentity)
      && current.terminalWarningId === warning.warningId
      && sourceMatchesClaimedAttempt(current, claimedJob) ? null : undefined
  ), undefined, false);
  return {
    status: 'terminalized',
    terminalized: true,
    sourceDeleted: deleted?.committed === true,
    warningCreated: persisted.created,
    warningId: warning.warningId,
    warningPath: persisted.path,
  };
};

module.exports = {
  OPERATIONS_TERMINAL_WARNING_RETENTION_MS,
  OPERATIONS_TERMINAL_WARNING_ROOT,
  boundedWarningCode,
  buildOperationsTerminalWarning,
  hashTerminalWarningIdentifier,
  persistOperationsTerminalWarning,
  terminalizeOperationJob,
};
