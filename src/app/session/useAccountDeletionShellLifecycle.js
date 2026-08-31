import { useCallback } from 'react';
import { authHelpers } from '../../../firebase';
import accountDeletionService from '../../../services/accountDeletionService';
import appSessionService from '../../../services/appSessionService';
import localSessionCleanupService from '../../../services/localSessionCleanupService';
import { runPurgePendingAccountDeletion, toAccountDeletionUiState } from './accountDeletionRunners';
import { SESSION_KEYS, SessionStorage } from './sessionStorage';
import useAccountDeletionLifecycle from './useAccountDeletionLifecycle';

export default function useAccountDeletionShellLifecycle({
  accountDeletionStatus,
  appSession,
  driverOperationalScope,
  isConnected,
  setAccountDeletionStatus,
  setAppSession,
  setCurrentScreen,
  setUser,
}) {
  const purgePendingAccountDeletion = useCallback(() => runPurgePendingAccountDeletion({
    SESSION_KEYS,
    SessionStorage,
    accountDeletionService,
    appSessionService,
    authHelpers,
    driverOperationalScope,
    localSessionCleanupService,
    setAppSession,
    setUser,
  }), [driverOperationalScope, setAppSession, setUser]);

  const { resumeAccountDeletion, startAccountDeletion } = useAccountDeletionLifecycle({
    accountDeletionStatus,
    isConnected,
    purgePending: purgePendingAccountDeletion,
    setAccountDeletionStatus,
  });

  const handleStartAccountDeletion = useCallback(() => startAccountDeletion({
    expectedSessionId: appSession?.sessionId || null,
  }), [appSession?.sessionId, startAccountDeletion]);

  const finishAccountDeletion = useCallback(async () => {
    let finalization;
    try {
      finalization = await accountDeletionService.finalizeCompletedRecovery();
    } catch {
      setAccountDeletionStatus((current) => ({
        ...current,
        error: 'Final private-data cleanup is still pending. Please try again.',
      }));
      return;
    }
    if (!finalization.success) return;
    setAccountDeletionStatus(toAccountDeletionUiState(null));
    setCurrentScreen('Login');
  }, [setAccountDeletionStatus, setCurrentScreen]);

  const retryAccountDeletion = useCallback(
    () => resumeAccountDeletion({ manual: true }),
    [resumeAccountDeletion],
  );

  return { finishAccountDeletion, handleStartAccountDeletion, retryAccountDeletion };
}
