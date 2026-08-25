import { useEffect, useRef } from 'react';
import logger from '../../../services/loggerService';
import { markNotificationRead } from '../../../services/notificationInboxService';
import {
  restorePushTokenForSession,
  subscribeToNotificationResponses,
} from '../../../services/notificationService';

export default function useNotificationSessionNavigation({
  authUid,
  bookingId,
  isDriver,
  navigateTo,
  tourId,
}) {
  const navigateRef = useRef(navigateTo);
  navigateRef.current = navigateTo;

  useEffect(() => {
    const hasAppSession = Boolean(bookingId);
    if (!authUid || !hasAppSession) return undefined;

    return subscribeToNotificationResponses({
      getContext: () => ({ activeTourId: tourId, isDriver: Boolean(isDriver) }),
      onNavigate: async ({ screen, params }) => {
        const responseTourId = params?.tourId || tourId;
        if (params?.noticeId && responseTourId) {
          try {
            await markNotificationRead({
              tourId: responseTourId,
              userId: authUid,
              noticeId: params.noticeId,
            });
          } catch (error) {
            logger.warn('Navigation', 'Notification read state could not be persisted', {
              screen,
              error: error?.message || String(error),
            });
          }
        }
        const navigate = navigateRef.current;
        if (typeof navigate !== 'function') throw new Error('Notification navigation is not ready');
        navigate(screen, params);
      },
    });
  }, [authUid, bookingId, isDriver, tourId]);

  useEffect(() => {
    if (!authUid || !tourId) return;
    restorePushTokenForSession(authUid)
      .then((result) => {
        if (!result?.success) {
          logger.warn('NotificationService', 'Signed-in push token restore was deferred', {
            error: result?.error || 'unknown',
          });
        }
      })
      .catch((error) => logger.warn('NotificationService', 'Signed-in push token restore failed', {
        error: error?.message || String(error),
      }));
  }, [authUid, tourId]);
}
