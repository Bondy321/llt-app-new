'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { resolveTrimmedString } = require('./notificationPolicy');

const PUSH_NOTIFICATION_SCREENS = new Set([
  'Chat', 'Itinerary', 'GroupPhotobook', 'NotificationPreferences', 'SafetySupport', 'DriverTourPack',
  'MarketingNotificationDetail', 'SafetyAlertDetail',
]);

/** @param {Record<string, any>} target @param {string} key @param {unknown} value @param {number} maxLength */
const assignTrimmedValue = (target, key, value, maxLength) => {
  const resolved = resolveTrimmedString(value);
  if (!resolved) return;
  if (resolved.length > maxLength) {
    throw new Error(`Notification ${key} exceeds ${maxLength} characters`);
  }
  target[key] = resolved;
};

const buildBaseNavigation = (options) => {
  const screen = options.screen;
  if (!PUSH_NOTIFICATION_SCREENS.has(screen)) throw new Error('Unsupported notification destination');
  const safeTourId = resolveTrimmedString(options.tourId);
  if (!['NotificationPreferences', 'MarketingNotificationDetail'].includes(screen) && !safeTourId) throw new Error('Tour-scoped notification requires a tour id');
  if (safeTourId && (!isValidFirebaseKey(safeTourId) || safeTourId.length > 160)) throw new Error('Notification tour id is invalid');
  const timestamp = options.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Notification timestamp must be a positive integer');
  return { screen, safeTourId, timestamp, navigation: { screen, timestamp } };
};

const assignStandardNavigationValues = (navigation, options, safeTourId) => {
  [['tourId', safeTourId, 160], ['noticeId', options.noticeId, 160], ['messageId', options.messageId, 160],
    ['notificationType', options.notificationType, 80], ['categoryKey', options.categoryKey, 80],
    ['broadcastId', options.broadcastId, 160], ['departureKey', options.departureKey, 160],
    ['eventId', options.eventId, 160], ['photoId', options.photoId, 160]]
    .forEach(([key, value, maxLength]) => assignTrimmedValue(navigation, key, value, maxLength));
};

const assignOptionalNavigationValues = (navigation, options, timestamp) => {
  if (options.expiresAtMs !== undefined) {
    if (!Number.isSafeInteger(options.expiresAtMs) || options.expiresAtMs <= timestamp) throw new Error('Notification expiry must follow its timestamp');
    navigation.expiresAtMs = options.expiresAtMs;
  }
  if (options.internalDriverChat === true) navigation.internalDriverChat = true;
  if (Number.isSafeInteger(options.revision) && options.revision >= 1) navigation.revision = options.revision;
  if (Array.isArray(options.changedSections) && options.changedSections.length) navigation.changedSections = options.changedSections.join(',').slice(0, 240);
  if (options.critical === true) navigation.critical = true;
  if (options.requiresAcknowledgement === true) navigation.requiresAcknowledgement = true;
};

const validateNavigationDestination = (navigation) => {
  if (navigation.screen === 'Chat' && (!navigation.tourId || !navigation.messageId)) throw new Error('Chat notifications require tourId and messageId');
  if (navigation.screen === 'SafetyAlertDetail' && (!navigation.tourId || !navigation.eventId)) throw new Error('Safety detail notifications require tourId and eventId');
  if (navigation.screen === 'MarketingNotificationDetail' && (!navigation.categoryKey || !navigation.broadcastId || navigation.tourId)) throw new Error('Marketing detail notifications require categoryKey and broadcastId only');
};

/** @type {(...args: any[]) => any} */
const buildPushNavigationData = (options = {}) => {
  const { safeTourId, timestamp, navigation } = buildBaseNavigation(options);
  assignStandardNavigationValues(navigation, options, safeTourId);
  assignOptionalNavigationValues(navigation, options, timestamp);
  validateNavigationDestination(navigation);
  return navigation;
};

module.exports = { buildPushNavigationData };
