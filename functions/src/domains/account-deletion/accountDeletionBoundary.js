'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  ACCOUNT_DELETION_PHASE_SET,
  ACCOUNT_DELETION_RECEIPT_PATTERN,
  emptyAccountDeletionSummary,
} = require('./accountDeletionConstants');

const deriveAccountDeletionId = (deletionReceipt) => {
  if (!ACCOUNT_DELETION_RECEIPT_PATTERN.test(deletionReceipt || '')) {
    throw new Error('Invalid account deletion receipt');
  }
  return `acctdel_v1_${createHash('sha256')
    .update(`llt-account-deletion:v1\0${deletionReceipt}`)
    .digest('hex')}`;
};

const derivePrivateBarrierKey = (domain, value) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid account deletion barrier key');
  return createHash('sha256').update(`llt-account-deletion:${domain}:v1\0${value.trim()}`).digest('hex');
};

const derivePassengerAccountDeletionKey = (bookingRef) => derivePrivateBarrierKey('passenger', bookingRef);
const deriveUidAccountDeletionTombstoneKey = (authUid) => derivePrivateBarrierKey('uid-tombstone', authUid);

const readSafeCounter = (value) => (
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0
);

const normalizeSafeSummary = (summary) => {
  const source = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  const empty = emptyAccountDeletionSummary();
  return Object.fromEntries(Object.keys(empty).map((key) => [key, readSafeCounter(source[key])]));
};

// eslint-disable-next-line complexity -- projection explicitly gates every optional public field
const toPublicAccountDeletionStatus = (job, { accepted = false } = {}) => {
  const completionCleanupPending = job?.status === 'completed' && Boolean(job?.completionCleanup);
  const status = job?.status === 'completed' && !completionCleanupPending
    ? 'completed'
    : (job?.status === 'requires_attention' ? 'requires_attention' : (accepted ? 'accepted' : 'pending'));
  const phase = completionCleanupPending
    ? 'auth_delete'
    : (ACCOUNT_DELETION_PHASE_SET.has(job?.phase) ? job.phase : 'reserved');
  return {
    success: true,
    status,
    phase,
    retryable: status === 'completed' ? false : job?.retryable !== false,
    ...(Number.isSafeInteger(job?.createdAtMs) ? { createdAtMs: job.createdAtMs } : {}),
    ...(Number.isSafeInteger(job?.updatedAtMs) ? { updatedAtMs: job.updatedAtMs } : {}),
    ...(Number.isSafeInteger(job?.completedAtMs) ? { completedAtMs: job.completedAtMs } : {}),
    ...(job?.summary ? { summary: normalizeSafeSummary(job.summary) } : {}),
  };
};

const normalizeAccountDeletionRollout = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, isDefault: true, phase: 'compatibility' };
  }
  const valid = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1 && ['compatibility', 'server_only'].includes(value.phase)
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && Number.isSafeInteger(value.updatedAtMs) && value.updatedAtMs > 0);
  return { valid, isDefault: false, phase: valid ? value.phase : 'compatibility' };
};

module.exports = {
  deriveAccountDeletionId,
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
  normalizeAccountDeletionRollout,
  normalizeSafeSummary,
  toPublicAccountDeletionStatus,
};
