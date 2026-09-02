'use strict';

// @ts-check

const { DEFAULT_RETENTION_BUDGETS } = require('./constants');

const QUEUE_ROOTS = Object.freeze({
  fanout: 'notification_job_fanout_queue',
  receipt: 'notification_receipt_due_queue',
  retry: 'notification_attempt_retry_queue',
});
const PHASES = Object.freeze(['attempts', 'job_children', 'source_records', 'finalize', 'completed']);
const METRIC_NAMES = Object.freeze([
  'queries', 'transactions', 'jobsDiscovered', 'jobsClaimed', 'jobsCompleted',
  'jobsDeferred', 'jobsRequiresAttention', 'queueEntriesRemoved',
  'attemptPagesQueried', 'attemptsScanned', 'attemptsDeleted',
  'retryPointersDeleted', 'receiptPointersDeleted', 'fanoutPointersDeleted',
  'previewsDeleted', 'requeueJobsDeleted', 'marketingDetailsDeleted',
  'orphanAttemptsScanned', 'orphanAttemptsDeleted', 'orphanAttemptsMalformed',
  'terminalRepairsScanned', 'terminalRepairsScheduled', 'terminalRepairFailures',
  'failures', 'updatePaths', 'maxUpdatePaths', 'maxRecordsInMemory',
  'oldestDueAgeMs', 'shadowEligible', 'shadowLegacyEligible',
  'shadowMismatches', 'legacyDeletionPaths',
  'rolloutAuthorizationFailures',
]);

const createMetrics = () => Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]));
const safeInteger = (value, fallback = 0) => Number.isSafeInteger(value) ? Number(value) : fallback;
const positiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback
);
const maxMetric = (metrics, name, value) => {
  metrics[name] = Math.max(safeInteger(metrics[name]), safeInteger(value));
};

// The Admin RTDB client can invoke a transaction handler with an uncached local
// null before it has fetched the authoritative server value. Returning
// undefined from that first invocation aborts the transaction without a server
// round trip. Existing-record compare-and-swap operations use this helper to
// submit a harmless null probe first; an existing server value then causes the
// handler to be retried with that authoritative value. This helper must not be
// used for create-if-absent transactions because a genuinely absent path will
// commit the null probe as a no-op.
const transactionWithAuthoritativeExistingValue = async (ref, updater) => {
  let awaitingAuthoritativeValue = true;
  return ref.transaction((current) => {
    if (awaitingAuthoritativeValue && (current === null || current === undefined)) {
      awaitingAuthoritativeValue = false;
      return null;
    }
    awaitingAuthoritativeValue = false;
    return updater(current);
  }, undefined, false);
};

const normalizeBudgets = (input = {}) => {
  const pageSize = positiveInteger(input.pageSize, DEFAULT_RETENTION_BUDGETS.pageSize, 250);
  const maxAttempts = positiveInteger(
    input.maxAttempts ?? input.maxAttemptsPerInvocation,
    DEFAULT_RETENTION_BUDGETS.maxAttemptsPerInvocation,
    5_000,
  );
  const maxJobs = positiveInteger(
    input.maxJobs ?? input.maxJobsPerInvocation,
    DEFAULT_RETENTION_BUDGETS.maxJobsPerInvocation,
    25,
  );
  return {
    pageSize,
    queryLimit: pageSize + 1,
    maxAttempts,
    maxJobs,
    maxAttemptPages: positiveInteger(
      input.maxAttemptPages ?? input.maxAttemptPagesPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxAttemptPagesPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxAttemptPagesPerInvocation,
    ),
    maxAttemptPagesPerJob: positiveInteger(
      input.maxAttemptPagesPerJob,
      DEFAULT_RETENTION_BUDGETS.maxAttemptPagesPerJob,
      DEFAULT_RETENTION_BUDGETS.maxAttemptPagesPerInvocation,
    ),
    maxAttemptsPerJob: positiveInteger(
      input.maxAttemptsPerJob ?? input.maxAttemptsPerJobPerCycle,
      DEFAULT_RETENTION_BUDGETS.maxAttemptsPerJobPerCycle,
      maxAttempts,
    ),
    maxUpdatePaths: positiveInteger(
      input.maxUpdatePaths,
      DEFAULT_RETENTION_BUDGETS.maxUpdatePaths,
      500,
    ),
    orphanPageSize: positiveInteger(
      input.orphanPageSize,
      DEFAULT_RETENTION_BUDGETS.orphanPageSize,
      250,
    ),
    maxOrphanPages: positiveInteger(
      input.maxOrphanPages ?? input.maxOrphanPagesPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxOrphanPagesPerInvocation,
      8,
    ),
    auxiliaryPageSize: positiveInteger(
      input.auxiliaryPageSize,
      DEFAULT_RETENTION_BUDGETS.auxiliaryPageSize,
      250,
    ),
    maxAuxiliaryPages: positiveInteger(
      input.maxAuxiliaryPages ?? input.maxAuxiliaryPagesPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxAuxiliaryPagesPerInvocation,
      8,
    ),
    maxShadowJobs: positiveInteger(
      input.maxShadowJobs ?? input.maxShadowJobsPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxShadowJobsPerInvocation,
      DEFAULT_RETENTION_BUDGETS.maxShadowJobsPerInvocation,
    ),
    internalDeadlineMs: positiveInteger(
      input.internalDeadlineMs,
      DEFAULT_RETENTION_BUDGETS.internalDeadlineMs,
      420_000,
    ),
    leaseMs: positiveInteger(input.leaseMs, DEFAULT_RETENTION_BUDGETS.leaseMs, 420_000),
    destructiveCommitLeaseMs: DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs,
    leaseRenewThresholdMs: positiveInteger(
      input.leaseRenewThresholdMs,
      DEFAULT_RETENTION_BUDGETS.leaseRenewThresholdMs,
      DEFAULT_RETENTION_BUDGETS.leaseMs,
    ),
  };
};

const orderedEntries = (snapshot, fallbackComparator = ([left], [right]) => left.localeCompare(right)) => {
  const entries = [];
  if (snapshot && typeof snapshot.forEach === 'function') {
    snapshot.forEach((child) => {
      entries.push([child.key, child.val()]);
      return false;
    });
    return entries;
  }
  return Object.entries(snapshot?.val?.() || {}).sort(fallbackComparator);
};

module.exports = {
  PHASES,
  QUEUE_ROOTS,
  createMetrics,
  maxMetric,
  normalizeBudgets,
  orderedEntries,
  safeInteger,
  transactionWithAuthoritativeExistingValue,
};
