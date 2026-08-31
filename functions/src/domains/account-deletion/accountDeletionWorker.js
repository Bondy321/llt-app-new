'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { deleteNotificationAccountState } = require('../notifications/public');
const {
  ACCOUNT_DELETION_ACTIVE_ROOT,
  ACCOUNT_DELETION_JOB_ROOT,
  ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES,
  ACCOUNT_DELETION_QUEUE_ROOT,
  emptyAccountDeletionSummary,
} = require('./accountDeletionConstants');
const { derivePassengerAccountDeletionKey } = require('./accountDeletionBoundary');
const {
  acquireAccountDeletionJobLease,
  assertCurrentJobLease,
  claimAccountDeletionQueueEntry,
  jobLeaseMatches,
  releaseAccountDeletionQueueEntry,
} = require('./accountDeletionCoordination');
const {
  deleteGroupMediaPage,
  deletePrivateMediaPage,
  deleteUidAccountRecords,
  readAccountDeletionKeyPage,
  redactAuthoredChatNotificationJob,
  releaseOwnedDriverAuthority,
  releaseOwnedPassengerAuthority,
  scrubAccountDeletionMessage,
  scrubChatPage,
} = require('./accountDeletionEffects');
const {
  finalizeCompletedAccountDeletion,
  reconcileCompletedAccountDeletion,
} = require('./accountDeletionFinalization');

const { cleanupLiveStateForSession } = loadLegacyLibrary('appSessionCleanup');
const {
  boundedWarningCode,
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
} = loadLegacyLibrary('operationsTerminalWarnings');

const nextPhase = Object.freeze({
  reserved: 'live_state_cleanup',
  live_state_cleanup: 'authority_release',
  authority_release: 'group_media',
  group_media: 'private_media',
  private_media: 'chat_scrub',
  chat_scrub: 'account_records',
  account_records: 'auth_delete',
});

const safeIncrement = (value, delta) => Math.min(
  1_000_000,
  (Number.isSafeInteger(value) && value >= 0 ? value : 0)
    + (Number.isSafeInteger(delta) && delta >= 0 ? delta : 0),
);

const commitLeasedJobProgress = async ({
  ref, lease, expectedPhase, next, substage, cursorUpdates = {}, summaryDelta = {},
  privateScope = undefined, nowMs = Date.now(),
}) => {
  let committed = false;
  const result = await ref.transaction((current) => {
    const checkedAtMs = typeof lease.clock === 'function' ? lease.clock() : nowMs;
    if (!jobLeaseMatches(current, lease) || current.phase !== expectedPhase
      || Number(current.lease?.expiresAtMs || 0) <= checkedAtMs) return undefined;
    committed = true;
    const summary = { ...emptyAccountDeletionSummary(), ...(current.summary || {}) };
    Object.entries(summaryDelta).forEach(([key, value]) => {
      if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key] = safeIncrement(summary[key], value);
    });
    return {
      ...current,
      phase: next || current.phase,
      substage: (next || current.phase) === current.phase
        ? (substage === undefined ? (current.substage || null) : substage)
        : null,
      cursors: { ...(current.cursors || {}), ...cursorUpdates },
      summary,
      consecutiveFailureCount: 0,
      lastFailureReason: null,
      availableAtMs: nowMs,
      updatedAtMs: nowMs,
      lease: null,
      ...(privateScope === undefined ? {} : { privateScope }),
    };
  }, undefined, false);
  return Boolean(committed && result?.committed);
};

// eslint-disable-next-line complexity -- explicit durable phase dispatch keeps every transition visible and auditable
const processLeasedAccountDeletionPhase = async ({ db, bucket, auth, deletionId, job, lease, nowMs }) => {
  const scope = job.privateScope;
  const authDeleteScopeValid = job.phase === 'auth_delete'
    && scope?.authUid
    && ['passenger', 'driver'].includes(scope?.principalType)
    && (scope.principalType !== 'passenger' || /^[a-f0-9]{64}$/u.test(scope.passengerBarrierKey || ''));
  if (!scope?.authUid || !scope?.principalType
    || (job.phase === 'auth_delete' ? !authDeleteScopeValid : !Array.isArray(scope.actorKeys))) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion scope is unavailable'));
    error.code = 'ACCOUNT_DELETION_SCOPE_INVALID';
    throw error;
  }
  const validSubstages = {
    authority_release: new Set([null, 'authority_released']),
    account_records: new Set([null, 'notification_deleted', 'uid_records_deleted']),
    auth_delete: new Set([null, 'completion_cleanup']),
  };
  const allowedSubstages = validSubstages[job.phase] || new Set([null]);
  if (!allowedSubstages.has(job.substage ?? null)) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion substage is invalid'));
    error.code = 'ACCOUNT_DELETION_SUBSTAGE_INVALID';
    throw error;
  }
  if (job.phase === 'reserved') {
    return commitLeasedJobProgress({ ref: lease.ref, lease, expectedPhase: job.phase, next: nextPhase[job.phase], nowMs });
  }
  if (job.phase === 'live_state_cleanup') {
    await assertCurrentJobLease({ ref: lease.ref, lease, nowMs });
    await cleanupLiveStateForSession({
      db,
      session: {
        sessionId: scope.expectedSessionId,
        authUid: scope.authUid,
        principalType: scope.principalType,
        principalId: scope.principalId,
        tourId: scope.tourId,
        driverId: scope.driverId || null,
      },
      nowMs,
    });
    return commitLeasedJobProgress({ ref: lease.ref, lease, expectedPhase: job.phase, next: nextPhase[job.phase], nowMs });
  }
  if (job.phase === 'authority_release') {
    if (job.substage === 'authority_released') {
      return commitLeasedJobProgress({
        ref: lease.ref, lease, expectedPhase: job.phase, next: nextPhase[job.phase], nowMs,
      });
    }
    await assertCurrentJobLease({ ref: lease.ref, lease, nowMs });
    const recordsRemoved = scope.principalType === 'passenger'
      ? await releaseOwnedPassengerAuthority({ db, scope, leaseGuard: { ref: lease.ref, lease, nowMs } })
      : await releaseOwnedDriverAuthority({ db, scope, leaseGuard: { ref: lease.ref, lease, nowMs } });
    return commitLeasedJobProgress({
      ref: lease.ref, lease, expectedPhase: job.phase, next: job.phase, substage: 'authority_released', nowMs,
      summaryDelta: { recordsRemoved },
    });
  }
  if (job.phase === 'group_media') {
    const result = await deleteGroupMediaPage({
      db, bucket, scope, cursor: job.cursors?.groupMediaAfterPhotoId, lease: { ref: lease.ref, lease, nowMs },
    });
    return commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: job.phase,
      next: result.done ? nextPhase[job.phase] : job.phase,
      cursorUpdates: { groupMediaAfterPhotoId: result.lastKey },
      summaryDelta: result,
      nowMs,
    });
  }
  if (job.phase === 'private_media') {
    const result = await deletePrivateMediaPage({
      db, bucket, scope, cursor: job.cursors?.privateMediaAfterPhotoId, lease: { ref: lease.ref, lease, nowMs },
    });
    return commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: job.phase,
      next: result.done ? nextPhase[job.phase] : job.phase,
      cursorUpdates: { privateMediaAfterPhotoId: result.lastKey },
      summaryDelta: result,
      nowMs,
    });
  }
  if (job.phase === 'chat_scrub') {
    const result = await scrubChatPage({
      db, scope, cursor: job.cursors?.chatAfterMessageId, nowMs, lease: { ref: lease.ref, lease, nowMs },
    });
    return commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: job.phase,
      next: result.done ? nextPhase[job.phase] : job.phase,
      cursorUpdates: { chatAfterMessageId: result.lastKey },
      summaryDelta: result,
      nowMs,
    });
  }
  if (job.phase === 'account_records') {
    if (!job.substage) {
      await assertCurrentJobLease({ ref: lease.ref, lease, nowMs });
      const notificationDeletion = await deleteNotificationAccountState({
        db, authUid: scope.authUid, nowMs, owner: lease.ownerId,
      });
      return commitLeasedJobProgress({
        ref: lease.ref,
        lease,
        expectedPhase: job.phase,
        next: job.phase,
        substage: 'notification_deleted',
        summaryDelta: { recordsRemoved: notificationDeletion.body?.alreadyDeleted ? 0 : 3 },
        nowMs,
      });
    }
    if (job.substage === 'notification_deleted') {
      const recordsRemoved = await deleteUidAccountRecords({
        db, scope, leaseGuard: { ref: lease.ref, lease, nowMs },
      });
      return commitLeasedJobProgress({
        ref: lease.ref,
        lease,
        expectedPhase: job.phase,
        next: job.phase,
        substage: 'uid_records_deleted',
        summaryDelta: { recordsRemoved },
        nowMs,
      });
    }
    if (job.substage !== 'uid_records_deleted') {
      const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion substage is invalid'));
      error.code = 'ACCOUNT_DELETION_SUBSTAGE_INVALID';
      throw error;
    }
    return commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: job.phase,
      next: nextPhase[job.phase],
      privateScope: {
        authUid: scope.authUid,
        principalType: scope.principalType,
        ...(scope.principalType === 'passenger' ? {
          passengerBarrierKey: derivePassengerAccountDeletionKey(scope.bookingRef),
        } : {}),
      },
      nowMs,
    });
  }
  if (job.phase === 'auth_delete') {
    if (job.substage !== 'completion_cleanup') {
      await assertCurrentJobLease({ ref: lease.ref, lease, nowMs });
      try {
        await auth.deleteUser(scope.authUid);
      } catch (error) {
        const code = /** @type {{ code?: unknown }} */ (error || {}).code;
        if (code !== 'auth/user-not-found') throw error;
      }
    }
    return finalizeCompletedAccountDeletion({ db, deletionId, lease, job, nowMs });
  }
  const error = /** @type {Error & { code?: string }} */ (new Error('Unsupported account deletion phase'));
  error.code = 'ACCOUNT_DELETION_PHASE_INVALID';
  throw error;
};

const calculateAccountDeletionRetryDelayMs = (consecutiveFailureCount) => Math.min(
  30 * 60 * 1000,
  30 * 1000 * (2 ** Math.max(0, Math.min(consecutiveFailureCount - 1, 8))),
);

const TERMINAL_ACCOUNT_DELETION_FAILURES = new Set([
  'ACCOUNT_DELETION_PHASE_INVALID',
  'ACCOUNT_DELETION_SCOPE_INVALID',
  'ACCOUNT_DELETION_SUBSTAGE_INVALID',
  'MEDIA_PATH_INVALID',
]);

// eslint-disable-next-line complexity -- terminal warning persistence and exact lease retention are one failure boundary
const recordAccountDeletionFailure = async ({ db, ref, deletionId, lease, error, nowMs }) => {
  const failureReason = boundedWarningCode(error?.code, 'account_deletion_retry', 80);
  const snapshot = await ref.once('value');
  const current = snapshot.val();
  const checkedAtMs = typeof lease.clock === 'function' ? lease.clock() : nowMs;
  if (!jobLeaseMatches(current, lease) || Number(current?.lease?.expiresAtMs || 0) <= checkedAtMs) {
    return { recorded: false, status: 'lease_lost', dueAtMs: nowMs };
  }
  const consecutiveFailureCount = Number(current.consecutiveFailureCount || 0) + 1;
  const attemptCount = Number(current.attemptCount || 0);
  const terminalMalformed = TERMINAL_ACCOUNT_DELETION_FAILURES.has(error?.code);
  const requiresAttention = terminalMalformed
    || consecutiveFailureCount >= ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES;
  let terminalWarningId = current.terminalWarningId || null;
  let createdWarning = null;
  if (requiresAttention) {
    const warning = buildOperationsTerminalWarning({
      jobType: 'account_deletion',
      reason: failureReason,
      // The lease revision makes an unadopted stale-worker warning distinct
      // from the warning a successor lease may legitimately reference.
      identifiers: { deletionId, leaseRevision: lease.revision },
      attemptCount,
      firstAttemptAtMs: current.firstAttemptAtMs || nowMs,
      lastAttemptAtMs: nowMs,
      expiresAtMs: current.expiresAtMs || nowMs,
      nowMs,
    });
    const persisted = await persistOperationsTerminalWarning({ db, warning });
    if (persisted.created) createdWarning = persisted.warning;
    terminalWarningId = warning.warningId;
  }
  const dueAtMs = requiresAttention
    ? nowMs + (24 * 60 * 60 * 1000)
    : nowMs + calculateAccountDeletionRetryDelayMs(consecutiveFailureCount);
  let recorded = false;
  const result = await ref.transaction((jobValue) => {
    const transactionCheckedAtMs = typeof lease.clock === 'function' ? lease.clock() : nowMs;
    if (!jobLeaseMatches(jobValue, lease)
      || Number(jobValue.lease?.expiresAtMs || 0) <= transactionCheckedAtMs) return undefined;
    recorded = true;
    return {
      ...jobValue,
      status: requiresAttention ? 'requires_attention' : 'pending',
      retryable: !terminalMalformed,
      attemptCount,
      consecutiveFailureCount,
      firstAttemptAtMs: jobValue.firstAttemptAtMs || nowMs,
      lastAttemptAtMs: nowMs,
      lastFailureReason: failureReason,
      terminalWarningId,
      availableAtMs: dueAtMs,
      updatedAtMs: nowMs,
      lease: null,
    };
  }, undefined, false);
  if ((!recorded || !result?.committed) && createdWarning) {
    await db.ref(`operations_terminal_warnings/v1/${createdWarning.warningId}`).transaction((warning) => {
      if (!warning || warning.warningId !== createdWarning.warningId
        || warning.status !== 'open'
        || warning.attemptCount !== createdWarning.attemptCount
        || warning.updatedAtMs !== createdWarning.updatedAtMs) return undefined;
      return null;
    }, undefined, false);
  }
  if (recorded && result?.committed && requiresAttention && current.privateScope?.authUid) {
    await db.ref(`${ACCOUNT_DELETION_ACTIVE_ROOT}/${current.privateScope.authUid}`).transaction((active) => {
      if (!active || active.deletionId !== deletionId) return undefined;
      return { ...active, status: 'requires_attention', updatedAtMs: nowMs };
    }, undefined, false);
  }
  return {
    recorded: Boolean(recorded && result?.committed),
    status: requiresAttention ? 'requires_attention' : 'pending',
    dueAtMs,
  };
};

const handleUnclaimedAccountDeletionJob = async ({
  db, deletionId, queueRef, ownerId, nowMs,
}) => {
  const currentJob = (await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).once('value')).val();
  if (currentJob?.status === 'completed' && currentJob.completionCleanup) {
    try {
      await reconcileCompletedAccountDeletion({ db, deletionId, completed: currentJob });
    } catch (error) {
      await releaseAccountDeletionQueueEntry({
        ref: queueRef, ownerId, dueAtMs: nowMs + 30_000,
      });
      return {
        processed: false,
        reason: 'completion_reconciliation_failed',
        errorCode: boundedWarningCode(error?.code, 'account_deletion_retry'),
      };
    }
  }
  const removeOrphan = !currentJob || currentJob.status === 'completed';
  const retryDueAtMs = currentJob?.status === 'requires_attention'
    ? nowMs + (24 * 60 * 60 * 1000)
    : nowMs + 30_000;
  await releaseAccountDeletionQueueEntry({
    ref: queueRef, ownerId, dueAtMs: retryDueAtMs, remove: removeOrphan,
  });
  return { processed: false, reason: 'JOB_NOT_CLAIMED' };
};

const processAccountDeletionJob = async ({
  db = admin.database(), bucket = admin.storage().bucket(), auth = admin.auth(), deletionId,
  nowMs = Date.now(), ownerId = randomUUID(), clock = Date.now,
}) => {
  const queue = await claimAccountDeletionQueueEntry({ db, deletionId, nowMs, ownerId });
  if (!queue.claimed) return { processed: false, reason: 'QUEUE_NOT_CLAIMED' };
  const lease = await acquireAccountDeletionJobLease({ db, deletionId, ownerId, nowMs });
  if (!lease.acquired) {
    return handleUnclaimedAccountDeletionJob({
      db, deletionId, queueRef: queue.ref, ownerId, nowMs,
    });
  }
  const exactLease = {
    ownerId, revision: lease.revision, phase: lease.job.phase, ref: lease.ref, clock,
  };
  try {
    const result = await processLeasedAccountDeletionPhase({
      db, bucket, auth, deletionId, job: lease.job, lease: exactLease, nowMs,
    });
    if (lease.job.phase !== 'auth_delete') {
      await releaseAccountDeletionQueueEntry({ ref: queue.ref, ownerId, dueAtMs: nowMs });
    }
    return { processed: true, phase: lease.job.phase, result };
  } catch (error) {
    const failure = await recordAccountDeletionFailure({
      db, ref: lease.ref, deletionId, lease: exactLease, error, nowMs,
    });
    await releaseAccountDeletionQueueEntry({ ref: queue.ref, ownerId, dueAtMs: failure.dueAtMs });
    return {
      processed: false,
      reason: failure.status,
      errorCode: boundedWarningCode(error?.code, 'account_deletion_retry'),
    };
  }
};

const repairAccountDeletionRetryQueues = async ({
  db = admin.database(), nowMs = Date.now(), limit = 20,
} = {}) => {
  const snapshot = await db.ref(ACCOUNT_DELETION_JOB_ROOT)
    .orderByChild('retryRequestedAtMs').startAt(1).endAt(nowMs).limitToFirst(limit).once('value');
  let repaired = 0;
  for (const [deletionId, expected] of Object.entries(snapshot.val() || {})) {
    if (expected?.status !== 'pending' || !Number.isSafeInteger(expected.retryRequestedAtMs)) continue;
    const queueRef = db.ref(`${ACCOUNT_DELETION_QUEUE_ROOT}/${deletionId}`);
    const queueResult = await queueRef.transaction((current) => {
      if (current?.lease && Number(current.lease.expiresAtMs || 0) > nowMs) return current;
      return {
        schemaVersion: 1,
        deletionId,
        dueAtMs: Math.min(Number(current?.dueAtMs || nowMs), nowMs),
        lease: null,
      };
    }, undefined, false);
    if (!queueResult?.committed) continue;
    let markerCleared = false;
    await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).transaction((current) => {
      if (!current || current.status !== 'pending'
        || current.retryRequestedAtMs !== expected.retryRequestedAtMs) return undefined;
      markerCleared = true;
      const next = { ...current };
      delete next.retryRequestedAtMs;
      return next;
    }, undefined, false);
    repaired += Number(markerCleared);
  }
  return repaired;
};

const processDueAccountDeletionJobs = async ({
  db = admin.database(), nowMs = Date.now(), limit = 10, clock = Date.now,
} = {}) => {
  await repairAccountDeletionRetryQueues({ db, nowMs, limit: Math.max(limit * 2, 20) });
  const snapshot = await db.ref(ACCOUNT_DELETION_QUEUE_ROOT)
    .orderByChild('dueAtMs').endAt(nowMs).limitToFirst(limit).once('value');
  const deletionIds = Object.keys(snapshot.val() || {}).sort();
  const outcomes = [];
  for (const deletionId of deletionIds) {
    outcomes.push(await processAccountDeletionJob({ db, deletionId, nowMs, clock }));
  }
  return outcomes;
};

const cleanupCompletedAccountDeletionJobs = async ({
  db = admin.database(), nowMs = Date.now(), limit = 50,
} = {}) => {
  const snapshot = await db.ref(ACCOUNT_DELETION_JOB_ROOT)
    .orderByChild('retainUntilMs').startAt(1).endAt(nowMs).limitToFirst(limit).once('value');
  let removed = 0;
  for (const [deletionId, expected] of Object.entries(snapshot.val() || {})) {
    if (expected?.status !== 'completed' || expected.completionCleanup) continue;
    let matched = false;
    const result = await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).transaction((current) => {
      if (!current || current.status !== 'completed'
        || current.completionCleanup
        || current.completedAtMs !== expected.completedAtMs
        || Number(current.retainUntilMs || 0) > nowMs) return undefined;
      matched = true;
      return null;
    }, undefined, false);
    removed += Number(matched && result?.committed);
  }
  return removed;
};

module.exports = {
  calculateAccountDeletionRetryDelayMs,
  cleanupCompletedAccountDeletionJobs,
  commitLeasedJobProgress,
  assertCurrentJobLease,
  deleteGroupMediaPage,
  deletePrivateMediaPage,
  deleteUidAccountRecords,
  finalizeCompletedAccountDeletion,
  processAccountDeletionJob,
  processDueAccountDeletionJobs,
  processLeasedAccountDeletionPhase,
  reconcileCompletedAccountDeletion,
  redactAuthoredChatNotificationJob,
  repairAccountDeletionRetryQueues,
  readAccountDeletionKeyPage,
  recordAccountDeletionFailure,
  releaseOwnedDriverAuthority,
  releaseOwnedPassengerAuthority,
  scrubAccountDeletionMessage,
  scrubChatPage,
};
