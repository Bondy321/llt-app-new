'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { isExpoPushToken } = require('../../infrastructure/notifications/expoPushClient');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('../../infrastructure/validation/stringNormalization');
const TOUR_NOTIFICATION_CATEGORY_LABELS = Object.freeze({
  day_trips: 'Day Trips',
  mystery_breaks: 'Mystery Breaks',
  scotland_highlands_islands: 'Scotland, Highlands & Islands',
  isle_of_ireland: 'Isle of Ireland',
  european_breaks: 'European Breaks',
  steam_train_tours: 'Steam Train Tours',
  cruises_ferries: 'Cruises & Ferries',
  theatre_concerts: 'Theatre & Concerts',
  sporting_breaks: 'Sporting Breaks',
  history_military_breaks: 'History & Military Breaks',
});
const TOUR_NOTIFICATION_CATEGORY_KEYS = Object.freeze(Object.keys(TOUR_NOTIFICATION_CATEGORY_LABELS));
const LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS = Object.freeze({
  mystery_breaks: ['mystery_tours'],
  scotland_highlands_islands: ['scotland_classics', 'hiking_nature'],
  steam_train_tours: ['steam_trains'],
});

/** @type {(...args: any[]) => any} */
const compactNotificationText = (value, maxLength = 220) => {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};


const validateMessageIdentity = (messageData, errors) => {
  if (!messageData.senderId || typeof messageData.senderId !== 'string') errors.push('Invalid or missing senderId');
  if (!messageData.senderName || typeof messageData.senderName !== 'string') errors.push('Invalid or missing senderName');
};
const validateMessageText = (messageData, messageType, errors) => {
  if (typeof messageData.text !== 'string') errors.push('Invalid or missing message text');
  else if (messageData.text.length > 10000) errors.push('Message text exceeds maximum length (10000 characters)');
  else if (messageType !== 'image' && messageData.text.trim().length === 0) errors.push('Message text cannot be empty');
};
const validateImageMessage = (messageData, errors) => {
  if (Number(messageData.schemaVersion) === 2) {
    const photoId = resolveTrimmedString(messageData.photoId);
    if (!photoId || photoId.length > 160 || !isValidFirebaseKey(photoId)) errors.push('Schema-version 2 image messages require a valid photoId');
    if (resolveTrimmedString(messageData.imageUrl) || resolveTrimmedString(messageData.thumbnailUrl)) errors.push('Schema-version 2 image messages cannot contain durable media URLs');
  } else if (!resolveTrimmedString(messageData.imageUrl)) errors.push('Legacy image messages require an imageUrl');
};
/** @type {(...args: any[]) => any} */
const validateMessageData = (messageData) => {
  const errors = [];
  if (!messageData) return { valid: false, errors: ['Message data is null or undefined'] };
  validateMessageIdentity(messageData, errors);

  const messageType = resolveTrimmedString(messageData.type) || 'text';
  validateMessageText(messageData, messageType, errors);
  if (messageType === 'image') validateImageMessage(messageData, errors);
  else if (!['text', 'system'].includes(messageType)) errors.push('Unsupported message type');

  return { valid: errors.length === 0, errors };
};

/**
 * Validates and sanitizes push token
 */
/** @type {(...args: any[]) => any} */
const normalizePushToken = (token) => {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** @type {(...args: any[]) => any} */
const isValidPushToken = (token) => {
  const normalizedToken = normalizePushToken(token);
  return Boolean(normalizedToken && isExpoPushToken(normalizedToken));
};

/** @type {(...args: any[]) => any} */
const shouldRemoveInvalidToken = (userData, token) => {
  const storedToken = normalizePushToken(userData?.pushToken) || '';
  const failedToken = normalizePushToken(token) || '';
  return Boolean(storedToken && failedToken && storedToken === failedToken);
};

/**
 * Safely removes invalid push tokens from user profiles
 */
/** @type {(userId: string, token: string, options?: { reason?: string }) => Promise<void>} */
const removeInvalidToken = async (userId, token, options = {}) => {
  const { reason = 'INVALID_TOKEN' } = options;
  const nowIso = new Date().toISOString();

  try {
    const userRef = admin.database().ref(`users/${userId}`);
    const result = await userRef.transaction((userData) => {
      if (!shouldRemoveInvalidToken(userData, token)) {
        return userData;
      }

      return {
        ...userData,
        pushToken: null,
        pushTokenStatus: 'INVALID',
        pushTokenInvalidReason: reason,
        pushTokenUpdatedAt: nowIso,
        lastUpdated: nowIso,
      };
    });

    const tokenRemoved = Boolean(
      result?.committed
      && result?.snapshot?.exists?.()
      && result?.snapshot?.val?.()?.pushToken === null
    );

    if (tokenRemoved) {
      log.info('Removed invalid token', { userId, reason });
    } else {
      log.info('Skipped invalid token cleanup because stored token changed', { userId, reason });
    }
  } catch (error) {
    log.error('Failed to remove invalid token', error, { userId, reason });
  }
};

/** @type {(...args: any[]) => any} */
const getPreferenceValue = (userData, prefPath, defaultValue = true) => {
  return prefPath.reduce(/** @param {any} value @param {string} key */ (value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    return value[key];
  }, userData) ?? defaultValue;
};

/** @type {(...args: any[]) => any} */
const buildChatNotificationContent = ({ messageData = {}, tourName = 'Tour Chat', isAdmin = false } = {}) => {
  const senderName = compactNotificationText(messageData.senderName || 'Tour participant', 100);
  const messageType = resolveTrimmedString(messageData.type) || 'text';
  const rawText = resolveTrimmedString(messageData.text);
  const previewText = messageType === 'image' && !rawText ? 'Shared a photo' : rawText;
  const truncatedMessage = compactNotificationText(previewText, 200);

  return {
    title: isAdmin ? `📢 ${tourName} Announcement` : `New message in ${tourName}`,
    body: isAdmin
      ? truncatedMessage.replace(/^ANNOUNCEMENT:\s*/i, '')
      : `${senderName}: ${truncatedMessage}`,
  };
};

/** @type {(...args: any[]) => any} */
const buildSafetyNotificationContent = ({ alert = {}, tourName = 'your tour' } = {}) => {
  const isCritical = alert.isSOS === true || alert.severity === 'critical';
  const category = compactNotificationText(
    String(alert.category || 'safety report').replace(/_/g, ' '),
    60,
  );
  return {
    title: isCritical ? `Urgent safety alert · ${tourName}` : `Safety report · ${tourName}`,
    body: isCritical
      ? `A critical ${category} report needs immediate attention. Open the app for details.`
      : `A ${category} report was submitted. Open the app for details.`,
    priority: isCritical ? 'high' : 'default',
  };
};

/** @type {(...args: any[]) => any} */
const readBooleanPreference = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'enabled' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === 'disabled' || normalized === 'off') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
};

/** @type {(...args: any[]) => any} */
const isSupportedTourNotificationCategory = (categoryKey) => (
  typeof categoryKey === 'string'
  && Object.prototype.hasOwnProperty.call(TOUR_NOTIFICATION_CATEGORY_LABELS, categoryKey)
);

/** @type {(...args: any[]) => any} */
const resolveTourNotificationCategoryLabel = (categoryKey) => (
  /** @type {Record<string, string>} */ (TOUR_NOTIFICATION_CATEGORY_LABELS)[categoryKey] || categoryKey
);

/** @type {(...args: any[]) => any} */
const userWantsTourCategoryBroadcast = (userData = {}, categoryKey) => {
  const marketingPrefs = userData?.preferences?.marketing;
  if (!marketingPrefs || typeof marketingPrefs !== 'object') {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(marketingPrefs, categoryKey)) {
    return readBooleanPreference(marketingPrefs[categoryKey], false);
  }

  return (/** @type {Record<string, string[]>} */ (LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS)[categoryKey] || [])
    .some(/** @param {string} legacyKey */ (legacyKey) => (
    readBooleanPreference(marketingPrefs[legacyKey], false)
  ));
};

/** @type {(...args: any[]) => any} */
const getPushTokenIneligibilityReason = (userData = {}) => {
  const tokenStatus = typeof userData?.pushTokenStatus === 'string'
    ? userData.pushTokenStatus.trim().toUpperCase()
    : '';
  if (tokenStatus !== 'ACTIVE') {
    return tokenStatus ? `token_status_${tokenStatus.toLowerCase()}` : 'token_status_missing';
  }

  const permissionState = typeof userData?.pushPermissionState === 'string'
    ? userData.pushPermissionState.trim().toLowerCase()
    : '';
  if (permissionState !== 'granted') {
    return permissionState ? `permission_${permissionState}` : 'permission_missing';
  }

  return null;
};

/** @type {(...args: any[]) => any} */
const chunkArrayDeterministically = (items, size) => {
  const sortedItems = [...items].sort((a, b) => a.localeCompare(b));
  const chunks = [];

  for (let index = 0; index < sortedItems.length; index += size) {
    chunks.push(sortedItems.slice(index, index + size));
  }

  return chunks;
};

module.exports = {
  buildChatNotificationContent,
  buildSafetyNotificationContent,
  chunkArrayDeterministically,
  compactNotificationText,
  getPreferenceValue,
  getPushTokenIneligibilityReason,
  isSupportedTourNotificationCategory,
  isValidPushToken,
  normalizePushToken,
  normalizeTourKeyForComparison,
  readBooleanPreference,
  removeInvalidToken,
  resolveTourNotificationCategoryLabel,
  resolveTrimmedString,
  shouldRemoveInvalidToken,
  toRealtimeKeySegment,
  TOUR_NOTIFICATION_CATEGORY_KEYS,
  TOUR_NOTIFICATION_CATEGORY_LABELS,
  userWantsTourCategoryBroadcast,
  validateMessageData,
};
