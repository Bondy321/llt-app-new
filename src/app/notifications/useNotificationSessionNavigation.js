import { useEffect, useRef } from 'react';
import logger from '../../../services/loggerService';
import { markNotificationRead } from '../../../services/notificationInboxService';
import { subscribeToNotificationResponses } from '../../../services/notificationService';
import { createNotificationRegistrationCoordinator } from '../../../services/notifications/notificationRegistrationCoordinator';

export default function useNotificationSessionNavigation({
  authUid,
  authContextSettled = true,
  appSession,
  bookingId,
  isConnected,
  isDriver,
  navigateTo,
  roleContextSettled,
  sessionContextSettled,
  tourId,
}) {
  const navigateRef = useRef(navigateTo);
  const coordinatorRef = useRef(null);
  const responseSubscriptionRef = useRef(null);
  const responseContextRef = useRef(null);
  navigateRef.current = navigateTo;
  const hasLiveAppSession = Boolean(
    bookingId
    && appSession?.sessionId
    && Number.isSafeInteger(appSession?.sessionRevision)
    && appSession.sessionRevision > 0
    && appSession?.expiresAtMs > Date.now()
    && appSession?.tourId === tourId,
  );
  responseContextRef.current = {
    activeTourId: hasLiveAppSession ? tourId : null,
    hasAppSession: hasLiveAppSession,
    hasAuth: Boolean(authUid),
    isDriver: hasLiveAppSession && Boolean(isDriver),
    authContextSettled: authContextSettled !== false,
    sessionContextSettled: typeof sessionContextSettled === 'boolean'
      ? sessionContextSettled
      : hasLiveAppSession,
    roleContextSettled: typeof roleContextSettled === 'boolean'
      ? roleContextSettled
      : Boolean(bookingId),
  };
  const registrationStateRef = useRef(null);
  registrationStateRef.current = {
    authUid,
    sessionId: appSession?.sessionId || null,
    sessionRevision: Number.isSafeInteger(appSession?.sessionRevision) ? appSession.sessionRevision : null,
    tourId: tourId || null,
    operationalEligible: hasLiveAppSession,
    isConnected: isConnected !== false,
  };

  useEffect(() => {
    if (!authUid) return undefined;

    const subscription = subscribeToNotificationResponses({
      getContext: () => responseContextRef.current || {},
      onNavigate: async ({ screen, params }) => {
        const responseTourId = params?.tourId || responseContextRef.current?.activeTourId;
        const navigate = navigateRef.current;
        if (typeof navigate !== 'function') throw new Error('Notification navigation is not ready');
        navigate(screen, params);
        if (params?.noticeId && responseTourId) {
          try {
            await markNotificationRead({ tourId: responseTourId, userId: authUid, noticeId: params.noticeId });
          } catch (error) {
            logger.warn('Navigation', 'Notification read state could not be persisted', {
              screen, error: error?.message || String(error),
            });
          }
        }
      },
    });
    responseSubscriptionRef.current = subscription;
    return () => {
      subscription();
      if (responseSubscriptionRef.current === subscription) responseSubscriptionRef.current = null;
    };
  }, [authUid]);

  useEffect(() => {
    responseSubscriptionRef.current?.retryPending?.();
  }, [
    appSession?.expiresAtMs,
    appSession?.sessionId,
    appSession?.sessionRevision,
    authContextSettled,
    authUid,
    bookingId,
    isDriver,
    navigateTo,
    roleContextSettled,
    sessionContextSettled,
    tourId,
  ]);

  useEffect(() => {
    if (!authUid) return undefined;
    const coordinator = createNotificationRegistrationCoordinator();
    coordinatorRef.current = coordinator;
    coordinator.start(registrationStateRef.current);
    return () => {
      coordinator.stop();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [authUid]);

  useEffect(() => {
    coordinatorRef.current?.update({
      authUid,
      sessionId: appSession?.sessionId || null,
      sessionRevision: Number.isSafeInteger(appSession?.sessionRevision) ? appSession.sessionRevision : null,
      tourId: tourId || null,
      operationalEligible: hasLiveAppSession,
      isConnected: isConnected !== false,
    });
  }, [appSession?.sessionId, appSession?.sessionRevision, authUid, hasLiveAppSession, isConnected, tourId]);
}
