import { normalizeOriginalAuthUid } from '../../../services/accountDeletionService';

const parseSaved = (entry) => {
  try { return entry?.[1] ? JSON.parse(entry[1]) : null; } catch { return null; }
};

const localCommitFailure = (name, error, pending) => ({
  success: false,
  pending,
  attempted: [name],
  failures: [{ name, error }],
  results: { [name]: { success: false, error } },
});

export const toAccountDeletionUiState = (pending, error = null) => {
  if (!pending) return { state: 'idle', phase: null, retryable: false, error: null, completedAtMs: null };
  return {
    state: pending.state,
    phase: pending.phase || null,
    retryable: pending.retryable === true,
    error,
    completedAtMs: pending.completedAtMs || null,
    summary: pending.summary || null,
  };
};

export const runPurgePendingAccountDeletion = async ({
  SESSION_KEYS,
  SessionStorage,
  accountDeletionService,
  appSessionService,
  authHelpers,
  driverOperationalScope,
  localSessionCleanupService,
  setAppSession,
  setUser,
}) => {
  const pending = await accountDeletionService.readPending();
  if (!pending || pending.state === 'requesting') return { success: false, deferred: true };
  if (pending.localCleanupState === 'complete' && pending.localCleanupComplete) {
    return { success: true, alreadyComplete: true, pending };
  }

  let commitPending = pending;
  if (pending.localCleanupState !== 'commit_prepared') {
    const [savedTourEntry, savedBookingEntry] = await SessionStorage.multiGet([
      SESSION_KEYS.TOUR_DATA,
      SESSION_KEYS.BOOKING_DATA,
    ]);
    const cachedSession = await appSessionService.readSession({ allowExpired: true });
    const originalAuthUid = normalizeOriginalAuthUid(pending.originalAuthUid);
    if (!originalAuthUid) {
      return {
        success: false,
        error: 'Secure cleanup is waiting for the original account session. Please keep this app installed and contact support.',
      };
    }
    const cleanup = await localSessionCleanupService.prepareScopedCleanup({
      authUid: originalAuthUid,
      appSession: cachedSession,
      bookingData: parseSaved(savedBookingEntry),
      driverOperationalScope,
      requireCompleteScope: true,
      tourData: parseSaved(savedTourEntry),
    });
    if (!cleanup.success) return cleanup;
    try {
      commitPending = await accountDeletionService.markLocalCleanupCommitPrepared();
    } catch {
      return localCommitFailure(
        'prepareLocalCleanupCommit',
        'LOCAL_CLEANUP_PREPARE_PERSIST_FAILED',
        pending,
      );
    }
    if (!commitPending || commitPending.localCleanupState !== 'commit_prepared') {
      return localCommitFailure(
        'prepareLocalCleanupCommit',
        'LOCAL_CLEANUP_PREPARE_PERSIST_FAILED',
        pending,
      );
    }
  }

  const commit = await localSessionCleanupService.commitSessionKeys();
  if (!commit.success) return { ...commit, pending: commitPending };
  let nextPending;
  try {
    nextPending = await accountDeletionService.markLocalCleanupComplete();
  } catch {
    return localCommitFailure(
      'completeLocalCleanupCommit',
      'LOCAL_CLEANUP_COMPLETE_PERSIST_FAILED',
      commitPending,
    );
  }
  if (!nextPending || nextPending.localCleanupState !== 'complete') {
    return localCommitFailure(
      'completeLocalCleanupCommit',
      'LOCAL_CLEANUP_COMPLETE_PERSIST_FAILED',
      commitPending,
    );
  }
  setAppSession(null);
  const recoveryUser = await authHelpers.replaceWithFreshAnonymous();
  setUser(recoveryUser);
  return { success: true, pending: nextPending, recoveryUser };
};

export const runCompleteAccountDeletionLocally = async ({
  accountDeletionService,
  purgePending,
}) => {
  const purge = await purgePending();
  if (!purge.success) return purge;
  return accountDeletionService.finalizeCompletedRecovery();
};
