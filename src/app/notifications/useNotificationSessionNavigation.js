import { useEffect, useRef } from 'react';
import logger from '../../../services/loggerService';
import { markNotificationRead } from '../../../services/notificationInboxService';
import { subscribeToNotificationResponses } from '../../../services/notificationService';
import { createNotificationRegistrationCoordinator } from '../../../services/notifications/notificationRegistrationCoordinator';

export default function useNotificationSessionNavigation({
  authUid,
  appSession,
  bookingId,
  isConnected,
  isDriver,
  navigateTo,
  tourId,
}) {
  const navigateRef = useRef(navigateTo);
  const coordinatorRef = useRef(null);
  navigateRef.current = navigateTo;
  const registrationStateRef = useRef(null);
  registrationStateRef.current = {
    authUid,
    sessionId: appSession?.sessionId || null,
    tourId: tourId || null,
    operationalEligible: Boolean(appSession?.sessionId && tourId),
    isConnected: isConnected !== false,
  };

  useEffect(() => {
    const hasAppSession = Boolean(bookingId && appSession?.sessionId && appSession?.expiresAtMs > Date.now());
    if (!authUid) return undefined;

    return subscribeToNotificationResponses({
      getContext: () => ({ activeTourId: hasAppSession ? tourId : null, hasAppSession, hasAuth: true, isDriver: hasAppSession && Boolean(isDriver) }),
      onNavigate: async ({ screen, params }) => {
        const responseTourId = params?.tourId || tourId;
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
  }, [appSession?.expiresAtMs, appSession?.sessionId, authUid, bookingId, isDriver, tourId]);

  useEffect(() => {
    if (!authUid) return undefined;
    const coordinator = createNotificationRegistrationCoordinator();
    coordinatorRef.current = coordinator;
    coordinator.start(registrationStateRef.current);
    return () => {
      coordinator.stop();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [appSession?.sessionId, authUid]);

  useEffect(() => {
    coordinatorRef.current?.update({
      authUid,
      sessionId: appSession?.sessionId || null,
      tourId: tourId || null,
      operationalEligible: Boolean(appSession?.sessionId && tourId),
      isConnected: isConnected !== false,
    });
  }, [appSession?.sessionId, authUid, isConnected, tourId]);
}
