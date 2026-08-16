const { normalizeTourId } = require('../services/tourIdentityService');

const TOUR_SCOPED_NOTIFICATION_SCREENS = new Set(['Chat', 'Itinerary', 'GroupPhotobook', 'SafetySupport']);
const GLOBAL_NOTIFICATION_SCREENS = new Set(['NotificationPreferences']);
const SUPPORTED_NOTIFICATION_SCREENS = new Set([
  ...TOUR_SCOPED_NOTIFICATION_SCREENS,
  ...GLOBAL_NOTIFICATION_SCREENS,
]);

const readOptionalString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const readNotificationData = (value = {}) => (
  value?.notification?.request?.content?.data
  || value?.request?.content?.data
  || value?.content?.data
  || value?.data
  || {}
);

const getNotificationResponseKey = (value = {}) => {
  const request = value?.notification?.request || value?.request || {};
  const data = readNotificationData(value);
  return String(
    request.identifier
    || data.noticeId
    || data.messageId
    || [
      data.screen,
      data.tourId,
      data.noticeId,
      data.messageId,
      data.broadcastId,
      data.categoryKey,
      data.timestamp,
    ].map((part) => readOptionalString(part) || String(part || 'unknown')).join(':')
  );
};

const resolveNotificationRoute = (value, context = {}) => {
  const data = readNotificationData(value);
  const screen = typeof data.screen === 'string' ? data.screen.trim() : '';
  const notificationTourId = normalizeTourId(data.tourId);
  const activeTourId = normalizeTourId(context.activeTourId);

  if (!SUPPORTED_NOTIFICATION_SCREENS.has(screen)) {
    return { accepted: false, reason: 'UNSUPPORTED_SCREEN' };
  }
  if (TOUR_SCOPED_NOTIFICATION_SCREENS.has(screen)) {
    if (!notificationTourId) {
      return { accepted: false, reason: 'MISSING_TOUR' };
    }
    if (!activeTourId) {
      return { accepted: false, reason: 'NO_ACTIVE_TOUR' };
    }
    if (notificationTourId !== activeTourId) {
      return { accepted: false, reason: 'TOUR_MISMATCH' };
    }
  }

  const params = {
    ...(notificationTourId ? { tourId: notificationTourId } : {}),
    fromNotification: true,
    noticeId: readOptionalString(data.noticeId),
  };

  if (screen === 'Chat') {
    params.messageId = readOptionalString(data.messageId);
    params.isDriver = Boolean(context.isDriver);
    params.internalDriverChat = data.internalDriverChat === true;
  }
  if (screen === 'Itinerary') {
    params.isDriver = Boolean(context.isDriver);
  }
  if (screen === 'SafetySupport') {
    params.mode = context.isDriver ? 'driver' : 'passenger';
    params.from = context.isDriver ? 'DriverHome' : 'TourHome';
  }
  if (screen === 'NotificationPreferences') {
    params.returnTo = context.isDriver ? 'DriverHome' : 'TourHome';
    params.categoryKey = readOptionalString(data.categoryKey);
    params.broadcastId = readOptionalString(data.broadcastId);
  }

  return {
    accepted: true,
    screen,
    params,
    responseKey: getNotificationResponseKey(value),
  };
};

module.exports = {
  GLOBAL_NOTIFICATION_SCREENS,
  SUPPORTED_NOTIFICATION_SCREENS,
  TOUR_SCOPED_NOTIFICATION_SCREENS,
  getNotificationResponseKey,
  readNotificationData,
  resolveNotificationRoute,
};
