import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import appSessionService from '../../../services/appSessionService';
import logger from '../../../services/loggerService';
import { classifySessionTransition, sameSessionIdentity } from '../../../services/appSessionTransition';

export default function useLogoutLifecycle({
  appSession,
  appSessionRef,
  onSession,
  disabled = false,
  isConnected,
  logoutContextRef,
  logoutStatus,
  logoutStatusRef,
  purgeLocalSession,
  setCurrentScreen,
  setLogoutStatus,
  userUid,
}) {
  const appSessionListenerRef = useRef(null);
  // Subscription ownership is independent of tour-work retirement. A duplicate
  // projection repair can retire operational work without replacing authority.
  const subscriptionGenerationRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const retryInFlightRef = useRef(false);
  const latestRef = useRef(null);
  latestRef.current = { onSession, purgeLocalSession, appSession, userUid, disabled, logoutState: logoutStatus.state };

  const retryPendingLogout = useCallback(async () => {
    if (logoutStatus.state === 'requesting' || retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    retryAttemptRef.current += 1;
    try {
      setLogoutStatus((current) => ({ ...current, state: 'requesting', error: null }));
      if (logoutStatus.state === 'failed') {
        const context = logoutContextRef.current;
        const cleanup = await latestRef.current.purgeLocalSession({
          capturedSession: context?.appSession || appSessionRef?.current || latestRef.current.appSession,
          capturedContext: context,
        });
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
        const expectedSessionId = result.pending?.sessionId || logoutContextRef.current?.appSession?.sessionId;
        if (await appSessionService.completeEnd({ expectedSessionId }) === false) {
          setLogoutStatus(current => ({ ...current, state: 'failed', error: 'Your session changed. Reopen the app before trying again.' }));
          return;
        }
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
    } catch {
      setLogoutStatus(current => ({ ...current, state: 'failed', error: 'Local logout cleanup is still pending. Please try again.' }));
    } finally {
      retryInFlightRef.current = false;
    }
  }, [appSessionRef, logoutContextRef, logoutStatus.state, setCurrentScreen, setLogoutStatus]);

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
    const generation = ++subscriptionGenerationRef.current;
    const unsubscribe = appSessionService.subscribe({
      authUid: userUid,
      expectedSession: appSession,
      onSession: (event) => latestRef.current.onSession?.(event),
      subscribeToForeground: (checkExpiry) => {
        const subscription = AppState.addEventListener('change', (state) => {
          if (state === 'active') checkExpiry();
        });
        return () => subscription.remove();
      },
      onRevoked: async ({ reason, session: revokedSession = appSession }) => {
        if (generation !== subscriptionGenerationRef.current) return;
        const latest = latestRef.current;
        const capturedSession = appSessionRef ? appSessionRef.current : latest.appSession;
        if (latest.disabled || (logoutStatusRef?.current?.state || latest.logoutState) !== 'idle' || latest.userUid !== userUid
          || !sameSessionIdentity(capturedSession, appSession)) return;
        // HTTP reconciliation can renew the ref before React replaces this
        // subscription. Only its old expiry is obsolete; null/replacement
        // events still revoke the current identity. The next effect owns the
        // renewed deadline, including immediate expiry if it has also elapsed.
        if (reason === 'SESSION_EXPIRED' && capturedSession.expiresAtMs > revokedSession.expiresAtMs
          && classifySessionTransition(revokedSession, capturedSession, { allowDriverAssignment: true }) === 'advance') return;
        logoutContextRef.current = { authUid: userUid, appSession: capturedSession };
        setLogoutStatus({ state: 'requesting', error: null, diagnostic: capturedSession.sessionId.slice(-6) });
        const cleanup = await latestRef.current.purgeLocalSession({ capturedSession });
        if (cleanup.success) {
          if (await appSessionService.completeEnd({ expectedSessionId: capturedSession.sessionId }) === false) return;
          logoutContextRef.current = null;
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
      subscriptionGenerationRef.current += 1;
      unsubscribe();
      if (appSessionListenerRef.current === unsubscribe) appSessionListenerRef.current = null;
    };
  }, [appSession, appSessionRef, disabled, logoutContextRef, logoutStatus.state, logoutStatusRef, setLogoutStatus, userUid]);

  return retryPendingLogout;
}
