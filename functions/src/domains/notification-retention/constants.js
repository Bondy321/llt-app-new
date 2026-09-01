'use strict';

// @ts-check

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const NOTIFICATION_RETENTION_ROOT = 'notification_retention/v1';
const NOTIFICATION_RETENTION_ROLLOUT_ROOT = 'notification_retention_rollout/v1';

const NOTIFICATION_RETENTION_PATHS = Object.freeze({
  root: NOTIFICATION_RETENTION_ROOT,
  jobs: `${NOTIFICATION_RETENTION_ROOT}/jobs`,
  queue: `${NOTIFICATION_RETENTION_ROOT}/queue`,
  repair: `${NOTIFICATION_RETENTION_ROOT}/repair`,
  preparation: `${NOTIFICATION_RETENTION_ROOT}/preparation`,
  evidence: `${NOTIFICATION_RETENTION_ROOT}/evidence`,
  canaryFixture: `${NOTIFICATION_RETENTION_ROOT}/evidence/canary_fixture`,
  rollout: NOTIFICATION_RETENTION_ROLLOUT_ROOT,
});

const ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES = new Set([
  'ticket_rejected',
  'provider_accepted',
  'provider_rejected',
  'partial',
  'submission_unknown',
  'expired',
  'no_recipients',
]);

const TERMINAL_NOTIFICATION_ATTEMPT_STATUSES = new Set([
  'ticket_rejected',
  'provider_accepted',
  'provider_rejected',
  'submission_unknown',
  'expired',
  'superseded',
]);

const NOTIFICATION_RETENTION_ROLLOUT_PHASES = new Set([
  'legacy',
  'shadow',
  'compactor',
]);

const DEFAULT_RETENTION_BUDGETS = Object.freeze({
  pageSize: 250,
  queryLimit: 251,
  maxAttemptsPerInvocation: 5000,
  maxJobsPerInvocation: 25,
  // Compatibility aliases retained for existing scale tooling.
  maxAttemptsPerJob: 5000,
  maxJobsPerCycle: 25,
  maxAttemptPagesPerJob: 4,
  maxAttemptPagesPerInvocation: 20,
  maxAttemptsPerJobPerCycle: 1000,
  maxUpdatePaths: 500,
  orphanPageSize: 250,
  maxOrphanPagesPerInvocation: 4,
  auxiliaryPageSize: 250,
  maxAuxiliaryPagesPerInvocation: 4,
  maxShadowJobsPerInvocation: 500,
  internalDeadlineMs: 420_000,
  functionTimeoutSeconds: 540,
  leaseMs: 120_000,
  destructiveCommitLeaseMs: 660_000,
  leaseRenewThresholdMs: 45_000,
});

module.exports = {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
  NOTIFICATION_RETENTION_ROLLOUT_PHASES,
  NOTIFICATION_RETENTION_ROLLOUT_ROOT,
  NOTIFICATION_RETENTION_ROOT,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
};
