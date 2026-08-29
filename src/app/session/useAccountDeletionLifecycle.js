import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import accountDeletionService from '../../../services/accountDeletionService';
import { toAccountDeletionUiState } from './accountDeletionRunners';

const POLL_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export default function useAccountDeletionLifecycle({
  accountDeletionStatus,
  isConnected,
  purgePending,
  setAccountDeletionStatus,
  service = accountDeletionService,
}) {
  const timerRef = useRef(null);
  const attemptRef = useRef(0);
  const activeRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const applyResult = useCallback(async (result) => {
    const pending = result?.pending || await service.readPending();
    if (!pending) {
      setAccountDeletionStatus(toAccountDeletionUiState(null));
      return result;
    }
    if (pending.state !== 'requesting' && !pending.localCleanupComplete) {
      const cleanup = await purgePending();
      if (!cleanup.success) {
        setAccountDeletionStatus(toAccountDeletionUiState(pending,
          'Private data is still being cleared from this device. Please retry.'));
        return { ...result, cleanup };
      }
    }
    const refreshed = await service.readPending();
    const visible = refreshed || pending;
    if (visible.state === 'completed' && visible.localCleanupComplete) {
      let completion;
      try {
        completion = await service.finalizeCompletedRecovery();
      } catch {
        completion = { success: false, reason: 'LOCAL_COMPLETION_FAILED' };
      }
      if (!completion.success) {
        setAccountDeletionStatus(toAccountDeletionUiState(visible,
          'Final private-data cleanup is still pending. Please try again.'));
        return { ...result, completion };
      }
    }
    setAccountDeletionStatus(toAccountDeletionUiState(visible,
      result?.success === false ? result.error : null));
    return result;
  }, [purgePending, service, setAccountDeletionStatus]);

  const resume = useCallback(async ({ manual = false } = {}) => {
    if (!isConnected) return { success: false, reason: 'OFFLINE' };
    clearTimer();
    const pending = await service.readPending();
    if (!pending) return applyResult(null);
    const result = manual && pending.state === 'requires_attention'
      ? await service.retryDeletion()
      : await service.pollStatus();
    await applyResult(result);
    if (result?.success) attemptRef.current = 0;
    else attemptRef.current = Math.min(attemptRef.current + 1, POLL_DELAYS_MS.length - 1);
    return result;
  }, [applyResult, clearTimer, isConnected, service]);

  const start = useCallback(async ({ expectedSessionId }) => {
    clearTimer();
    setAccountDeletionStatus({
      state: 'requesting', phase: null, retryable: false, error: null, completedAtMs: null,
    });
    const result = await service.requestDeletion({ expectedSessionId });
    return applyResult(result);
  }, [applyResult, clearTimer, service, setAccountDeletionStatus]);

  useEffect(() => {
    if (accountDeletionStatus.state === 'idle' || accountDeletionStatus.state === 'requesting') return;
    service.readPending().then((pending) => {
      if (pending && !pending.localCleanupComplete) {
        applyResult({ success: true, pending }).catch(() => {});
      }
    }).catch(() => {});
  }, [accountDeletionStatus.state, applyResult, service]);

  useEffect(() => {
    activeRef.current = true;
    if (!isConnected || accountDeletionStatus.state === 'idle'
      || accountDeletionStatus.state === 'completed') return undefined;
    const delay = POLL_DELAYS_MS[Math.min(attemptRef.current, POLL_DELAYS_MS.length - 1)];
    timerRef.current = setTimeout(() => {
      if (activeRef.current) resume().catch(() => {});
    }, delay);
    return () => clearTimer();
  }, [accountDeletionStatus.state, clearTimer, isConnected, resume]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && accountDeletionStatus.state !== 'idle'
        && accountDeletionStatus.state !== 'completed') {
        resume().catch(() => {});
      }
    });
    return () => {
      activeRef.current = false;
      subscription.remove();
      clearTimer();
    };
  }, [accountDeletionStatus.state, clearTimer, resume]);

  return { resumeAccountDeletion: resume, startAccountDeletion: start };
}
