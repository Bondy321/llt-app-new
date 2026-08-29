'use strict';

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const {
  ACCOUNT_DELETION_ACTIVE_ROOT,
  ACCOUNT_DELETION_COMPLETION_RETENTION_MS,
  ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT,
  ACCOUNT_DELETION_JOB_ROOT,
  ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT,
  ACCOUNT_DELETION_QUEUE_ROOT,
  emptyAccountDeletionSummary,
} = require('./accountDeletionConstants');
const { jobLeaseMatches } = require('./accountDeletionCoordination');

const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { hashTerminalWarningIdentifier } = loadLegacyLibrary('operationsTerminalWarnings');

const completedAccountDeletionTombstone = (completed) => ({
  schemaVersion: 1,
  status: 'completed',
  phase: 'completed',
  retryable: false,
  updatedAtMs: completed.updatedAtMs,
  completedAtMs: completed.completedAtMs,
});

// eslint-disable-next-line complexity -- exact compare-cleanup branches form one replayable finalization fence
const reconcileCompletedAccountDeletion = async ({ db, deletionId, completed }) => {
  const cleanup = completed?.completionCleanup;
  if (!cleanup?.authUid || completed?.status !== 'completed' || completed?.phase !== 'completed') {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('Account deletion completion cleanup is unavailable')
    );
    error.code = 'ACCOUNT_DELETION_FINALIZATION_CHANGED';
    throw error;
  }
  const completionMarker = { updatedAtMs: completed.updatedAtMs, completedAtMs: completed.completedAtMs };
  let tombstoneAccepted = false;
  const tombstoneResult = await db.ref(
    `${ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT}/${deletionId}`,
  ).transaction((current) => {
    if (current) {
      if (current.status !== 'completed' || current.completedAtMs !== completed.completedAtMs) {
        return undefined;
      }
      tombstoneAccepted = true;
      return current;
    }
    tombstoneAccepted = true;
    return completedAccountDeletionTombstone(completionMarker);
  }, undefined, false);
  if (!tombstoneAccepted || !tombstoneResult?.committed) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('Account deletion completion tombstone changed')
    );
    error.code = 'ACCOUNT_DELETION_FINALIZATION_CHANGED';
    throw error;
  }

  const removeMatchingBarrier = async (ref) => ref.transaction((current) => {
    const currentDeletionId = typeof current === 'string' ? current : current?.deletionId;
    return currentDeletionId === deletionId ? null : undefined;
  }, undefined, false);
  await removeMatchingBarrier(db.ref(`${ACCOUNT_DELETION_ACTIVE_ROOT}/${cleanup.authUid}`));
  if (cleanup.passengerBarrierKey) {
    await removeMatchingBarrier(db.ref(
      `${ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT}/${cleanup.passengerBarrierKey}`,
    ));
  }
  if (cleanup.terminalWarningId) {
    await db.ref(`operations_terminal_warnings/v1/${cleanup.terminalWarningId}`).transaction((warning) => {
      if (warning?.jobType !== 'account_deletion'
        || warning?.identifierHashes?.deletionId !== hashTerminalWarningIdentifier(deletionId)) {
        return undefined;
      }
      return null;
    }, undefined, false);
  }

  let reconciled = null;
  const jobResult = await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).transaction((current) => {
    if (!current || current.status !== 'completed' || current.phase !== 'completed'
      || current.completionCleanup?.authUid !== cleanup.authUid
      || current.completionCleanup?.completionRevision !== cleanup.completionRevision
      || current.completedAtMs !== completed.completedAtMs) return undefined;
    reconciled = { ...current };
    delete reconciled.completionCleanup;
    return reconciled;
  }, undefined, false);
  if (!reconciled || !jobResult?.committed) {
    const current = (await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).once('value')).val();
    if (current?.status === 'completed' && current.completedAtMs === completed.completedAtMs
      && !current.completionCleanup) return current;
    const error = /** @type {Error & { code?: string }} */ (
      new Error('Account deletion completed job changed during reconciliation')
    );
    error.code = 'ACCOUNT_DELETION_FINALIZATION_CHANGED';
    throw error;
  }
  return reconciled;
};

const finalizeCompletedAccountDeletion = async ({ db, deletionId, lease, job, nowMs }) => {
  const scope = job.privateScope;
  const lock = await acquireAppSessionLock({
    db, authUid: scope.authUid, operation: 'revoke', owner: lease.ownerId, nowMs, ttlMs: 180_000,
  });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (new Error('App session operation in progress'));
    error.code = 'SESSION_IN_PROGRESS';
    throw error;
  }
  try {
    const passengerBarrierKey = scope.principalType === 'passenger'
      ? scope.passengerBarrierKey
      : null;
    let completed = null;
    const completionResult = await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).transaction((currentJob) => {
      const checkedAtMs = typeof lease.clock === 'function' ? lease.clock() : nowMs;
      if (!jobLeaseMatches(currentJob, lease) || currentJob.phase !== 'auth_delete'
        || Number(currentJob.lease?.expiresAtMs || 0) <= checkedAtMs) return undefined;
      completed = {
        schemaVersion: 1,
        deletionId,
        status: 'completed',
        phase: 'completed',
        createdAtMs: Number(currentJob.createdAtMs || nowMs),
        updatedAtMs: nowMs,
        completedAtMs: nowMs,
        retainUntilMs: nowMs + ACCOUNT_DELETION_COMPLETION_RETENTION_MS,
        summary: { ...emptyAccountDeletionSummary(), ...(currentJob.summary || {}) },
        completionCleanup: {
          authUid: scope.authUid,
          completionRevision: lease.revision,
          ...(passengerBarrierKey ? { passengerBarrierKey } : {}),
          ...(typeof currentJob.terminalWarningId === 'string'
            ? { terminalWarningId: currentJob.terminalWarningId }
            : {}),
        },
      };
      return completed;
    }, undefined, false);
    if (!completed || !completionResult?.committed) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion finalization changed'));
      error.code = 'ACCOUNT_DELETION_FINALIZATION_CHANGED';
      throw error;
    }
    const reconciled = await reconcileCompletedAccountDeletion({ db, deletionId, completed });
    await db.ref(`${ACCOUNT_DELETION_QUEUE_ROOT}/${deletionId}`).transaction((current) => (
      current?.deletionId === deletionId ? null : undefined
    ), undefined, false);
    return reconciled;
  } finally {
    await releaseAppSessionLock({ db, authUid: scope.authUid, owner: lease.ownerId });
  }
};

module.exports = { finalizeCompletedAccountDeletion, reconcileCompletedAccountDeletion };
