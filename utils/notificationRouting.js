const { normalizeTourId } = require('../services/tourIdentityService');
const { isSafeNotificationNavigationPayload } = require('../src/app/navigation/notificationNavigationBoundary');

const TOUR_SCOPED_NOTIFICATION_SCREENS = new Set(['Chat', 'Itinerary', 'GroupPhotobook', 'SafetySupport', 'DriverTourPack', 'SafetyAlertDetail']);
const GLOBAL_NOTIFICATION_SCREENS = new Set(['NotificationPreferences', 'MarketingNotificationDetail']);
const SUPPORTED_MARKETING_CATEGORY_KEYS = new Set([
  'day_trips',
  'mystery_breaks',
  'scotland_highlands_islands',
  'isle_of_ireland',
  'european_breaks',
  'steam_train_tours',
  'cruises_ferries',
  'theatre_concerts',
  'sporting_breaks',
  'history_military_breaks',
]);
const SUPPORTED_NOTIFICATION_SCREENS = new Set([
  ...TOUR_SCOPED_NOTIFICATION_SCREENS,
  ...GLOBAL_NOTIFICATION_SCREENS,
]);
const NOTIFICATION_RESPONSE_DISPOSITIONS = Object.freeze({
  ACCEPTED: 'accepted',
  TRANSIENTLY_DEFERRED: 'transiently_deferred',
  DEFINITIVELY_REJECTED: 'definitively_rejected',
});

const readOptionalString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);
const readSafeDepartureKey = (value) => {
  const key = readOptionalString(value);
  return key && /^\d{4}-\d{2}-\d{2}::[A-Z0-9_-]{1,120}$/i.test(key) ? key : null;
};
const readRevision = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const readChangedSections = (value) => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(source
    .filter((item) => typeof item === 'string' && /^(status|tour|pickups|passengers|seats|timeline|hotels|services|coach|contacts|itineraries|coverage|quality)$/i.test(item.trim()))
    .map((item) => item.trim().toLowerCase()))].slice(0, 13);
};

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
      data.timestamp
        || data.eventId
        || data.photoId
        || (data.departureKey ? `${data.departureKey}:${data.revision || 'unknown'}` : null),
    ].map((part) => readOptionalString(part) || String(part || 'unknown')).join(':')
  );
};

const withDisposition = (route, disposition) => {
  // Keep historical deep-equality/public route shapes compatible while making
  // disposition directly readable by the response lifecycle.
  Object.defineProperty(route, 'disposition', { enumerable: false, value: disposition });
  return route;
};
const rejectedRoute = (reason, transient = false) => withDisposition(
  { accepted: false, reason },
  transient
    ? NOTIFICATION_RESPONSE_DISPOSITIONS.TRANSIENTLY_DEFERRED
    : NOTIFICATION_RESPONSE_DISPOSITIONS.DEFINITIVELY_REJECTED,
);

const resolveNotificationRoute = (value, context = {}) => {
  const data = readNotificationData(value);
  const screen = typeof data.screen === 'string' ? data.screen.trim() : '';
  const notificationTourId = normalizeTourId(data.tourId);
  const activeTourId = normalizeTourId(context.activeTourId);
  const expiresAtMs = Number.isSafeInteger(data.expiresAtMs) ? data.expiresAtMs : null;

  const nowMs = Number.isSafeInteger(context.nowMs) ? context.nowMs : Date.now();
  if (expiresAtMs && expiresAtMs <= nowMs) return rejectedRoute('EXPIRED');

  if (!SUPPORTED_NOTIFICATION_SCREENS.has(screen)) {
    return rejectedRoute('UNSUPPORTED_SCREEN');
  }
  if (TOUR_SCOPED_NOTIFICATION_SCREENS.has(screen)) {
    if (!notificationTourId) {
      return rejectedRoute('MISSING_TOUR');
    }
    // Safety detail is deliberately server-authorised. Operations users do not
    // need a tour app session; assigned-driver authority is rechecked remotely.
    if (screen === 'SafetyAlertDetail') {
      if (context.hasAuth !== true) {
        return rejectedRoute('NO_AUTH', context.authContextSettled === false);
      }
    } else {
      if (!activeTourId) {
        return rejectedRoute('NO_ACTIVE_TOUR', context.sessionContextSettled === false);
      }
      if (notificationTourId !== activeTourId) {
        return rejectedRoute('TOUR_MISMATCH');
      }
    }
  }
  if (screen === 'DriverTourPack' && context.isDriver !== true) {
    return rejectedRoute('DRIVER_ONLY', context.roleContextSettled === false);
  }
  const marketingCategoryKey = (screen === 'NotificationPreferences' || screen === 'MarketingNotificationDetail')
    ? readOptionalString(data.categoryKey)
    : null;
  if (marketingCategoryKey && !SUPPORTED_MARKETING_CATEGORY_KEYS.has(marketingCategoryKey)) {
    return rejectedRoute('UNSUPPORTED_MARKETING_CATEGORY');
  }
  if ((screen === 'NotificationPreferences' || screen === 'MarketingNotificationDetail')
    && data.notificationType === 'category_broadcast'
    && (!marketingCategoryKey || !readOptionalString(data.broadcastId))) {
    return rejectedRoute('INVALID_MARKETING_NOTIFICATION');
  }
  const driverPackDepartureKey = screen === 'DriverTourPack' ? readSafeDepartureKey(data.departureKey) : null;
  const driverPackRevision = screen === 'DriverTourPack' ? readRevision(data.revision) : null;
  if (screen === 'DriverTourPack' && (!driverPackDepartureKey || !driverPackRevision)) {
    return rejectedRoute('INVALID_DRIVER_PACK_NOTIFICATION');
  }
  if (screen === 'DriverTourPack' && driverPackDepartureKey.slice(driverPackDepartureKey.indexOf('::') + 2) !== notificationTourId) {
    return rejectedRoute('DRIVER_PACK_IDENTITY_MISMATCH');
  }
  if (!isSafeNotificationNavigationPayload(data)) {
    return rejectedRoute('INVALID_PAYLOAD');
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
  if (screen === 'DriverTourPack') {
    params.departureKey = driverPackDepartureKey;
    params.revision = driverPackRevision;
    params.changedSections = readChangedSections(data.changedSections);
    params.critical = data.critical === true;
    params.requiresAcknowledgement = data.requiresAcknowledgement === true;
  }
  if (screen === 'NotificationPreferences') {
    params.returnTo = context.isDriver ? 'DriverHome' : 'TourHome';
    params.categoryKey = marketingCategoryKey;
    params.broadcastId = readOptionalString(data.broadcastId);
  }
  if (screen === 'MarketingNotificationDetail' && context.hasAuth === false) {
    return rejectedRoute('NO_AUTH', context.authContextSettled === false);
  }
  if (screen === 'MarketingNotificationDetail') {
    params.categoryKey = marketingCategoryKey;
    params.broadcastId = readOptionalString(data.broadcastId);
  }
  if (screen === 'SafetyAlertDetail') {
    const eventId = readOptionalString(data.eventId);
    if (!eventId) return rejectedRoute('MISSING_EVENT');
    params.eventId = eventId;
    params.from = context.isDriver === true ? 'DriverHome' : 'Login';
  }

  return withDisposition({
    accepted: true,
    screen,
    params,
    responseKey: getNotificationResponseKey(value),
  }, NOTIFICATION_RESPONSE_DISPOSITIONS.ACCEPTED);
};

module.exports = {
  GLOBAL_NOTIFICATION_SCREENS,
  NOTIFICATION_RESPONSE_DISPOSITIONS,
  SUPPORTED_NOTIFICATION_SCREENS,
  TOUR_SCOPED_NOTIFICATION_SCREENS,
  getNotificationResponseKey,
  readNotificationData,
  readSafeDepartureKey,
  readRevision,
  readChangedSections,
  resolveNotificationRoute,
};
