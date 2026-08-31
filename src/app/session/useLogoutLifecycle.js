import { useCallback, useEffect, useRef } from 'react';
import appSessionService from '../../../services/appSessionService';
import localSessionCleanupService from '../../../services/localSessionCleanupService';
import logger from '../../../services/loggerService';

export default function useLogoutLifecycle({
  appSession,
  disabled = false,
  isConnected,
  logoutContextRef,
  logoutStatus,
  purgeLocalSession,
  sessionGenerationRef,
  setCurrentScreen,
  setLogoutStatus,
  userUid,
}) {
  const appSessionListenerRef = useRef(null);

  const retryPendingLogout = useCallback(async () => {
    if (logoutStatus.state === 'requesting') return;
    setLogoutStatus((current) => ({ ...current, state: 'requesting', error: null }));
    if (logoutStatus.state === 'failed') {
      const cleanup = await localSessionCleanupService.cleanup(logoutContextRef.current || {});
      if (!cleanup.success) {
        setLogoutStatus((current) => ({
          ...current,
          state: 'failed',
          error: 'Some private data still could not be removed from this device. Please try again.',
        }));
        return;
      }
    }
    const result = await appSessionService.retryPendingEnd();
    if (result.success) {
      await appSessionService.completeEnd();
      logoutContextRef.current = null;
      setLogoutStatus({ state: 'complete', error: null, diagnostic: null });
      setCurrentScreen('Login');
      return;
    }
    setLogoutStatus((current) => ({
      ...current,
      state: 'pending_network',
      error: result.reason === 'NETWORK_ERROR'
        ? 'We still cannot reach the server. We will keep trying when the connection returns.'
        : 'Logout is still awaiting server confirmation. Please try again.',
    }));
  }, [logoutContextRef, logoutStatus.state, setCurrentScreen, setLogoutStatus]);

  useEffect(() => {
    if (!isConnected || logoutStatus.state !== 'pending_network') return;
    retryPendingLogout();
  }, [isConnected, logoutStatus.state, retryPendingLogout]);

  useEffect(() => {
    if (typeof appSessionListenerRef.current === 'function') appSessionListenerRef.current();
    appSessionListenerRef.current = null;
    if (disabled || !appSession || !userUid || logoutStatus.state !== 'idle') return undefined;
    const generation = ++sessionGenerationRef.current;
    const unsubscribe = appSessionService.subscribe({
      authUid: userUid,
      expectedSession: appSession,
      onRevoked: async ({ reason }) => {
        if (generation !== sessionGenerationRef.current) return;
        setLogoutStatus({ state: 'requesting', error: null, diagnostic: appSession.sessionId.slice(-6) });
        const cleanup = await purgeLocalSession({ capturedSession: appSession });
        if (cleanup.success) {
          await appSessionService.completeEnd();
          setLogoutStatus({ state: 'complete', error: null, diagnostic: null });
        } else {
          setLogoutStatus({
            state: 'failed',
            error: 'Your session ended remotely, but some local data still needs to be removed. Try again.',
            diagnostic: appSession.sessionId.slice(-6),
          });
        }
        logger.info('Auth', 'Remote app session revocation handled', { reason });
      },
      onError: (error) => logger.warn('Session', 'Remote session listener paused', {
        error: error?.message || String(error),
      }),
    });
    appSessionListenerRef.current = unsubscribe;
    return () => {
      sessionGenerationRef.current += 1;
      unsubscribe();
      if (appSessionListenerRef.current === unsubscribe) appSessionListenerRef.current = null;
    };
  }, [appSession, disabled, logoutStatus.state, purgeLocalSession, sessionGenerationRef, setLogoutStatus, userUid]);

  return retryPendingLogout;
}
