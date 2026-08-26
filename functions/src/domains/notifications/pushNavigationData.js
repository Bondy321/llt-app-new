'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { resolveTrimmedString } = require('./notificationPolicy');

const PUSH_NOTIFICATION_SCREENS = new Set([
  'Chat', 'Itinerary', 'GroupPhotobook', 'NotificationPreferences', 'SafetySupport', 'DriverTourPack',
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

/** @type {(...args: any[]) => any} */
const buildPushNavigationData = (options = {}) => {
  const screen = options.screen;
  if (!PUSH_NOTIFICATION_SCREENS.has(screen)) throw new Error('Unsupported notification destination');

  const safeTourId = resolveTrimmedString(options.tourId);
  if (screen !== 'NotificationPreferences' && !safeTourId) {
    throw new Error('Tour-scoped notification requires a tour id');
  }
  if (safeTourId && (!isValidFirebaseKey(safeTourId) || safeTourId.length > 160)) {
    throw new Error('Notification tour id is invalid');
  }

  const timestamp = options.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new Error('Notification timestamp must be a positive integer');
  }

  /** @type {Record<string, any>} */
  const navigation = { screen, timestamp };
  assignTrimmedValue(navigation, 'tourId', safeTourId, 160);
  assignTrimmedValue(navigation, 'noticeId', options.noticeId, 160);
  assignTrimmedValue(navigation, 'messageId', options.messageId, 160);
  assignTrimmedValue(navigation, 'notificationType', options.notificationType, 80);
  assignTrimmedValue(navigation, 'categoryKey', options.categoryKey, 80);
  assignTrimmedValue(navigation, 'broadcastId', options.broadcastId, 160);
  assignTrimmedValue(navigation, 'departureKey', options.departureKey, 160);
  if (options.internalDriverChat === true) navigation.internalDriverChat = true;
  if (Number.isSafeInteger(options.revision) && options.revision >= 1) navigation.revision = options.revision;
  if (Array.isArray(options.changedSections) && options.changedSections.length) {
    navigation.changedSections = options.changedSections.join(',').slice(0, 240);
  }
  if (options.critical === true) navigation.critical = true;
  if (options.requiresAcknowledgement === true) navigation.requiresAcknowledgement = true;
  return navigation;
};

module.exports = { buildPushNavigationData };
