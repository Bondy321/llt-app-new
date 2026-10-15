import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
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
  const retryAttemptRef = useRef(0);
  const retryInFlightRef = useRef(false);

  const retryPendingLogout = useCallback(async () => {
    if (logoutStatus.state === 'requesting' || retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    retryAttemptRef.current += 1;
    try {
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
        retryAttemptRef.current = 0;
        if (await appSessionService.completeEnd({ expectedSessionId: result.pending?.sessionId }) === false) return;
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
    } finally {
      retryInFlightRef.current = false;
    }
  }, [logoutContextRef, logoutStatus.state, setCurrentScreen, setLogoutStatus]);

  useEffect(() => {
    if (!isConnected || logoutStatus.state !== 'pending_network') return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(retryAttemptRef.current, 5)));
    const timer = setTimeout(() => { void retryPendingLogout(); }, delay);
    return () => clearTimeout(timer);
  }, [isConnected, logoutStatus, retryPendingLogout]);

  useEffect(() => {
    if (typeof appSessionListenerRef.current === 'function') appSessionListenerRef.current();
    appSessionListenerRef.current = null;
    if (disabled || !appSession || !userUid || logoutStatus.state !== 'idle') return undefined;
    const generation = ++sessionGenerationRef.current;
    const unsubscribe = appSessionService.subscribe({
      authUid: userUid,
      expectedSession: appSession,
      subscribeToForeground: (checkExpiry) => {
        const subscription = AppState.addEventListener('change', (state) => {
          if (state === 'active') checkExpiry();
        });
        return () => subscription.remove();
      },
      onRevoked: async ({ reason }) => {
        if (generation !== sessionGenerationRef.current) return;
        setLogoutStatus({ state: 'requesting', error: null, diagnostic: appSession.sessionId.slice(-6) });
        const cleanup = await purgeLocalSession({ capturedSession: appSession });
        if (cleanup.success) {
          if (await appSessionService.completeEnd({ expectedSessionId: appSession.sessionId }) === false) return;
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
