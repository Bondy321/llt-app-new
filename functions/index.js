/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 * Updated for Cloud Functions Gen 2 (v2) - Region Fix
 * Enhanced with comprehensive error handling, validation, and performance improvements
 */

const { onValueCreated, onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");
const sharp = require("sharp");
const { createHash, randomUUID } = require("crypto");
const { normalizeManifestPassengerRows } = require('./lib/manifestPassengers');
const {
  INGESTION_LIMITS: DRIVER_TOUR_PACK_INGESTION_LIMITS,
  createDriverTourPackPublisher,
} = require('./lib/driverTourPackPublisher');
const {
  DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
} = require('./lib/managementOidc');
const { cleanupExpiredDriverTourPacks } = require('./lib/driverTourPackExpiryCleanup');
const { cleanupExpiredDriverLocations } = require('./lib/driverLocationExpiryCleanup');
const {
  createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits,
} = require('./lib/loginRateLimiter');
const {
  buildDriverTourPackActionProjectionUpdates,
  summarizeDriverTourPackChange,
} = require('./lib/driverTourPackOperations');
const { deriveTourDateIndexUpdate } = require('./lib/tourDateIndex');
const {
  PASSENGER_IDENTITY_VERSION,
  authorizePassengerLoginDevice,
  buildPassengerIdentitySecurityUpdates,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
} = require('./lib/passengerIdentity');
const {
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
  calculateSessionExpiry,
  createAppSessionId,
  isActiveSessionRecord,
  isValidAppSessionId,
  toClientSession,
} = require('./lib/appSession');
const {
  acquireAppSessionLock,
  releaseAppSessionLock,
} = require('./lib/appSessionLock');
const { verifyActiveAppSession } = require('./lib/appSessionAccess');
const {
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupAppSession,
  cleanupDriverLocationForSession,
} = require('./lib/appSessionCleanup');

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Expo SDK
const expo = new Expo();

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;
const USER_PROFILE_FETCH_CHUNK_SIZE = 100;
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_PROFILE_CACHE_MAX_ENTRIES = 5000;
const TOUR_NOTIFICATION_MAX_RECORDS = 100;
const NOTIFICATION_READ_CLEANUP_JOB_BATCH_SIZE = 10;
const NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_CONCURRENCY = 5;
const LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH = 'notification_read_legacy_cleanup_state/v1';
const LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH = 'notification_read_legacy_cleanup_queue';
const LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE = 200;
const userProfileCache = new Map();
const PHOTO_CACHE_CONTROL_HEADER = "private,max-age=300,no-transform";
const PRIVATE_PHOTO_CACHE_CONTROL_HEADER = "private,no-store";
const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;
const VERIFIED_LOGIN_GRANT_TTL_MS = 30 * 60 * 1000;
const MANUAL_BOOKING_LOCK_TTL_MS = 30 * 1000;
const DRIVER_ASSIGNMENT_LOCK_TTL_MS = 30 * 1000;
const TOUR_DELETION_LOCK_TTL_MS = 10 * 60 * 1000;
const SAFETY_SUBMISSION_LOCK_TTL_MS = 30 * 1000;
const SAFETY_RATE_LIMIT_ROOT = 'safety_rate_limits/v1';
const SAFETY_RATE_LIMIT_MAX_REQUESTS = 20;
const SAFETY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const MANIFEST_STATUS = {
  PENDING: 'PENDING',
  BOARDED: 'BOARDED',
  NO_SHOW: 'NO_SHOW',
  PARTIAL: 'PARTIAL',
};
const TOUR_NOTIFICATION_CATEGORY_LABELS = {
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
};
const TOUR_NOTIFICATION_CATEGORY_KEYS = Object.freeze(Object.keys(TOUR_NOTIFICATION_CATEGORY_LABELS));
const PUSH_NOTIFICATION_SCREENS = new Set(['Chat', 'Itinerary', 'GroupPhotobook', 'NotificationPreferences', 'SafetySupport', 'DriverTourPack']);
const SAFETY_CATEGORIES = new Set([
  'delay',
  'incident',
  'medical',
  'lost_passenger',
  'vehicle_issue',
  'sos',
  'harassment',
  'weather',
  'custom',
]);
const SAFETY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS = {
  mystery_breaks: ['mystery_tours'],
  scotland_highlands_islands: ['scotland_classics', 'hiking_nature'],
  steam_train_tours: ['steam_trains'],
};

// ==================== UTILITY FUNCTIONS ====================

const maskIdentifier = (value) => {
  if (value === null || value === undefined) return value;
  const asString = String(value);
  if (asString.length <= 4) return '***';
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

const isSensitiveLogKey = (key) => {
  const normalized = String(key || '').toLowerCase();
  return /(token|bookingref|clientkey|userid|senderid|senderuid|authuid|participantid|recipientid|email|clientip|ipaddress)/.test(normalized);
};

const sanitizeLogValue = (key, value) => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => (
      isSensitiveLogKey(key) && (typeof item !== 'object' || item === null)
        ? maskIdentifier(item)
        : sanitizeLogValue(key, item)
    ));
  }

  if (typeof value === 'object') {
    return Object.entries(value).reduce((sanitized, [childKey, childValue]) => {
      sanitized[childKey] = sanitizeLogValue(childKey, childValue);
      return sanitized;
    }, {});
  }

  if (/token/.test(String(key || '').toLowerCase())) {
    return '[redacted]';
  }

  if (isSensitiveLogKey(key)) {
    return maskIdentifier(value);
  }

  return value;
};

const sanitizeLogData = (data = {}) => sanitizeLogValue('', data) || {};

const sanitizeLogText = (value) => {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bExponentPushToken\[[^\]]+\]/g, 'ExponentPushToken[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]');
};

/**
 * Structured logger for better debugging and monitoring
 */
const log = {
  info: (message, data = {}) => console.log(JSON.stringify({
    level: 'info',
    message,
    ...sanitizeLogData(data),
    timestamp: new Date().toISOString(),
  })),
  error: (message, error = {}, data = {}) => console.error(JSON.stringify({
    level: 'error',
    message,
    error: sanitizeLogText(error?.message || error || null),
    stack: error?.stack ? sanitizeLogText(error.stack) : null,
    ...sanitizeLogData(data),
    timestamp: new Date().toISOString(),
  })),
  warn: (message, data = {}) => console.warn(JSON.stringify({
    level: 'warn',
    message,
    ...sanitizeLogData(data),
    timestamp: new Date().toISOString(),
  })),
};

/**
 * Validates message data
 */
const validateMessageData = (messageData) => {
  const errors = [];

  if (!messageData) {
    errors.push('Message data is null or undefined');
    return { valid: false, errors };
  }

  if (!messageData.senderId || typeof messageData.senderId !== 'string') {
    errors.push('Invalid or missing senderId');
  }

  if (!messageData.senderName || typeof messageData.senderName !== 'string') {
    errors.push('Invalid or missing senderName');
  }

  const messageType = resolveTrimmedString(messageData.type) || 'text';
  if (typeof messageData.text !== 'string') {
    errors.push('Invalid or missing message text');
  } else if (messageData.text.length > 10000) {
    errors.push('Message text exceeds maximum length (10000 characters)');
  } else if (messageType !== 'image' && messageData.text.trim().length === 0) {
    errors.push('Message text cannot be empty');
  }

  if (messageType === 'image' && !resolveTrimmedString(messageData.imageUrl)) {
    errors.push('Image messages require an imageUrl');
  } else if (messageType !== 'text' && messageType !== 'image' && messageType !== 'system') {
    errors.push('Unsupported message type');
  }

  return { valid: errors.length === 0, errors };
};

/**
 * Validates and sanitizes push token
 */
const normalizePushToken = (token) => {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isValidPushToken = (token) => {
  const normalizedToken = normalizePushToken(token);
  return Boolean(normalizedToken && Expo.isExpoPushToken(normalizedToken));
};

const shouldRemoveInvalidToken = (userData, token) => {
  const storedToken = normalizePushToken(userData?.pushToken) || '';
  const failedToken = normalizePushToken(token) || '';
  return Boolean(storedToken && failedToken && storedToken === failedToken);
};

/**
 * Safely removes invalid push tokens from user profiles
 */
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

const getPreferenceValue = (userData, prefPath, defaultValue = true) => {
  return prefPath.reduce((value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    return value[key];
  }, userData) ?? defaultValue;
};

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

const isSupportedTourNotificationCategory = (categoryKey) => (
  typeof categoryKey === 'string'
  && Object.prototype.hasOwnProperty.call(TOUR_NOTIFICATION_CATEGORY_LABELS, categoryKey)
);

const resolveTourNotificationCategoryLabel = (categoryKey) => (
  TOUR_NOTIFICATION_CATEGORY_LABELS[categoryKey] || categoryKey
);

const userWantsTourCategoryBroadcast = (userData = {}, categoryKey) => {
  const marketingPrefs = userData?.preferences?.marketing;
  if (!marketingPrefs || typeof marketingPrefs !== 'object') {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(marketingPrefs, categoryKey)) {
    return readBooleanPreference(marketingPrefs[categoryKey], false);
  }

  return (LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS[categoryKey] || []).some((legacyKey) => (
    readBooleanPreference(marketingPrefs[legacyKey], false)
  ));
};

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

const resolveTrimmedString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toRealtimeKeySegment = (value) => {
  const trimmed = resolveTrimmedString(value);
  if (!trimmed) return null;

  return trimmed.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  );
};

const normalizeTourKeyForComparison = (value) => {
  const trimmed = resolveTrimmedString(value);
  if (!trimmed) return null;

  const normalized = trimmed
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(REALTIME_KEY_INVALID_GLOBAL_PATTERN, '')
    .replace(/^_+|_+$/g, '');

  return normalized || null;
};

const chunkArrayDeterministically = (items, size) => {
  const sortedItems = [...items].sort((a, b) => a.localeCompare(b));
  const chunks = [];

  for (let index = 0; index < sortedItems.length; index += size) {
    chunks.push(sortedItems.slice(index, index + size));
  }

  return chunks;
};

const applyRecipientCap = (participantIds, cap, context = {}) => {
  if (!Array.isArray(participantIds)) return [];
  const sortedIds = [...participantIds].sort((a, b) => a.localeCompare(b));

  if (sortedIds.length <= cap) {
    return sortedIds;
  }

  const selected = sortedIds.slice(0, cap);
  log.warn('Participant cap applied for notification run', {
    ...context,
    cap,
    totalParticipants: sortedIds.length,
    skippedParticipants: sortedIds.length - selected.length,
  });
  return selected;
};

const getCachedUserProfile = (userId) => {
  const cached = userProfileCache.get(userId);
  if (!cached) return null;

  if ((Date.now() - cached.cachedAt) > USER_PROFILE_CACHE_TTL_MS) {
    userProfileCache.delete(userId);
    return null;
  }

  return cached.profile;
};

const cleanupUserProfileCache = (now = Date.now()) => {
  let removed = 0;
  for (const [userId, cached] of userProfileCache.entries()) {
    if ((now - cached.cachedAt) > USER_PROFILE_CACHE_TTL_MS) {
      userProfileCache.delete(userId);
      removed += 1;
    }
  }

  return removed;
};

const enforceUserProfileCacheCap = () => {
  if (userProfileCache.size <= USER_PROFILE_CACHE_MAX_ENTRIES) {
    return 0;
  }

  const targetSize = Math.floor(USER_PROFILE_CACHE_MAX_ENTRIES * 0.9);
  const entriesByAge = [...userProfileCache.entries()].sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
  const evictCount = Math.max(0, userProfileCache.size - targetSize);

  for (let index = 0; index < evictCount; index += 1) {
    const [userId] = entriesByAge[index];
    userProfileCache.delete(userId);
  }

  if (evictCount > 0) {
    log.warn('Evicted stale user profile cache entries to enforce memory cap', {
      cacheSizeAfterEvict: userProfileCache.size,
      cacheSizeCap: USER_PROFILE_CACHE_MAX_ENTRIES,
      evictedEntries: evictCount,
    });
  }

  return evictCount;
};

const setCachedUserProfile = (userId, profile) => {
  cleanupUserProfileCache();

  userProfileCache.set(userId, {
    profile,
    cachedAt: Date.now(),
  });

  enforceUserProfileCacheCap();
};

const fetchUsersSnapshot = async (participantIds = [], context = {}) => {
  const usersMap = {};
  const cacheMissIds = [];

  participantIds.forEach((userId) => {
    const cachedProfile = getCachedUserProfile(userId);
    if (cachedProfile) {
      usersMap[userId] = cachedProfile;
    } else {
      cacheMissIds.push(userId);
    }
  });

  const missChunks = chunkArrayDeterministically(cacheMissIds, USER_PROFILE_FETCH_CHUNK_SIZE);
  for (const chunk of missChunks) {
    const snapshots = await Promise.all(
      chunk.map((userId) => admin.database().ref(`users/${userId}`).once('value')),
    );

    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) return;
      const userId = chunk[index];
      const profile = snapshot.val();
      usersMap[userId] = profile;
      setCachedUserProfile(userId, profile);
    });
  }

  log.info('Fetched targeted users for notifications', {
    ...context,
    requestedUserCount: participantIds.length,
    cacheMissCount: cacheMissIds.length,
    resolvedUserCount: Object.keys(usersMap).length,
    chunkCount: missChunks.length,
  });

  return usersMap;
};

const filterOperationalRecipientsByActiveSession = async ({
  recipientIds = [],
  tourId,
  participants = {},
  allowOperationsAdmins = false,
  db = admin.database(),
} = {}) => {
  const uniqueIds = [...new Set(recipientIds.filter((uid) => isValidFirebaseKey(uid)))];
  const allowed = [];
  for (const chunk of chunkArrayDeterministically(uniqueIds, USER_PROFILE_FETCH_CHUNK_SIZE)) {
    const snapshots = await Promise.all(chunk.map((uid) => db.ref(`app_sessions/${uid}`).once('value')));
    snapshots.forEach((snapshot, index) => {
      const uid = chunk[index];
      if (allowOperationsAdmins && uid === OPERATIONS_ADMIN_UID) {
        allowed.push(uid);
        return;
      }
      const session = snapshot.val();
      if (!isActiveSessionRecord(session) || session.authUid !== uid || session.tourId !== tourId) return;
      if (session.principalType === 'passenger') {
        const participant = participants?.[uid];
        if (!participant
          || participant.schemaVersion !== 2
          || participant.sessionId !== session.sessionId
          || participant.principalId !== session.principalId
          || Number(participant.sessionExpiresAtMs) <= Date.now()) return;
      }
      allowed.push(uid);
    });
  }
  return allowed;
};

const selectNotificationRecipients = ({
  participantIds,
  usersMap,
  preferencePath,
  preferenceResolver = null,
  senderId,
  senderParticipantIds = [],
  excludeSender,
  context,
}) => {
  const validRecipients = [];
  const invalidTokens = [];
  const seenPushTokens = new Set();
  const excludedPushTokens = new Set();
  let duplicateTokenRecipientCount = 0;
  let excludedSenderTokenRecipientCount = 0;
  const excludedSenderIds = new Set(senderParticipantIds.filter(Boolean));
  if (senderId) {
    excludedSenderIds.add(senderId);
  }

  if (excludeSender) {
    excludedSenderIds.forEach((excludedUserId) => {
      const excludedToken = normalizePushToken(usersMap?.[excludedUserId]?.pushToken);
      if (excludedToken && isValidPushToken(excludedToken)) {
        excludedPushTokens.add(excludedToken);
      }
    });
  }

  for (const userId of participantIds) {
    if (excludeSender && excludedSenderIds.has(userId)) {
      continue;
    }

    const userData = usersMap[userId];
    const pushToken = normalizePushToken(userData?.pushToken);
    if (!userData || !pushToken) {
      log.info('No token for user', { ...context, userId });
      continue;
    }

    const ineligibilityReason = getPushTokenIneligibilityReason(userData);
    if (ineligibilityReason) {
      log.info('Skipping unavailable push recipient', {
        ...context,
        userId,
        reason: ineligibilityReason,
      });
      continue;
    }

    const wantsFeatureNotifications = typeof preferenceResolver === 'function'
      ? preferenceResolver(userData, userId)
      : getPreferenceValue(userData, preferencePath, true);
    if (!wantsFeatureNotifications) {
      log.info('User opted out of notification feature', {
        ...context,
        userId,
        preferencePath: Array.isArray(preferencePath) ? preferencePath.join('.') : 'custom',
      });
      continue;
    }

    if (!isValidPushToken(pushToken)) {
      log.warn('Invalid push token', { ...context, userId });
      invalidTokens.push({ userId, token: pushToken });
      continue;
    }

    if (excludeSender && excludedPushTokens.has(pushToken)) {
      excludedSenderTokenRecipientCount += 1;
      continue;
    }

    if (seenPushTokens.has(pushToken)) {
      duplicateTokenRecipientCount += 1;
      continue;
    }

    seenPushTokens.add(pushToken);
    validRecipients.push({ userId, userData: { ...userData, pushToken } });
  }

  if (duplicateTokenRecipientCount > 0 || excludedSenderTokenRecipientCount > 0) {
    log.info('Deduplicated notification recipients by push token', {
      ...context,
      duplicateTokenRecipientCount,
      excludedSenderTokenRecipientCount,
      selectedRecipientCount: validRecipients.length,
    });
  }

  return {
    validRecipients,
    invalidTokens,
    duplicateTokenRecipientCount,
    excludedSenderTokenRecipientCount,
  };
};

const collectExpoTokenFailures = (ticketChunk = [], messageChunk = []) => {
  const failures = [];

  ticketChunk.forEach((ticket, index) => {
    if (ticket?.status !== 'error') return;

    const errorCode = typeof ticket?.details?.error === 'string'
      ? ticket.details.error
      : null;

    if (errorCode === 'DeviceNotRegistered') {
      failures.push({
        token: messageChunk[index]?.to || null,
        errorCode,
      });
    }
  });

  return failures;
};

const loadIdentityBindingsForPrincipal = async (principalId) => {
  const principalKey = toRealtimeKeySegment(principalId);
  if (!principalKey || !isValidFirebaseKey(principalKey)) {
    return {};
  }

  const snapshot = await admin.database()
    .ref(`identity_bindings/${principalKey}`)
    .once('value');

  return snapshot.val() || {};
};

const resolveChatSenderParticipantIds = async ({
  participants = {},
  messageData = {},
  loadIdentityBindings = loadIdentityBindingsForPrincipal,
  context = {},
}) => {
  const senderParticipantIds = new Set();
  const participantMap = participants && typeof participants === 'object'
    ? participants
    : {};
  const senderStableId = resolveTrimmedString(messageData.senderStableId);
  const candidatePrincipals = senderStableId ? [senderStableId] : [];

  const uniquePrincipals = [...new Set(candidatePrincipals)];
  for (const principalId of uniquePrincipals) {
    try {
      const bindings = await loadIdentityBindings(principalId);
      if (!bindings || typeof bindings !== 'object') {
        continue;
      }

      Object.entries(bindings).forEach(([boundUid, isBound]) => {
        if (isBound === true && participantMap[boundUid]) {
          senderParticipantIds.add(boundUid);
        }
      });
    } catch (error) {
      log.warn('Failed to resolve sender identity bindings for notification fanout', {
        ...context,
        principalKey: toRealtimeKeySegment(principalId),
        error: error?.message || String(error),
      });
    }
  }

  return [...senderParticipantIds];
};

const collectAssignedDriverIds = (manifestData = {}) => {
  const driverIds = new Set();

  const addDriverId = (driverId, value) => {
    if (!value || typeof driverId !== 'string' || !isValidFirebaseKey(driverId)) {
      return;
    }
    driverIds.add(driverId);
  };

  Object.entries(manifestData?.assigned_drivers || {}).forEach(([driverId, value]) => {
    addDriverId(driverId, value);
  });

  Object.entries(manifestData?.assigned_driver_codes || {}).forEach(([driverId, value]) => {
    addDriverId(driverId, value);
  });

  return [...driverIds].sort((a, b) => a.localeCompare(b));
};

const isDriverProfileAssignedToTour = (driverData = {}, tourId) => {
  const expectedTourId = normalizeTourKeyForComparison(tourId);
  const currentTourId = normalizeTourKeyForComparison(driverData?.currentTourId);

  return Boolean(currentTourId && currentTourId === expectedTourId);
};

const compactNotificationText = (value, maxLength = 220) => {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const buildTourNotificationId = ({ type, tourId, sourceId }) => {
  const digest = createHash('sha256')
    .update(`${type || 'update'}:${tourId || 'unknown'}:${sourceId || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);
  return `ntf_${digest}`;
};

const normalizeItineraryDaysForDiff = (itinerary = {}) => {
  const days = Array.isArray(itinerary?.days) ? itinerary.days : [];
  const normalized = new Map();
  days.forEach((day, index) => {
    const dayNumber = Number.isFinite(Number(day?.day)) ? Number(day.day) : index + 1;
    normalized.set(dayNumber, compactNotificationText(JSON.stringify(day || {}), 4000));
  });
  return normalized;
};

const summarizeItineraryChange = (before = {}, after = {}) => {
  const beforeDays = normalizeItineraryDaysForDiff(before);
  const afterDays = normalizeItineraryDaysForDiff(after);
  const allDayNumbers = [...new Set([...beforeDays.keys(), ...afterDays.keys()])].sort((a, b) => a - b);
  const changedDays = allDayNumbers.filter((dayNumber) => beforeDays.get(dayNumber) !== afterDays.get(dayNumber));
  const titleChanged = compactNotificationText(before?.title, 160) !== compactNotificationText(after?.title, 160);

  if (beforeDays.size === 0 && afterDays.size > 0) {
    return {
      title: 'Itinerary available',
      body: `Your ${afterDays.size}-day itinerary is now available. Tap to review the schedule.`,
      changedDayCount: afterDays.size,
      changeType: 'published',
      hasMeaningfulChange: true,
    };
  }

  if (afterDays.size === 0) {
    return {
      title: 'Itinerary being revised',
      body: 'The itinerary is being revised. Open the app for the latest tour information.',
      changedDayCount: beforeDays.size,
      changeType: 'withdrawn',
      hasMeaningfulChange: beforeDays.size > 0,
    };
  }

  if (changedDays.length === 1) {
    return {
      title: 'Itinerary updated',
      body: `Day ${changedDays[0]} has changed. Tap to review the updated schedule.`,
      changedDayCount: 1,
      changeType: 'updated',
      hasMeaningfulChange: true,
    };
  }

  if (changedDays.length > 1) {
    return {
      title: 'Itinerary updated',
      body: `${changedDays.length} itinerary days have changed. Tap to review the updated schedule.`,
      changedDayCount: changedDays.length,
      changeType: 'updated',
      hasMeaningfulChange: true,
    };
  }

  return {
    title: titleChanged ? 'Itinerary updated' : null,
    body: titleChanged
      ? 'Your itinerary details have changed. Tap to review the latest schedule.'
      : null,
    changedDayCount: 0,
    changeType: titleChanged ? 'updated' : 'metadata_only',
    hasMeaningfulChange: titleChanged,
  };
};

const buildTourNotificationRecord = ({
  type,
  tourId,
  sourceId,
  title,
  body,
  screen,
  createdAtMs = Date.now(),
  priority = 'normal',
  messageId = null,
  departureKey = null,
  revision = null,
  changedSections = null,
  critical = false,
  requiresAcknowledgement = false,
}) => {
  const noticeId = buildTourNotificationId({ type, tourId, sourceId });
  return {
    noticeId,
    version: 1,
    type,
    title: compactNotificationText(title, 120),
    body: compactNotificationText(body, 300),
    tourId,
    screen,
    sourceId: compactNotificationText(sourceId, 160),
    ...(resolveTrimmedString(messageId) ? { messageId: resolveTrimmedString(messageId) } : {}),
    ...(resolveTrimmedString(departureKey) ? { departureKey: resolveTrimmedString(departureKey) } : {}),
    ...(Number.isSafeInteger(revision) && revision >= 1 ? { revision } : {}),
    ...(Array.isArray(changedSections) && changedSections.length
      ? { changedSections: changedSections.join(',').slice(0, 240) }
      : {}),
    ...(critical === true ? { critical: true } : {}),
    ...(requiresAcknowledgement === true ? { requiresAcknowledgement: true } : {}),
    priority: priority === 'high' ? 'high' : 'normal',
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  };
};

const buildPushNavigationData = ({
  screen,
  tourId = null,
  noticeId = null,
  messageId = null,
  notificationType = null,
  internalDriverChat = false,
  categoryKey = null,
  broadcastId = null,
  departureKey = null,
  revision = null,
  changedSections = null,
  critical = false,
  requiresAcknowledgement = false,
  timestamp = Date.now(),
} = {}) => {
  if (!PUSH_NOTIFICATION_SCREENS.has(screen)) {
    throw new Error('Unsupported notification destination');
  }

  const safeTourId = resolveTrimmedString(tourId);
  if (screen !== 'NotificationPreferences' && !safeTourId) {
    throw new Error('Tour-scoped notification requires a tour id');
  }

  return {
    screen,
    ...(safeTourId ? { tourId: safeTourId } : {}),
    ...(resolveTrimmedString(noticeId) ? { noticeId: resolveTrimmedString(noticeId) } : {}),
    ...(resolveTrimmedString(messageId) ? { messageId: resolveTrimmedString(messageId) } : {}),
    ...(resolveTrimmedString(notificationType) ? { notificationType: resolveTrimmedString(notificationType) } : {}),
    ...(internalDriverChat === true ? { internalDriverChat: true } : {}),
    ...(resolveTrimmedString(categoryKey) ? { categoryKey: resolveTrimmedString(categoryKey) } : {}),
    ...(resolveTrimmedString(broadcastId) ? { broadcastId: resolveTrimmedString(broadcastId) } : {}),
    ...(resolveTrimmedString(departureKey) ? { departureKey: resolveTrimmedString(departureKey) } : {}),
    ...(Number.isSafeInteger(revision) && revision >= 1 ? { revision } : {}),
    ...(Array.isArray(changedSections) && changedSections.length
      ? { changedSections: changedSections.join(',').slice(0, 240) }
      : {}),
    ...(critical === true ? { critical: true } : {}),
    ...(requiresAcknowledgement === true ? { requiresAcknowledgement: true } : {}),
    timestamp,
  };
};

const persistTourNotification = async ({ db = admin.database(), record }) => {
  if (!record || !isValidFirebaseKey(record.tourId) || !isValidFirebaseKey(record.noticeId)) {
    throw new Error('Invalid tour notification record');
  }

  const noticesRef = db.ref(`tour_notifications/${record.tourId}`);
  let evictedNoticeIds = [];
  await noticesRef.transaction((currentValue) => {
    evictedNoticeIds = [];
    const nextValue = currentValue && typeof currentValue === 'object' ? { ...currentValue } : {};
    nextValue[record.noticeId] = record;

    const sorted = Object.entries(nextValue).sort(([, left], [, right]) => {
      const timeDelta = Number(left?.createdAtMs || 0) - Number(right?.createdAtMs || 0);
      return timeDelta || String(left?.noticeId || '').localeCompare(String(right?.noticeId || ''));
    });
    while (sorted.length > TOUR_NOTIFICATION_MAX_RECORDS) {
      const [oldestId] = sorted.shift();
      evictedNoticeIds.push(oldestId);
      delete nextValue[oldestId];
    }
    return nextValue;
  });

  if (evictedNoticeIds.length > 0) {
    await enqueueNotificationReadCleanupJobs({
      db,
      tourId: record.tourId,
      noticeIds: evictedNoticeIds,
    });
  }

  return record;
};

const buildNotificationReadCleanupJobId = ({ tourId, noticeId }) => `nrc_${createHash('sha256')
  .update(`${tourId}:${noticeId}`)
  .digest('hex')
  .slice(0, 32)}`;

const enqueueNotificationReadCleanupJobs = async ({
  db = admin.database(),
  tourId,
  noticeIds = [],
  now = Date.now(),
}) => {
  if (!isValidFirebaseKey(tourId)) {
    throw new Error('Invalid notification cleanup tour id');
  }

  const safeNoticeIds = [...new Set(noticeIds.filter(isValidFirebaseKey))];
  await Promise.all(safeNoticeIds.map(async (noticeId) => {
    const jobId = buildNotificationReadCleanupJobId({ tourId, noticeId });
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).transaction((currentValue) => (
      currentValue || {
        version: 1,
        jobId,
        tourId,
        noticeId,
        createdAtMs: now,
        updatedAtMs: now,
        afterUserId: null,
        processedUserCount: 0,
      }
    ));
  }));
  return safeNoticeIds.length;
};

const processNotificationReadMigrationRequest = async ({
  db = admin.database(),
  tourId,
  authUid,
  request,
  now = Date.now(),
}) => {
  const requestPath = `notification_read_migration_requests/${tourId}/${authUid}`;
  const principalId = resolveTrimmedString(request?.principalId);
  if (!isValidFirebaseKey(tourId)
    || !isValidFirebaseKey(authUid)
    || request?.version !== 1
    || !isValidFirebaseKey(principalId)
    || principalId === authUid) {
    await db.ref(requestPath).remove();
    return { legacyRemoved: false, invalid: true };
  }

  const profileSnapshot = await db.ref(`users/${authUid}`).once('value');
  const profile = profileSnapshot.val() || {};
  const stablePassengerKey = resolveTrimmedString(profile.stablePassengerKey);
  const driverId = resolveTrimmedString(profile.driverId);
  const expectedPrincipalId = isValidFirebaseKey(stablePassengerKey)
    && resolveTrimmedString(profile.stablePassengerId)
    ? stablePassengerKey
    : isValidFirebaseKey(driverId)
      ? `driver:${driverId}`
      : null;

  if (principalId !== expectedPrincipalId
    || profile.notificationReadStateUpgradedTours?.[tourId] === true) {
    await db.ref(requestPath).remove();
    return { legacyRemoved: false, invalid: true };
  }

  await db.ref().update({
    [`notification_read_state/${tourId}/${authUid}`]: null,
    [requestPath]: null,
    [`users/${authUid}/notificationReadStateUpgradedTours/${tourId}`]: true,
  });
  return {
    legacyRemoved: true,
    invalid: false,
    principalId,
    completedAtMs: now,
  };
};

const fetchRealtimeDatabaseShallowKeys = async ({
  db = admin.database(),
  path,
  fetchImpl = fetch,
}) => {
  const databaseURL = resolveTrimmedString(db.app?.options?.databaseURL)
    || resolveTrimmedString(admin.app().options?.databaseURL);
  const credential = db.app?.options?.credential || admin.app().options?.credential;
  if (!databaseURL || !credential?.getAccessToken || typeof fetchImpl !== 'function') {
    throw new Error('Realtime Database shallow-key access is unavailable');
  }
  const accessToken = await credential.getAccessToken();
  const token = resolveTrimmedString(accessToken?.access_token);
  if (!token) throw new Error('Realtime Database cleanup access token is unavailable');
  const encodedPath = String(path || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const response = await fetchImpl(
    `${databaseURL.replace(/\/$/, '')}/${encodedPath}.json?shallow=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Realtime Database shallow-key read failed (${response.status})`);
  const value = await response.json();
  return Object.keys(value && typeof value === 'object' ? value : {})
    .filter(isValidFirebaseKey)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

const shouldDeleteLegacyNotificationReadPrincipal = ({ principalId, profile, authUserExists = false }) => {
  if (!isValidFirebaseKey(principalId)
    || isOpaquePassengerId(principalId)
    || principalId.startsWith('driver:')) return false;
  if (!profile || typeof profile !== 'object') return !authUserExists;
  return isValidFirebaseKey(resolveTrimmedString(profile.stablePassengerKey))
    || isValidFirebaseKey(resolveTrimmedString(profile.driverId));
};

const processLegacyNotificationReadStateCleanup = async ({
  db = admin.database(),
  listTourIds = () => fetchRealtimeDatabaseShallowKeys({ db, path: 'notification_read_state' }),
  resolveExistingAuthUids = async (uids) => {
    if (uids.length === 0) return new Set();
    const result = await admin.auth().getUsers(uids.map((uid) => ({ uid })));
    return new Set((result.users || []).map((user) => user.uid));
  },
  now = Date.now(),
} = {}) => {
  const stateRef = db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH);
  const stateSnapshot = await stateRef.once('value');
  const state = stateSnapshot.val() || {};
  if (state.completed === true) return { completed: true, processedCount: 0, deletedCount: 0 };

  if (state.seeded !== true) {
    const tourIds = await listTourIds();
    for (let offset = 0; offset < tourIds.length; offset += LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE) {
      const queueUpdates = Object.fromEntries(
        tourIds.slice(offset, offset + LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE)
          .map((tourId) => [tourId, { version: 1, afterPrincipalId: null }]),
      );
      await db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH).update(queueUpdates);
    }
    await stateRef.set({
      version: 1,
      seeded: true,
      completed: tourIds.length === 0,
      ...(tourIds.length === 0 ? { completedAtMs: now } : {}),
      updatedAtMs: now,
    });
    return {
      seeded: true,
      completed: tourIds.length === 0,
      discoveredTourCount: tourIds.length,
      processedCount: 0,
      deletedCount: 0,
    };
  }

  const queueSnapshot = await db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH)
    .orderByKey()
    .limitToFirst(2)
    .once('value');
  const queueEntries = Object.entries(queueSnapshot.val() || {})
    .filter(([tourId]) => isValidFirebaseKey(tourId))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const [tourId, queueItem = {}] = queueEntries[0] || [];
  if (!tourId) {
    await stateRef.set({
      version: 1,
      seeded: true,
      completed: true,
      completedAtMs: now,
      updatedAtMs: now,
    });
    return { completed: true, processedCount: 0, deletedCount: 0 };
  }

  const afterPrincipalId = isValidFirebaseKey(queueItem?.afterPrincipalId)
    ? queueItem.afterPrincipalId
    : null;
  let principalsQuery = db.ref(`notification_read_state/${tourId}`).orderByKey();
  if (afterPrincipalId) principalsQuery = principalsQuery.startAt(afterPrincipalId);
  const principalsSnapshot = await principalsQuery
    .limitToFirst(LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE + (afterPrincipalId ? 2 : 1))
    .once('value');
  const principalEntries = Object.entries(principalsSnapshot.val() || {})
    .filter(([principalId]) => isValidFirebaseKey(principalId)
      && (!afterPrincipalId || principalId > afterPrincipalId))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const pageEntries = principalEntries.slice(0, LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE);
  const page = pageEntries.map(([principalId]) => principalId);
  const profiles = new Map();
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(LEGACY_NOTIFICATION_READ_CLEANUP_CONCURRENCY, page.length),
  }, async () => {
    while (cursor < page.length) {
      const index = cursor;
      cursor += 1;
      const principalId = page[index];
      if (isOpaquePassengerId(principalId) || principalId.startsWith('driver:')) continue;
      const snapshot = await db.ref(`users/${principalId}`).once('value');
      profiles.set(principalId, snapshot.val());
    }
  });
  await Promise.all(workers);

  const missingProfileUids = page.filter((principalId) => (
    !isOpaquePassengerId(principalId)
    && !principalId.startsWith('driver:')
    && !profiles.get(principalId)
    && principalId.length <= 128
  ));
  const existingAuthUids = await resolveExistingAuthUids(missingProfileUids);

  const updates = {};
  page.forEach((principalId) => {
    if (shouldDeleteLegacyNotificationReadPrincipal({
      principalId,
      profile: profiles.get(principalId),
      authUserExists: existingAuthUids.has(principalId),
    })) {
      updates[`notification_read_state/${tourId}/${principalId}`] = null;
    }
  });
  const hasMoreInTour = principalEntries.length > pageEntries.length;
  const hasMoreTours = queueEntries.length > 1;
  updates[`${LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH}/${tourId}`] = hasMoreInTour
    ? { version: 1, afterPrincipalId: page.at(-1), updatedAtMs: now }
    : null;
  updates[LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH] = {
    version: 1,
    seeded: true,
    completed: !hasMoreInTour && !hasMoreTours,
    ...(!hasMoreInTour && !hasMoreTours ? { completedAtMs: now } : {}),
    updatedAtMs: now,
  };
  await db.ref().update(updates);
  return {
    completed: !hasMoreInTour && !hasMoreTours,
    tourId,
    processedCount: page.length,
    deletedCount: Object.keys(updates).filter((path) => path.startsWith('notification_read_state/')).length,
  };
};

const processNotificationReadCleanupJob = async ({ db = admin.database(), jobId, job, now = Date.now() }) => {
  if (!isValidFirebaseKey(jobId)
    || !job
    || job.version !== 1
    || job.jobId !== jobId
    || !isValidFirebaseKey(job.tourId)
    || !isValidFirebaseKey(job.noticeId)) {
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).remove();
    return { completed: true, removedReadCount: 0, processedUserCount: 0, invalid: true };
  }

  const afterUserId = isValidFirebaseKey(job.afterUserId) ? job.afterUserId : null;
  let usersQuery = db.ref(`notification_read_state/${job.tourId}`).orderByKey();
  if (afterUserId) usersQuery = usersQuery.startAt(afterUserId);
  const snapshot = await usersQuery
    .limitToFirst(NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE + (afterUserId ? 2 : 1))
    .once('value');
  const userEntries = Object.entries(snapshot.val() || {})
    .filter(([userId]) => isValidFirebaseKey(userId) && (!afterUserId || userId > afterUserId))
    .sort(([left], [right]) => left.localeCompare(right));
  const pageEntries = userEntries.slice(0, NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE);
  const hasMore = userEntries.length > pageEntries.length;
  const updates = {};

  pageEntries.forEach(([userId, userState]) => {
    if (userState && typeof userState === 'object' && Object.prototype.hasOwnProperty.call(userState, job.noticeId)) {
      updates[`notification_read_state/${job.tourId}/${userId}/${job.noticeId}`] = null;
    }
  });
  if (Object.keys(updates).length > 0) await db.ref().update(updates);

  if (!hasMore) {
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).remove();
    return {
      completed: true,
      removedReadCount: Object.keys(updates).length,
      processedUserCount: pageEntries.length,
    };
  }

  const nextCursor = pageEntries.at(-1)?.[0];
  await db.ref(`notification_read_cleanup_jobs/${jobId}`).update({
    afterUserId: nextCursor,
    processedUserCount: Number(job.processedUserCount || 0) + pageEntries.length,
    updatedAtMs: now,
  });
  return {
    completed: false,
    removedReadCount: Object.keys(updates).length,
    processedUserCount: pageEntries.length,
    afterUserId: nextCursor,
  };
};

const processNotificationReadCleanupJobs = async ({ db = admin.database(), now = Date.now() } = {}) => {
  const snapshot = await db.ref('notification_read_cleanup_jobs')
    .orderByChild('createdAtMs')
    .limitToFirst(NOTIFICATION_READ_CLEANUP_JOB_BATCH_SIZE)
    .once('value');
  const jobs = Object.entries(snapshot.val() || {});
  const results = [];
  for (const [jobId, job] of jobs) {
    try {
      results.push(await processNotificationReadCleanupJob({ db, jobId, job, now }));
    } catch (error) {
      log.warn('Notification read-state cleanup job deferred', {
        jobId,
        tourId: job?.tourId,
        error: error?.message || String(error),
      });
      results.push({ completed: false, error: true });
    }
  }
  return results;
};

const buildCategoryBroadcastPushMessages = ({
  validRecipients = [],
  categoryKey,
  categoryLabel,
  broadcastId,
  message,
  timestamp = Date.now(),
}) => {
  const messageText = resolveTrimmedString(message);
  if (!isSupportedTourNotificationCategory(categoryKey)
    || !isValidFirebaseKey(broadcastId)
    || !messageText) {
    throw new Error('Invalid category broadcast push payload');
  }

  const notificationBody = messageText.length > 200
    ? `${messageText.substring(0, 197)}...`
    : messageText;

  return [...validRecipients]
    .sort((left, right) => String(left?.userId || '').localeCompare(String(right?.userId || '')))
    .map((recipient) => ({
      to: recipient?.userData?.pushToken,
      sound: 'default',
      title: `New ${categoryLabel || resolveTourNotificationCategoryLabel(categoryKey)} tour alert`,
      body: notificationBody,
      data: buildPushNavigationData({
        screen: 'NotificationPreferences',
        notificationType: 'category_broadcast',
        categoryKey,
        broadcastId,
        timestamp,
      }),
      priority: 'default',
      channelId: 'default',
    }))
    .filter((payload) => typeof payload.to === 'string' && payload.to.trim().length > 0);
};

const loadDriverProfile = async (driverId) => {
  const snapshot = await admin.database().ref(`drivers/${driverId}`).once('value');
  return snapshot.val() || null;
};

const resolveAssignedDriverRecipientIds = async ({
  tourId,
  manifestData = {},
  loadProfile = loadDriverProfile,
  context = {},
}) => {
  const driverIds = collectAssignedDriverIds(manifestData);
  const recipientIds = new Set();
  const driverChunks = chunkArrayDeterministically(driverIds, USER_PROFILE_FETCH_CHUNK_SIZE);

  for (const chunk of driverChunks) {
    const profileResults = await Promise.all(chunk.map(async (driverId) => {
      try {
        return {
          driverId,
          driverData: await loadProfile(driverId),
        };
      } catch (error) {
        log.warn('Failed to load assigned driver profile for notification fanout', {
          ...context,
          error: error?.message || String(error),
        });
        return { driverId, driverData: null };
      }
    }));

    profileResults.forEach(({ driverData }) => {
      if (!driverData || typeof driverData !== 'object') {
        return;
      }

      if (!isDriverProfileAssignedToTour(driverData, tourId)) {
        return;
      }

      const authUid = resolveTrimmedString(driverData.authUid);
      if (authUid && isValidFirebaseKey(authUid)) {
        recipientIds.add(authUid);
      }
    });
  }

  log.info('Resolved assigned driver notification recipients', {
    ...context,
    assignedDriverCount: driverIds.length,
    assignedDriverRecipientCount: recipientIds.size,
  });

  return [...recipientIds].sort((a, b) => a.localeCompare(b));
};

const resolveChatSenderDeliveryIds = async ({
  tourId,
  participants = {},
  manifestData = {},
  messageData = {},
  loadProfile = loadDriverProfile,
  loadIdentityBindings = loadIdentityBindingsForPrincipal,
  context = {},
}) => {
  const senderStableId = resolveTrimmedString(messageData.senderStableId);
  const senderId = resolveTrimmedString(messageData.senderId);
  const driverPrincipal = senderStableId?.startsWith('driver:')
    ? senderStableId
    : (senderId?.startsWith('driver:') ? senderId : null);

  if (!driverPrincipal) {
    return resolveChatSenderParticipantIds({
      participants,
      messageData,
      loadIdentityBindings,
      context,
    });
  }

  const driverId = driverPrincipal.slice('driver:'.length).trim();
  if (!driverId || !collectAssignedDriverIds(manifestData).includes(driverId)) {
    return [];
  }

  try {
    const driverData = await loadProfile(driverId);
    if (!driverData || !isDriverProfileAssignedToTour(driverData, tourId)) {
      return [];
    }
    const authUid = resolveTrimmedString(driverData.authUid);
    return authUid && isValidFirebaseKey(authUid) ? [authUid] : [];
  } catch (error) {
    log.warn('Failed to resolve chat sender driver profile', {
      ...context,
      error: error?.message || String(error),
    });
    return [];
  }
};

/**
 * Verifies user is a participant of the tour
 */
const verifyParticipant = async (tourId, userId) => {
  try {
    const participantSnapshot = await admin.database()
      .ref(`tours/${tourId}/participants/${userId}`)
      .once('value');
    return participantSnapshot.exists();
  } catch (error) {
    log.error('Error verifying participant', error, { tourId, userId });
    return false;
  }
};

/**
 * Checks if the sender claims to be an admin/HQ broadcast.
 * Returns true only if the senderId uses an admin prefix.
 * IMPORTANT: Must be paired with verifyAdminBroadcast() to prevent spoofing.
 */
const isAdminBroadcast = (senderId) => {
  return senderId && (
    senderId === 'admin_hq_broadcast' ||
    senderId.startsWith('admin_') ||
    senderId.startsWith('hq_')
  );
};

const parseSourcePhotoPath = (objectPath = "") => {
  const groupMatch = objectPath.match(/^group_tour_photos\/([^/]+)\/([^/]+)$/);
  if (groupMatch) {
    return {
      visibility: "group",
      tourId: groupMatch[1],
      ownerKey: null,
      filename: groupMatch[2],
    };
  }

  const privateMatch = objectPath.match(/^private_tour_photos\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (privateMatch) {
    return {
      visibility: "private",
      tourId: privateMatch[1],
      ownerKey: privateMatch[2],
      filename: privateMatch[3],
    };
  }

  return null;
};

const buildPhotoCollectionPath = ({ visibility, tourId, ownerKey }) => {
  if (visibility === "private") {
    return `private_tour_photos/${tourId}/${ownerKey}`;
  }
  return `group_tour_photos/${tourId}`;
};

const createPhotoVariantBuffers = async (sourceBuffer) => {
  const [viewerBuffer, thumbnailBuffer] = await Promise.all([
    sharp(sourceBuffer).rotate().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(),
    sharp(sourceBuffer).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer(),
  ]);

  return { viewerBuffer, thumbnailBuffer };
};

const buildPhotoVariantPaths = ({ visibility, tourId, ownerKey, filename }) => {
  const extensionlessName = filename.replace(/\.[^/.]+$/, "");
  const viewerPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/viewers/${extensionlessName}_viewer.jpg`
    : `group_tour_photos/${tourId}/viewers/${extensionlessName}_viewer.jpg`;
  const thumbnailPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/thumbnails/${extensionlessName}_thumb.jpg`
    : `group_tour_photos/${tourId}/thumbnails/${extensionlessName}_thumb.jpg`;

  return { viewerPath, thumbnailPath };
};

const hardenPrivateSourceObjectMetadata = async (sourceFile, suppliedObjectMetadata = null) => {
  const objectMetadata = suppliedObjectMetadata || (await sourceFile.getMetadata())[0];
  const current = objectMetadata?.metadata || {};
  await sourceFile.setMetadata({
    metadata: {
      ...(typeof current.authUid === 'string' && current.authUid ? { authUid: current.authUid } : {}),
      visibility: 'private',
      sourceRole: 'source',
      firebaseStorageDownloadTokens: null,
    },
  });
};

const hardenGroupSourceObjectMetadata = async (sourceFile) => {
  await sourceFile.setMetadata({
    metadata: {
      visibility: 'group',
      sourceRole: 'source',
      firebaseStorageDownloadTokens: null,
    },
  });
};

const generatePhotoVariantsForRecord = async ({
  bucketName,
  visibility,
  tourId,
  ownerKey = null,
  photoId,
  photoRecord,
  dryRun = false,
  storageBucket = null,
  dbRoot = null,
}) => {
  const objectPath = typeof photoRecord?.storagePath === "string" ? photoRecord.storagePath : "";
  if (!bucketName || !objectPath || !photoId || !tourId) {
    return { status: "skipped", reason: "missing-required-fields" };
  }

  const filename = objectPath.split("/").pop();
  if (!filename) {
    return { status: "skipped", reason: "missing-filename" };
  }

  const { viewerPath, thumbnailPath } = buildPhotoVariantPaths({
    visibility,
    tourId,
    ownerKey,
    filename,
  });

  if (dryRun) {
    return {
      status: "dry-run",
      photoId,
      objectPath,
      viewerPath,
      thumbnailPath,
    };
  }

  const resolvedDbRoot = dbRoot || admin.database().ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
  const resolvedBucket = storageBucket || admin.storage().bucket(bucketName);

  try {
    const sourceFile = resolvedBucket.file(objectPath);
    const [sourceBuffer] = await sourceFile.download();
    const [sourceObjectMetadata] = await sourceFile.getMetadata();
    if (visibility === 'private') await hardenPrivateSourceObjectMetadata(sourceFile, sourceObjectMetadata);
    else await hardenGroupSourceObjectMetadata(sourceFile);
    const { viewerBuffer, thumbnailBuffer } = await createPhotoVariantBuffers(sourceBuffer);
    await Promise.all([
      resolvedBucket.file(viewerPath).save(viewerBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: {
            ...(visibility === 'private'
              ? { visibility: 'private', sourceRole: 'viewer' }
              : { visibility: 'group', sourceRole: 'viewer' }),
          },
        },
      }),
      resolvedBucket.file(thumbnailPath).save(thumbnailBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: {
            ...(visibility === 'private'
              ? { visibility: 'private', sourceRole: 'thumbnail' }
              : { visibility: 'group', sourceRole: 'thumbnail' }),
          },
        },
      }),
    ]);

    await resolvedDbRoot.child(photoId).update({
      viewerUrl: null,
      viewerStoragePath: viewerPath,
      thumbnailUrl: null,
      thumbnailStoragePath: thumbnailPath,
      variantStatus: "ready",
      variantUpdatedAt: Date.now(),
      variantError: null,
    });

    return { status: "ready", photoId, viewerPath, thumbnailPath };
  } catch (error) {
    await resolvedDbRoot.child(photoId).update({
      variantStatus: "failed",
      variantUpdatedAt: Date.now(),
      variantError: error?.message || "Variant generation failed",
    });

    return {
      status: "failed",
      photoId,
      error: error?.message || "Variant generation failed",
    };
  }
};

/**
 * Verifies that an admin broadcast is legitimate by checking the senderUid.
 * Rejects messages that claim admin status without a verified non-anonymous auth UID.
 */
const verifyAdminBroadcast = async (messageData) => {
  const { senderUid } = messageData;

  // Admin broadcasts must include a senderUid for verification
  if (!senderUid || typeof senderUid !== 'string') {
    return false;
  }

  try {
    // Verify the UID belongs to a real, non-anonymous user (admins use email/password auth)
    const userRecord = await admin.auth().getUser(senderUid);
    if (!userRecord || userRecord.disabled) {
      return false;
    }

    // Admin users authenticate with email/password, not anonymously
    const isAnonymous = userRecord.providerData.length === 0;
    if (isAnonymous) {
      return false;
    }

    return true;
  } catch (error) {
    log.error('Admin broadcast verification failed', error, { senderUid });
    return false;
  }
};

/**
 * Validates a Firebase path segment to prevent path traversal attacks.
 * Firebase keys cannot contain '.', '$', '#', '[', ']', or '/'.
 */
const isValidFirebaseKey = (key) => {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }
  // Firebase keys cannot contain these characters
  return !/[./$#\[\]]/.test(key);
};

const createSafetySubmissionError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const normalizeSafetyCoordinate = (value, minimum, maximum) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : null;
};

const normalizeSafetySubmissionInput = (input = {}, nowMs = Date.now()) => {
  const clientEventId = resolveTrimmedString(input.clientEventId);
  const tourId = normalizeTourKeyForComparison(input.tourId);
  const role = resolveTrimmedString(input.role)?.toLowerCase();
  const category = resolveTrimmedString(input.category)?.toLowerCase();
  const requestedSeverity = resolveTrimmedString(input.severity)?.toLowerCase() || 'medium';
  const message = resolveTrimmedString(input.message);
  const customMessage = resolveTrimmedString(input.customMessage);
  const clientCreatedAtMs = Number(input.clientCreatedAtMs);

  if (!clientEventId || clientEventId.length > 160 || !isValidFirebaseKey(clientEventId)) {
    throw createSafetySubmissionError('INVALID_EVENT_ID');
  }
  if (!tourId || tourId.length > 160 || !isValidFirebaseKey(tourId)) {
    throw createSafetySubmissionError('INVALID_TOUR');
  }
  if (role !== 'passenger' && role !== 'driver') {
    throw createSafetySubmissionError('INVALID_ROLE');
  }
  if (!SAFETY_CATEGORIES.has(category)) {
    throw createSafetySubmissionError('INVALID_CATEGORY');
  }
  if (!SAFETY_SEVERITIES.has(requestedSeverity)) {
    throw createSafetySubmissionError('INVALID_SEVERITY');
  }
  if (!message || message.length > 240) {
    throw createSafetySubmissionError('INVALID_MESSAGE');
  }
  if (customMessage && customMessage.length > 1000) {
    throw createSafetySubmissionError('INVALID_DETAILS');
  }
  if (
    !Number.isFinite(clientCreatedAtMs)
    || clientCreatedAtMs < Date.UTC(2020, 0, 1)
    || clientCreatedAtMs > nowMs + 5 * 60 * 1000
  ) {
    throw createSafetySubmissionError('INVALID_CLIENT_TIME');
  }

  let coords = null;
  if (input.coords !== null && input.coords !== undefined) {
    const latitude = normalizeSafetyCoordinate(input.coords?.latitude, -90, 90);
    const longitude = normalizeSafetyCoordinate(input.coords?.longitude, -180, 180);
    const accuracy = Number(input.coords?.accuracy);
    if (latitude === null || longitude === null || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
      throw createSafetySubmissionError('INVALID_LOCATION');
    }
    coords = { latitude, longitude, accuracy };
  }

  const isSOS = category === 'sos';
  const severity = isSOS ? 'critical' : requestedSeverity;
  if (input.isSOS === true && !isSOS) {
    throw createSafetySubmissionError('INVALID_SOS_STATE');
  }

  return {
    clientEventId,
    tourId,
    role,
    category,
    severity,
    message,
    customMessage,
    coords,
    isSOS,
    clientCreatedAtMs,
    processedFromQueue: input.processedFromQueue === true,
  };
};

const buildCanonicalSafetyRecord = ({ input, authUid, principalId, nowMs = Date.now() }) => ({
  schemaVersion: 2,
  eventId: input.clientEventId,
  clientEventId: input.clientEventId,
  tourId: input.tourId,
  reporterAuthUid: authUid,
  userId: authUid,
  principalId,
  role: input.role,
  category: input.category,
  severity: input.severity,
  message: input.message,
  customMessage: input.customMessage,
  coords: input.coords,
  isSOS: input.isSOS,
  status: 'pending',
  timestamp: new Date(nowMs).toISOString(),
  timestampMs: nowMs,
  clientCreatedAt: new Date(input.clientCreatedAtMs).toISOString(),
  clientCreatedAtMs: input.clientCreatedAtMs,
  receivedAt: new Date(nowMs).toISOString(),
  receivedAtMs: nowMs,
  processedFromQueue: input.processedFromQueue,
});

const buildSafetySubmissionUpdates = ({ record, lockPath }) => {
  const eventId = record.eventId;
  const updates = {
    [`logs/${record.reporterAuthUid}/safety/${eventId}`]: record,
    [`tours/${record.tourId}/safetyAlerts/${eventId}`]: record,
    [lockPath]: null,
  };
  if (record.isSOS || record.severity === 'critical') {
    updates[`globalSafetyAlerts/${eventId}`] = {
      ...record,
      tourAlertId: `tours/${record.tourId}/safetyAlerts/${eventId}`,
    };
  }
  return updates;
};

/**
 * Rate limiting check (simple implementation)
 */
const rateLimitCache = new Map();
const RATE_LIMIT_MAINTENANCE_INTERVAL_MS = 300000;
let lastRateLimitMaintenanceAt = 0;

const runLazyRateLimitMaintenance = (now = Date.now()) => {
  if (now - lastRateLimitMaintenanceAt < RATE_LIMIT_MAINTENANCE_INTERVAL_MS) return;
  lastRateLimitMaintenanceAt = now;
  for (const [key, record] of rateLimitCache.entries()) {
    if (now > record.resetTime) rateLimitCache.delete(key);
  }
  cleanupUserProfileCache(now);
};

const checkRateLimit = (key, maxRequests = 10, windowMs = 60000) => {
  const now = Date.now();
  runLazyRateLimitMaintenance(now);
  const record = rateLimitCache.get(key) || { count: 0, resetTime: now + windowMs };

  // Reset if window expired
  if (now > record.resetTime) {
    rateLimitCache.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  // Check limit
  if (record.count >= maxRequests) {
    return false;
  }

  // Increment
  record.count++;
  rateLimitCache.set(key, record);
  return true;
};

const normalizeBookingRef = (bookingRef) => {
  if (typeof bookingRef !== 'string') return '';
  return bookingRef.trim().toUpperCase();
};

const normalizeEmail = (email) => {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
};

const createManualPassengerError = (code, message) => {
  const error = new Error(message || code);
  error.code = code;
  return error;
};

const parseStrictDateOnly = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const ukMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const match = ukMatch || isoMatch;
  if (!match) return null;

  const year = Number(ukMatch ? match[3] : match[1]);
  const month = Number(match[2]);
  const day = Number(ukMatch ? match[1] : match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    date,
    iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    uk: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).padStart(4, '0')}`,
  };
};

const normalizeManualPassengerPayload = (payload = {}, tourData = {}) => {
  const tourId = normalizeTourKeyForComparison(payload.tourId);
  const tourCode = resolveTrimmedString(tourData.tourCode);
  const bookingRef = normalizeBookingRef(payload.bookingRef);
  const email = normalizeEmail(payload.email);
  const pickupDate = parseStrictDateOnly(payload.pickupDate);
  const pickupTime = resolveTrimmedString(payload.pickupTime);
  const pickupLocation = resolveTrimmedString(payload.pickupLocation);
  const rawPassengers = Array.isArray(payload.passengers) ? payload.passengers : [];

  if (!tourId || !isValidFirebaseKey(tourId)) {
    throw createManualPassengerError('INVALID_TOUR', 'Select a valid tour.');
  }
  if (!tourCode || normalizeTourKeyForComparison(tourCode) !== tourId) {
    throw createManualPassengerError('TOUR_IDENTITY_MISMATCH', 'The selected tour has inconsistent identity data.');
  }
  if (tourData.isActive === false) {
    throw createManualPassengerError('TOUR_INACTIVE', 'Passengers cannot be added to an inactive tour.');
  }
  if (
    !bookingRef
    || bookingRef.length > 64
    || bookingRef.startsWith('D-')
    || !/^[A-Z0-9_-]+$/.test(bookingRef)
    || !isValidFirebaseKey(bookingRef)
  ) {
    throw createManualPassengerError(
      'INVALID_BOOKING_REFERENCE',
      'Booking reference must use letters, numbers, hyphens, or underscores.',
    );
  }
  if (
    !email
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw createManualPassengerError('INVALID_EMAIL', 'Enter a valid passenger email address.');
  }
  if (!pickupDate) {
    throw createManualPassengerError('INVALID_PICKUP_DATE', 'Pickup date must be a valid date.');
  }
  if (!pickupTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) {
    throw createManualPassengerError('INVALID_PICKUP_TIME', 'Pickup time must use 24-hour HH:mm format.');
  }
  if (!pickupLocation || pickupLocation.length < 3 || pickupLocation.length > 250) {
    throw createManualPassengerError(
      'INVALID_PICKUP_LOCATION',
      'Pickup location must be between 3 and 250 characters.',
    );
  }
  if (rawPassengers.length < 1 || rawPassengers.length > 53) {
    throw createManualPassengerError('INVALID_PASSENGERS', 'A booking must contain between 1 and 53 passengers.');
  }

  const tourStart = parseStrictDateOnly(tourData.startDate);
  const tourEnd = parseStrictDateOnly(tourData.endDate || tourData.startDate);
  if (!tourStart || !tourEnd) {
    throw createManualPassengerError('TOUR_DATES_INVALID', 'The selected tour must have valid start and end dates.');
  }
  if (
    pickupDate.date.getTime() < tourStart.date.getTime()
    || pickupDate.date.getTime() > tourEnd.date.getTime()
  ) {
    throw createManualPassengerError(
      'PICKUP_DATE_OUTSIDE_TOUR',
      'Pickup date must fall within the selected tour dates.',
    );
  }

  const maxParticipants = Number.isInteger(tourData.maxParticipants) && tourData.maxParticipants > 0
    ? tourData.maxParticipants
    : 53;
  const seenSeats = new Set();
  const passengers = rawPassengers.map((passenger, index) => {
    const name = resolveTrimmedString(passenger?.name);
    const phone = resolveTrimmedString(passenger?.phone);
    const seatNumber = Number(passenger?.seatNumber);

    if (!name || name.length < 2 || name.length > 120) {
      throw createManualPassengerError(
        'INVALID_PASSENGER_NAME',
        `Passenger ${index + 1} must have a full name between 2 and 120 characters.`,
      );
    }
    if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > maxParticipants) {
      throw createManualPassengerError(
        'INVALID_SEAT_NUMBER',
        `Passenger ${index + 1} must have a seat between 1 and ${maxParticipants}.`,
      );
    }
    if (seenSeats.has(seatNumber)) {
      throw createManualPassengerError(
        'DUPLICATE_SEAT_IN_BOOKING',
        `Seat ${seatNumber} is assigned more than once in this booking.`,
      );
    }
    if (
      !phone
      || phone.length > 40
      || !/^[+()\d\s-]+$/.test(phone)
      || (phone.match(/\d/g) || []).length < 7
    ) {
      throw createManualPassengerError(
        'INVALID_PHONE',
        `Passenger ${index + 1} must have a valid phone number.`,
      );
    }

    seenSeats.add(seatNumber);
    return { name, phone, seatNumber, seatLabel: `S${seatNumber}` };
  });

  return {
    tourId,
    tourCode,
    bookingRef,
    email,
    pickupDate: pickupDate.uk,
    pickupDateISO: pickupDate.iso,
    pickupTime,
    pickupLocation,
    passengers,
  };
};

const getBookingPassengerCount = (booking = {}) => {
  if (Array.isArray(booking.passengerDetails)) return booking.passengerDetails.length;
  if (Array.isArray(booking.passengerNames)) return booking.passengerNames.length;
  if (Array.isArray(booking.passengers)) return booking.passengers.length;
  return 0;
};

const getBookingSeatNumbers = (booking = {}) => {
  const seats = new Set();
  if (Array.isArray(booking.seatNumbers)) {
    booking.seatNumbers.forEach((seat) => {
      const numericSeat = Number(seat);
      if (Number.isInteger(numericSeat) && numericSeat > 0) seats.add(numericSeat);
    });
  }
  if (Array.isArray(booking.passengerDetails)) {
    booking.passengerDetails.forEach((passenger) => {
      const numericSeat = Number(passenger?.seatNo);
      if (Number.isInteger(numericSeat) && numericSeat > 0) seats.add(numericSeat);
    });
  }
  return seats;
};

const findManualPassengerSeatConflicts = (bookings = {}, requestedPassengers = []) => {
  const occupiedSeats = new Set();
  Object.values(bookings || {}).forEach((booking) => {
    getBookingSeatNumbers(booking).forEach((seat) => occupiedSeats.add(seat));
  });
  return requestedPassengers
    .map((passenger) => passenger.seatNumber)
    .filter((seatNumber) => occupiedSeats.has(seatNumber));
};

const mergePickupPoint = (existingPoints, pickupPoint) => {
  const points = Array.isArray(existingPoints)
    ? existingPoints.filter((point) => point && typeof point === 'object')
    : [];
  const alreadyExists = points.some((point) => (
    point.date === pickupPoint.date
    && point.time === pickupPoint.time
    && point.location === pickupPoint.location
  ));
  return alreadyExists ? points : [...points, pickupPoint];
};

const buildManualPassengerBookingUpdates = ({
  normalized,
  actorUid,
  tourData,
  existingTourBookings = {},
  existingTopLevelPickupPoints = [],
  nowIso = new Date().toISOString(),
  idempotencyKey = `manual-create:${randomUUID()}`,
}) => {
  const pickupPoint = {
    date: normalized.pickupDate,
    time: normalized.pickupTime,
    location: normalized.pickupLocation,
  };
  const passengerDetails = normalized.passengers.map((passenger) => ({
    name: passenger.name,
    bookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    seatLabel: passenger.seatLabel,
    seatNo: passenger.seatNumber,
    pickupPoint,
    pickupDate: normalized.pickupDate,
    phone: passenger.phone,
  }));
  const passengerNames = normalized.passengers.map((passenger) => passenger.name);
  const seatNumbers = normalized.passengers.map((passenger) => passenger.seatNumber);
  const seatLabels = normalized.passengers.map((passenger) => passenger.seatLabel);
  const existingPassengerCount = Object.values(existingTourBookings || {})
    .reduce((total, booking) => total + getBookingPassengerCount(booking), 0);
  const totalPassengerCount = existingPassengerCount + passengerNames.length;
  const maxParticipants = Number.isInteger(tourData?.maxParticipants) && tourData.maxParticipants > 0
    ? tourData.maxParticipants
    : 53;
  if (totalPassengerCount > maxParticipants) {
    throw createManualPassengerError(
      'TOUR_CAPACITY_EXCEEDED',
      `This booking would exceed the tour capacity of ${maxParticipants}.`,
    );
  }

  const booking = {
    bookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    passengerNames,
    passengers: passengerNames,
    passengerDetails,
    pickupPoints: [pickupPoint],
    seatNumbers,
    seatLabels,
    pickupDate: normalized.pickupDate,
    pickupTime: normalized.pickupTime,
    pickupLocation: normalized.pickupLocation,
    source: 'web-admin-manual',
    createdAt: nowIso,
    createdBy: actorUid,
  };
  const identity = {
    bookingRef: normalized.bookingRef,
    normalizedBookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    email: normalized.email,
    normalizedEmail: normalized.email,
  };
  const manifest = {
    status: MANIFEST_STATUS.PENDING,
    passengerStatus: passengerNames.map(() => MANIFEST_STATUS.PENDING),
    lastUpdated: nowIso,
    idempotencyKey,
  };

  return {
    booking,
    identity,
    manifest,
    totalPassengerCount,
    updates: {
      [`bookings/${normalized.bookingRef}`]: booking,
      [`booking_identities/${normalized.bookingRef}`]: identity,
      [`tour_manifests/${normalized.tourId}/bookings/${normalized.bookingRef}`]: manifest,
      [`tours/${normalized.tourId}/pickupPoints`]: mergePickupPoint(tourData.pickupPoints, pickupPoint),
      [`pickupPoints/${normalized.tourId}`]: mergePickupPoint(existingTopLevelPickupPoints, pickupPoint),
      [`tours/${normalized.tourId}/currentParticipants`]: totalPassengerCount,
      [`tours/${normalized.tourId}/bookedPassengerCount`]: totalPassengerCount,
      [`tours/${normalized.tourId}/manifestPassengerCount`]: totalPassengerCount,
    },
  };

};

const verifyOperationsAdminAccess = async ({ authUid, db = admin.database() }) => {
  if (!isValidFirebaseKey(authUid)) return false;
  if (authUid === OPERATIONS_ADMIN_UID) return true;
  const snapshot = await db.ref(`admin_users/${authUid}`).once('value');
  return snapshot.val() === true;
};

const DEFAULT_ADMIN_PORTAL_ORIGINS = new Set([
  'https://loch-lomond-travel-admin.web.app',
  'https://loch-lomond-travel-admin.firebaseapp.com',
]);

const isAllowedAdminOrigin = (origin, configuredOrigins = process.env.ADMIN_PORTAL_ALLOWED_ORIGINS) => {
  if (!origin) return true;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (parsedOrigin.origin !== origin || !['http:', 'https:'].includes(parsedOrigin.protocol)) return false;
  if (
    parsedOrigin.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)
  ) return true;

  const extraOrigins = String(configuredOrigins || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return DEFAULT_ADMIN_PORTAL_ORIGINS.has(parsedOrigin.origin) || extraOrigins.includes(parsedOrigin.origin);
};

const applyAuthenticatedCors = (req, res) => {
  const requestOrigin = typeof req.headers?.origin === 'string' ? req.headers.origin.trim() : '';
  const allowed = isAllowedAdminOrigin(requestOrigin);
  if (requestOrigin && allowed) res.set('Access-Control-Allow-Origin', requestOrigin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  return allowed;
};

const deleteStoragePrefixes = async ({ bucket = admin.storage().bucket(), prefixes = [] }) => {
  let deleted = 0;
  for (const prefix of [...new Set(prefixes.filter(Boolean))]) {
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map(async (file) => {
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    }));
  }
  return deleted;
};

const deleteStoragePaths = async ({ bucket = admin.storage().bucket(), paths = [] }) => {
  const uniquePaths = [...new Set(paths.filter((path) => typeof path === 'string' && path.trim()))];
  await Promise.all(uniquePaths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
  return uniquePaths.length;
};

const buildTourDeletionUpdates = ({
  tourId,
  bookings = {},
  drivers = {},
  driverUsers = {},
  contentReports = {},
  globalSafetyAlerts = {},
}) => {
  const updates = {
    [`tours/${tourId}`]: null,
    [`tour_manifests/${tourId}`]: null,
    [`pickupPoints/${tourId}`]: null,
    [`chats/${tourId}`]: null,
    [`internal_chats/${tourId}`]: null,
    [`group_tour_photos/${tourId}`]: null,
    [`private_tour_photos/${tourId}`]: null,
    [`broadcasts/${tourId}`]: null,
    [`tour_notifications/${tourId}`]: null,
    [`notification_read_state/${tourId}`]: null,
    [`notification_read_migration_requests/${tourId}`]: null,
    [`notification_read_legacy_cleanup_queue/${tourId}`]: null,
    [`tour_access_grants/${tourId}`]: null,
    [`manual_booking_creation_locks/tours/${tourId}`]: null,
    [`driver_assignment_locks/tours/${tourId}`]: null,
    [`safety_submission_locks/${tourId}`]: null,
  };

  Object.keys(bookings).forEach((bookingRef) => {
    updates[`bookings/${bookingRef}`] = null;
    updates[`booking_identities/${bookingRef}`] = null;
    updates[`passenger_identity_security/${bookingRef}`] = null;
    updates[`booking_access_grants/${bookingRef}`] = null;
    updates[`manual_booking_creation_locks/bookings/${bookingRef}`] = null;
  });

  Object.entries(drivers).forEach(([driverId, driver = {}]) => {
    const currentTourId = normalizeTourKeyForComparison(driver.currentTourId);
    const assignmentKeys = Object.keys(driver.assignments || {});
    assignmentKeys.forEach((candidate) => {
      if (normalizeTourKeyForComparison(candidate) === tourId) {
        updates[`drivers/${driverId}/assignments/${candidate}`] = null;
      }
    });
    if (currentTourId !== tourId) return;
    updates[`drivers/${driverId}/currentTourId`] = null;
    updates[`drivers/${driverId}/currentTourCode`] = null;
    const authUid = resolveTrimmedString(driver.authUid);
    if (authUid && isValidFirebaseKey(authUid)) {
      updates[`users/${authUid}/driverAssignedTourId`] = null;
      updates[`users/${authUid}/lastUpdated`] = Date.now();
    }
  });
  Object.keys(driverUsers).forEach((authUid) => {
    if (!isValidFirebaseKey(authUid)) return;
    updates[`users/${authUid}/driverAssignedTourId`] = null;
    updates[`users/${authUid}/lastUpdated`] = Date.now();
  });

  Object.entries(contentReports).forEach(([reportId, report = {}]) => {
    if (normalizeTourKeyForComparison(report.tourId) === tourId) {
      updates[`content_reports/${reportId}`] = null;
    }
  });
  Object.entries(globalSafetyAlerts).forEach(([eventId, alert = {}]) => {
    if (normalizeTourKeyForComparison(alert.tourId) === tourId) {
      updates[`globalSafetyAlerts/${eventId}`] = null;
    }
  });

  return updates;
};

const getBookingsForTour = async ({ db, tourId, tourCode }) => {
  const bookings = {};
  const candidates = [...new Set([tourId, resolveTrimmedString(tourCode)].filter(Boolean))];
  const snapshots = await Promise.all(candidates.map((candidate) => (
    db.ref('bookings').orderByChild('tourId').equalTo(candidate).once('value')
  )));
  snapshots.forEach((snapshot) => Object.assign(bookings, snapshot.val() || {}));
  return bookings;
};

const resolveReportedPhotoStoragePaths = ({ tourId, photo = {} }) => {
  const prefix = `group_tour_photos/${tourId}/`;
  const paths = [photo.storagePath, photo.viewerStoragePath, photo.thumbnailStoragePath]
    .filter((path) => typeof path === 'string' && path.startsWith(prefix));
  const parsedSource = parseSourcePhotoPath(photo.storagePath);
  if (parsedSource?.visibility === 'group' && parsedSource.tourId === tourId) {
    const variants = buildPhotoVariantPaths(parsedSource);
    paths.push(variants.viewerPath, variants.thumbnailPath);
  }
  return [...new Set(paths)];
};

const acquireManualBookingLock = async ({ db, path, owner, nowMs, ttlMs = MANUAL_BOOKING_LOCK_TTL_MS }) => {
  const result = await db.ref(path).transaction((current) => {
    const activeLock = current
      && typeof current === 'object'
      && Number(current.expiresAtMs) > nowMs
      && current.owner !== owner;
    if (activeLock) return undefined;
    return {
      owner,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
  }, undefined, false);
  return Boolean(result.committed && result.snapshot.val()?.owner === owner);
};

const releaseManualBookingLock = async ({ db, path, owner }) => {
  try {
    await db.ref(path).transaction((current) => (
      current?.owner === owner ? null : current
    ), undefined, false);
  } catch (error) {
    log.warn('Manual passenger lock release failed', { path, error: error?.message || String(error) });
  }
};

const cleanupInvalidTokens = async (invalidTokens = [], remover = removeInvalidToken) => {
  if (!Array.isArray(invalidTokens) || invalidTokens.length === 0) {
    return { attempted: 0, failed: 0 };
  }

  const results = await Promise.allSettled(invalidTokens.map(({ userId, token, reason }) => (
    remover(userId, token, reason ? { reason } : undefined)
  )));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    log.error('Invalid push token cleanup completed with failures', {
      attempted: results.length,
      failed: failed.length,
    });
  }
  return { attempted: results.length, failed: failed.length };
};

const getBearerToken = (req) => {
  const headerValue = req.headers?.authorization || req.headers?.Authorization;
  if (typeof headerValue !== 'string') return null;

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

const verifyRequestAuthUid = async (req) => {
  const token = getBearerToken(req);
  if (!token) {
    return { success: false, reason: 'AUTH_TOKEN_MISSING' };
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = typeof decoded?.uid === 'string' ? decoded.uid.trim() : '';
    if (!uid || !isValidFirebaseKey(uid)) {
      return { success: false, reason: 'AUTH_UID_INVALID' };
    }

    return { success: true, uid, claims: decoded };
  } catch (error) {
    log.warn('Request auth token verification failed', {
      reason: error?.code || 'AUTH_TOKEN_INVALID',
      error: error?.message || String(error),
    });
    return { success: false, reason: 'AUTH_TOKEN_INVALID' };
  }
};

const resolveSafetyReporterAccess = async ({ db, authUid, tourId, requestedRole }) => {
  const [participantSnapshot, userSnapshot, manifestSnapshot] = await Promise.all([
    db.ref(`tours/${tourId}/participants/${authUid}`).once('value'),
    db.ref(`users/${authUid}`).once('value'),
    db.ref(`tour_manifests/${tourId}`).once('value'),
  ]);
  const userData = userSnapshot.val() || {};
  const manifestData = manifestSnapshot.val() || {};
  const driverId = resolveTrimmedString(userData.driverId);
  let isAssignedDriver = false;
  let driverData = {};
  if (driverId && isValidFirebaseKey(driverId) && manifestData?.assigned_drivers?.[driverId] === true) {
    const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
    driverData = driverSnapshot.val() || {};
    isAssignedDriver = resolveTrimmedString(driverData.authUid) === authUid
      && isDriverProfileAssignedToTour(driverData, tourId);
  }

  if (requestedRole === 'driver' && isAssignedDriver) {
    return { allowed: true, role: 'driver', principalId: `driver:${driverId}` };
  }
  if (requestedRole === 'passenger' && participantSnapshot.exists()) {
    const principalId = resolveTrimmedString(userData.stablePassengerId)
      || resolveTrimmedString(userData.privatePhotoOwnerId)
      || authUid;
    return { allowed: true, role: 'passenger', principalId };
  }
  return { allowed: false, role: requestedRole, principalId: null };
};

const buildVerifiedLoginGrantUpdates = ({
  authUid,
  bookingRef,
  tourId,
  nowMs = Date.now(),
}) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(bookingRef) || !isValidFirebaseKey(tourId)) {
    return null;
  }

  const grantedAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + VERIFIED_LOGIN_GRANT_TTL_MS;
  const grantPayload = {
    source: 'verifyPassengerLogin',
    bookingRef,
    tourId,
    grantedAt,
    grantedAtMs: nowMs,
    expiresAtMs,
  };

  return {
    [`tour_access_grants/${tourId}/${authUid}`]: grantPayload,
    [`booking_access_grants/${bookingRef}/${authUid}`]: grantPayload,
  };
};

const buildSafeAppSessionEvent = ({ session, eventType, reason, actorType, nowMs = Date.now() }) => ({
  ...buildAppSessionEvent({ session, eventType, reason, actorType, nowMs }),
  authUidHash: createHash('sha256').update(session.authUid).digest('hex').slice(0, 24),
});

const issuePassengerAppSession = async ({
  db,
  authUid,
  principalId,
  tourId,
  bookingRef,
  identityUpdates,
  grantUpdates,
  nowMs = Date.now(),
}) => {
  const lock = await acquireAppSessionLock({ db, authUid, operation: 'issue', nowMs });
  if (!lock.acquired) {
    const error = new Error('App session operation is already in progress');
    error.code = 'SESSION_IN_PROGRESS';
    throw error;
  }
  try {
    const [existingSnapshot, userSnapshot] = await Promise.all([
      db.ref(`app_sessions/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
    ]);
    const existingSession = existingSnapshot.val();
    const session = buildPassengerSessionRecord({ authUid, principalId, tourId, nowMs });
    const participant = buildPassengerParticipantRecord({ session });
    const updates = existingSession?.sessionId
      ? buildAppSessionCleanupUpdates({ session: existingSession, userProfile: userSnapshot.val() || {}, nowMs })
      : {};
    const eventId = db.ref('app_session_events').push().key;
    Object.assign(updates, grantUpdates, identityUpdates, {
      [`users/${authUid}/principalType`]: 'passenger',
      [`app_sessions/${authUid}`]: session,
      [`tours/${tourId}/participants/${authUid}`]: participant,
      [`app_session_events/${eventId}`]: buildSafeAppSessionEvent({
        session,
        eventType: existingSession ? 'refreshed' : 'issued',
        reason: existingSession ? 'credential_reverification' : 'credential_verification',
        actorType: 'passenger',
        nowMs,
      }),
    });
    await db.ref().update(updates);
    if (existingSession?.principalType === 'driver') {
      await cleanupDriverLocationForSession({ db, session: existingSession });
    }
    return session;
  } finally {
    await releaseAppSessionLock({ db, authUid, owner: lock.owner });
  }
};

const issueDriverAppSession = async ({
  db,
  authUid,
  driverId,
  tourId,
  profileUpdates,
  nowMs = Date.now(),
}) => {
  const lock = await acquireAppSessionLock({ db, authUid, operation: 'issue', nowMs });
  if (!lock.acquired) {
    const error = new Error('App session operation is already in progress');
    error.code = 'SESSION_IN_PROGRESS';
    throw error;
  }
  try {
    const [existingSnapshot, userSnapshot] = await Promise.all([
      db.ref(`app_sessions/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
    ]);
    const existingSession = existingSnapshot.val();
    const session = buildDriverSessionRecord({ authUid, driverId, tourId, nowMs });
    const updates = existingSession?.sessionId
      ? buildAppSessionCleanupUpdates({ session: existingSession, userProfile: userSnapshot.val() || {}, nowMs })
      : {};
    const eventId = db.ref('app_session_events').push().key;
    Object.assign(updates, profileUpdates, {
      [`app_sessions/${authUid}`]: session,
      [`app_session_events/${eventId}`]: buildSafeAppSessionEvent({
        session,
        eventType: existingSession ? 'refreshed' : 'issued',
        reason: existingSession ? 'driver_reverification' : 'driver_verification',
        actorType: 'driver',
        nowMs,
      }),
    });
    await db.ref().update(updates);
    if (existingSession?.principalType === 'driver') {
      await cleanupDriverLocationForSession({ db, session: existingSession });
    }
    return session;
  } finally {
    await releaseAppSessionLock({ db, authUid, owner: lock.owner });
  }
};

const compactDefined = (value = {}) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
);

const cleanPassengerString = (value, maxLength = 500) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

const buildPassengerSafeItinerary = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceDays = Array.isArray(value.days)
    ? value.days
    : (value.days && typeof value.days === 'object' ? Object.values(value.days) : []);
  const days = sourceDays.slice(0, 60).map((day, index) => {
    const sourceActivities = Array.isArray(day?.activities)
      ? day.activities
      : (day?.activities && typeof day.activities === 'object' ? Object.values(day.activities) : []);
    const activities = sourceActivities.slice(0, 50).map((activity) => compactDefined({
      time: cleanPassengerString(activity?.time, 40),
      description: cleanPassengerString(activity?.description, 1000),
    })).filter((activity) => activity.description);
    return compactDefined({
      day: Number.isInteger(day?.day) && day.day > 0 ? day.day : index + 1,
      title: cleanPassengerString(day?.title, 200),
      content: cleanPassengerString(day?.content, 12000),
      activities: activities.length ? activities : undefined,
    });
  });
  const sourceWarnings = Array.isArray(value.warnings)
    ? value.warnings
    : (value.warnings && typeof value.warnings === 'object' ? Object.values(value.warnings) : []);
  const warnings = sourceWarnings.slice(0, 20)
    .map((warning) => cleanPassengerString(warning, 1000))
    .filter(Boolean);

  const itinerary = compactDefined({
    title: cleanPassengerString(value.title, 200),
    days: days.length ? days : undefined,
    warnings: warnings.length ? warnings : undefined,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 1 ? value.revision : undefined,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : undefined,
  });
  return Object.keys(itinerary).length ? itinerary : null;
};

const buildPassengerSafePickup = (value = {}, fallback = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pickup = compactDefined({
    date: cleanPassengerString(value.date || value.pickupDate || fallback.date, 40),
    time: cleanPassengerString(value.time || value.pickupTime || fallback.time, 40),
    location: cleanPassengerString(value.location || value.pickupLocation || fallback.location, 250),
    address: cleanPassengerString(value.address || value.pickupAddress || fallback.address, 500),
  });
  return pickup.location || pickup.address || pickup.time || pickup.date ? pickup : null;
};

const buildPassengerSafeBooking = (bookingRef, bookingData = {}, tourId = '') => {
  const normalized = normalizeManifestBooking(bookingRef, bookingData);
  const fallbackPickup = {
    date: bookingData.pickupDate,
    time: bookingData.pickupTime,
    location: bookingData.pickupLocation,
    address: bookingData.pickupAddress,
  };
  const pickupPoints = (Array.isArray(normalized.pickupPoints) ? normalized.pickupPoints : [])
    .slice(0, 20)
    .map((pickup) => buildPassengerSafePickup(pickup, fallbackPickup))
    .filter(Boolean);
  if (!pickupPoints.length) {
    const fallback = buildPassengerSafePickup(fallbackPickup);
    if (fallback) pickupPoints.push(fallback);
  }
  const passengerNames = normalized.passengerNames.slice(0, 100)
    .map((name) => cleanPassengerString(name, 160))
    .filter(Boolean);
  const seatNumbers = normalized.seatNumbers.slice(0, 100).map((seat) => (
    typeof seat === 'number' && Number.isFinite(seat)
      ? seat
      : cleanPassengerString(seat, 40)
  )).filter((seat) => seat !== '');
  const primaryPickup = pickupPoints[0] || {};

  return compactDefined({
    id: bookingRef,
    tourId: normalizeTourKeyForComparison(tourId || bookingData.tourId) || undefined,
    tourCode: cleanPassengerString(bookingData.tourCode, 100),
    passengerNames,
    seatNumbers,
    pickupPoints,
    pickupDate: cleanPassengerString(bookingData.pickupDate || primaryPickup.date, 40),
    pickupTime: cleanPassengerString(bookingData.pickupTime || primaryPickup.time, 40),
    pickupLocation: cleanPassengerString(
      bookingData.pickupLocation || primaryPickup.location || primaryPickup.address,
      250,
    ),
    totalPax: Number.isSafeInteger(bookingData.totalPax) && bookingData.totalPax >= 0
      ? bookingData.totalPax
      : passengerNames.length,
  });
};

const buildPassengerSafeTour = (tourId, tourData = {}) => {
  const participantCount = Number.isSafeInteger(tourData.currentParticipants) && tourData.currentParticipants >= 0
    ? tourData.currentParticipants
    : Object.keys(tourData.participants || {}).length;
  return compactDefined({
    id: normalizeTourKeyForComparison(tourId),
    name: cleanPassengerString(tourData.name, 200),
    tourCode: cleanPassengerString(tourData.tourCode, 100),
    destination: cleanPassengerString(tourData.destination, 200),
    startDate: cleanPassengerString(tourData.startDate, 40),
    endDate: cleanPassengerString(tourData.endDate, 40),
    duration: typeof tourData.duration === 'number' && Number.isFinite(tourData.duration)
      ? tourData.duration
      : cleanPassengerString(tourData.duration, 40),
    isActive: tourData.isActive !== false,
    currentParticipants: participantCount,
    maxParticipants: Number.isSafeInteger(tourData.maxParticipants) && tourData.maxParticipants >= 0
      ? tourData.maxParticipants
      : undefined,
    driverName: cleanPassengerString(tourData.driverName, 160),
    driverPhone: cleanPassengerString(tourData.driverPhone, 80),
    itinerary: buildPassengerSafeItinerary(tourData.itinerary),
  });
};

const normalizePassengerStatuses = (passengerStatuses, totalPax) => {
  const baseStatuses = Array.isArray(passengerStatuses) ? passengerStatuses : [];
  const padded = [...baseStatuses];

  if (typeof totalPax === 'number' && totalPax > padded.length) {
    padded.push(...Array(totalPax - padded.length).fill(MANIFEST_STATUS.PENDING));
  } else if (typeof totalPax === 'number' && totalPax > 0 && padded.length > totalPax) {
    padded.length = totalPax;
  }

  return padded.map((status) => (
    Object.values(MANIFEST_STATUS).includes(status) ? status : MANIFEST_STATUS.PENDING
  ));
};

const deriveParentStatusFromPassengers = (passengerStatuses = []) => {
  if (!Array.isArray(passengerStatuses) || passengerStatuses.length === 0) return MANIFEST_STATUS.PENDING;

  const normalized = passengerStatuses.map((status) => status || MANIFEST_STATUS.PENDING);
  if (normalized.every((status) => status === MANIFEST_STATUS.BOARDED)) return MANIFEST_STATUS.BOARDED;
  if (normalized.every((status) => status === MANIFEST_STATUS.NO_SHOW)) return MANIFEST_STATUS.NO_SHOW;
  if (normalized.every((status) => status === MANIFEST_STATUS.PENDING)) return MANIFEST_STATUS.PENDING;
  return MANIFEST_STATUS.PARTIAL;
};

const normalizeManifestBooking = (bookingRef, bookingData = {}) => {
  const { rows, duplicateCount } = normalizeManifestPassengerRows(bookingData);
  const passengerNames = rows.map((row) => row.name);
  const seatNumbers = rows.map((row) => row.seatNumber ?? 'TBA');
  const seatLabels = rows.map((row) => row.seatLabel || 'TBA');
  const passengerDetails = rows.map((row) => row.detail).filter(Boolean);

  if (passengerNames.length > seatNumbers.length) {
    seatNumbers.push(...Array(passengerNames.length - seatNumbers.length).fill('TBA'));
  } else if (seatNumbers.length > passengerNames.length && passengerNames.length > 0) {
    seatNumbers.length = passengerNames.length;
  }

  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [];
  const firstPickup = pickupPoints[0] || {};

  const normalizedBooking = {
    id: bookingRef,
    ...bookingData,
    passengerNames,
    passengers: passengerNames,
    ...(Array.isArray(bookingData.passengerDetails) ? { passengerDetails } : {}),
    seatNumbers,
    seatLabels,
    pickupPoints,
    pickupDate: firstPickup.date || bookingData.pickupDate || 'TBA',
    pickupTime: firstPickup.time || bookingData.pickupTime || 'TBA',
    pickupLocation: firstPickup.location || bookingData.pickupLocation || bookingData.pickupAddress || 'To be confirmed',
  };
  Object.defineProperty(normalizedBooking, '_manifestPassengerSourceIndexes', {
    value: rows.map((row) => row.sourceIndexes),
    enumerable: false,
  });
  Object.defineProperty(normalizedBooking, '_manifestDuplicatePassengerCount', {
    value: duplicateCount,
    enumerable: false,
  });
  return normalizedBooking;
};

// The full booking record is needed while the Function reconciles duplicated
// passenger rows, but the driver manifest only renders this bounded operational
// subset. Keeping the projection here prevents contact, payment, service and
// contract fields from crossing the backend boundary or entering offline cache.
const buildDriverManifestBooking = ({ bookingRef, normalizedBooking, passengerStatus, status }) => ({
  id: cleanPassengerString(bookingRef, 120),
  passengerNames: normalizedBooking.passengerNames.map((name) => (
    cleanPassengerString(name, 180) || 'Unknown Passenger'
  )),
  seatNumbers: normalizedBooking.passengerNames.map((_, index) => {
    const seat = normalizedBooking.seatNumbers?.[index];
    return typeof seat === 'number' && Number.isFinite(seat)
      ? seat
      : (cleanPassengerString(String(seat ?? ''), 40) || 'TBA');
  }),
  seatLabels: normalizedBooking.passengerNames.map((_, index) => (
    cleanPassengerString(normalizedBooking.seatLabels?.[index], 80) || 'TBA'
  )),
  passengerStatus,
  hasPassengerStatuses: true,
  status,
  pickupDate: cleanPassengerString(normalizedBooking.pickupDate, 40) || 'TBA',
  pickupLocation: cleanPassengerString(normalizedBooking.pickupLocation, 250) || 'To be confirmed',
  pickupTime: cleanPassengerString(normalizedBooking.pickupTime, 40) || 'TBA',
});

const verifyTourManifestAccess = async ({ authUid, tourId, db = admin.database() }) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(tourId)) {
    return { allowed: false, reason: 'INVALID_INPUT' };
  }

  if (authUid === OPERATIONS_ADMIN_UID) {
    return { allowed: true, role: 'admin' };
  }

  const [adminSnapshot, userSnapshot] = await Promise.all([
    db.ref(`admin_users/${authUid}`).once('value'),
    db.ref(`users/${authUid}`).once('value'),
  ]);

  if (adminSnapshot.val() === true) {
    return { allowed: true, role: 'admin' };
  }

  const userProfile = userSnapshot.val() || {};
  const driverId = resolveTrimmedString(userProfile.driverId);
  if (!driverId || !isValidFirebaseKey(driverId)) {
    return { allowed: false, reason: 'NOT_TOUR_MEMBER' };
  }

  const [driverSnapshot, assignedDriverSnapshot] = await Promise.all([
    db.ref(`drivers/${driverId}/authUid`).once('value'),
    db.ref(`tour_manifests/${tourId}/assigned_drivers/${driverId}`).once('value'),
  ]);

  if (driverSnapshot.val() === authUid && assignedDriverSnapshot.val() === true) {
    return { allowed: true, role: 'assigned_driver', driverId };
  }

  return { allowed: false, reason: 'NOT_TOUR_MEMBER' };
};

const buildTourManifestPayload = async ({ tourId, requestedTourCode = null, db = admin.database() }) => {
  const canonicalTourId = normalizeTourKeyForComparison(tourId || requestedTourCode);
  if (!canonicalTourId || !isValidFirebaseKey(canonicalTourId)) {
    throw new Error('Invalid tour id');
  }

  const [tourSnapshot, bookingsByTourIdSnapshot, manifestSnapshot] = await Promise.all([
    db.ref(`tours/${canonicalTourId}`).once('value'),
    db.ref('bookings').orderByChild('tourId').equalTo(canonicalTourId).once('value'),
    db.ref(`tour_manifests/${canonicalTourId}`).once('value'),
  ]);
  if (!tourSnapshot.exists()) {
    const error = new Error('Tour not found');
    error.code = 'TOUR_NOT_FOUND';
    throw error;
  }

  const tourData = tourSnapshot.val() || {};
  const tourCode = resolveTrimmedString(tourData.tourCode)
    || resolveTrimmedString(requestedTourCode)
    || canonicalTourId.replace(/_/g, ' ');

  const rawBookings = bookingsByTourIdSnapshot.val() || {};
  const manifestData = manifestSnapshot.val() || {};
  const bookingStatuses = manifestData.bookings || {};
  const bookings = Object.entries(rawBookings).map(([bookingRef, bookingData]) => {
    const normalizedBooking = normalizeManifestBooking(bookingRef, bookingData || {});
    const liveStatus = bookingStatuses[bookingRef] || {};
    const totalPax = normalizedBooking.passengerNames.length;
    const hasPassengerStatuses = Array.isArray(liveStatus.passengerStatus);
    const legacyParentStatus = Object.values(MANIFEST_STATUS).includes(liveStatus.status)
      ? liveStatus.status
      : MANIFEST_STATUS.PENDING;
    const rawPassengerStatuses = hasPassengerStatuses
      ? normalizedBooking._manifestPassengerSourceIndexes.map((indexes) => {
        const statuses = indexes
          .map((index) => liveStatus.passengerStatus[index])
          .filter((status) => Object.values(MANIFEST_STATUS).includes(status));
        const resolved = statuses.find((status) => status !== MANIFEST_STATUS.PENDING);
        return resolved || statuses[0] || MANIFEST_STATUS.PENDING;
      })
      : Array(totalPax).fill(legacyParentStatus);
    const passengerStatus = normalizePassengerStatuses(rawPassengerStatuses, totalPax);
    const status = deriveParentStatusFromPassengers(passengerStatus);

    return buildDriverManifestBooking({
      bookingRef,
      normalizedBooking,
      passengerStatus,
      status,
    });
  });

  const stats = bookings.reduce((acc, booking) => {
    const paxCount = booking.passengerNames.length;
    acc.totalPax += paxCount;

    if (booking.hasPassengerStatuses && Array.isArray(booking.passengerStatus) && booking.passengerStatus.length > 0) {
      booking.passengerStatus.forEach((status) => {
        if (status === MANIFEST_STATUS.BOARDED) acc.checkedIn += 1;
        if (status === MANIFEST_STATUS.NO_SHOW) acc.noShows += 1;
      });
    } else if (booking.status === MANIFEST_STATUS.BOARDED) {
      acc.checkedIn += paxCount;
    } else if (booking.status === MANIFEST_STATUS.NO_SHOW) {
      acc.noShows += paxCount;
    }

    return acc;
  }, { totalBookings: bookings.length, totalPax: 0, checkedIn: 0, noShows: 0 });

  return {
    schemaVersion: 1,
    complete: true,
    tourId: canonicalTourId,
    tourCode,
    bookings,
    stats,
  };
};

const normalizeDriverId = (driverId) => {
  if (typeof driverId !== 'string') return '';
  return driverId.trim().toUpperCase();
};

const resolveDriverAssignment = async ({ driverId, driverData = {} }) => {
  const assignedTourId = normalizeTourKeyForComparison(driverData.currentTourId);
  const assignedTourCode = resolveTrimmedString(driverData.currentTourCode);

  if (assignedTourId) {
    return {
      assignedTourId,
      assignedTourCode,
      assignmentSource: 'driver_profile',
    };
  }

  return {
    assignedTourId: null,
    assignedTourCode: null,
    assignmentSource: 'unassigned',
  };
};

const claimDriverAuthUid = async ({ db, driverId, authUid }) => {
  const claimRef = db.ref(`drivers/${driverId}/authUid`);
  const result = await claimRef.transaction((currentValue) => {
    const currentAuthUid = resolveTrimmedString(currentValue);
    if (currentAuthUid && currentAuthUid !== authUid) return undefined;
    return authUid;
  }, undefined, false);
  const claimedAuthUid = resolveTrimmedString(result?.snapshot?.val?.());

  return {
    claimed: Boolean(result?.committed && claimedAuthUid === authUid),
    authUid: claimedAuthUid || null,
  };
};

const buildDriverIdentityProfileUpdates = ({
  driverId,
  authUid,
  assignedTourId = null,
  nowMs = Date.now(),
}) => ({
  [`drivers/${driverId}/lastActive`]: new Date(nowMs).toISOString(),
  [`users/${authUid}/driverId`]: driverId,
  [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
  [`users/${authUid}/driverAssignedTourId`]: assignedTourId || null,
  [`users/${authUid}/principalType`]: 'driver',
  [`users/${authUid}/lastUpdated`]: nowMs,
});

const collectDriverAssignmentConflicts = ({ driverId, tourData = {}, manifestData = {} }) => {
  const conflicts = new Set();
  const tourDriverId = normalizeDriverId(tourData.driverId);
  if (tourDriverId && tourDriverId !== driverId) conflicts.add(tourDriverId);

  Object.entries(manifestData.assigned_drivers || {}).forEach(([candidateDriverId, assigned]) => {
    const normalizedCandidate = normalizeDriverId(candidateDriverId);
    if (assigned === true && normalizedCandidate && normalizedCandidate !== driverId) {
      conflicts.add(normalizedCandidate);
    }
  });

  return [...conflicts].sort();
};

const buildDriverSelfAssignmentUpdates = ({
  driverId,
  authUid,
  driverData = {},
  tourId,
  tourData = {},
  previousTourData = {},
  nowMs = Date.now(),
}) => {
  const canonicalTourCode = resolveTrimmedString(tourData.tourCode) || tourId.replace(/_/g, ' ');
  const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
  const assignedAt = new Date(nowMs).toISOString();
  const driverName = resolveTrimmedString(driverData.name) || driverId;
  const driverPhone = resolveTrimmedString(driverData.phone);
  const updates = {
    [`tours/${tourId}/driverId`]: driverId,
    [`tours/${tourId}/driverName`]: driverName,
    [`tours/${tourId}/driverPhone`]: driverPhone || null,
    [`drivers/${driverId}/currentTourId`]: tourId,
    [`drivers/${driverId}/currentTourCode`]: canonicalTourCode,
    [`drivers/${driverId}/assignments/${tourId}`]: true,
    [`drivers/${driverId}/lastActive`]: assignedAt,
    [`users/${authUid}/driverId`]: driverId,
    [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${authUid}/driverAssignedTourId`]: tourId,
    [`users/${authUid}/principalType`]: 'driver',
    [`users/${authUid}/lastUpdated`]: nowMs,
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    [`tour_manifests/${tourId}/assigned_driver_codes/${driverId}`]: {
      driverId,
      tourId,
      tourCode: canonicalTourCode,
      assignedAt,
      assignedBy: authUid,
    },
  };

  if (previousTourId !== tourId) {
    // Never carry coordinates from an earlier assignment (or a previous driver
    // on the target tour) into the newly authorized driver session.
    updates[`tours/${tourId}/driverLocation`] = null;
  }

  if (previousTourId && previousTourId !== tourId) {
    updates[`drivers/${driverId}/assignments/${previousTourId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_drivers/${driverId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_driver_codes/${driverId}`] = null;

    if (normalizeDriverId(previousTourData.driverId) === driverId) {
      updates[`tours/${previousTourId}/driverId`] = null;
      updates[`tours/${previousTourId}/driverName`] = null;
      updates[`tours/${previousTourId}/driverPhone`] = null;
      updates[`tours/${previousTourId}/driverLocation`] = null;
    }
  }

  return { updates, previousTourId, canonicalTourCode };
};

const getRequestClientKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : req.ip || req.connection?.remoteAddress || 'unknown';

  const explicitClientId = req.headers['x-client-id'];
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'unknown';
  const normalizedClientId = typeof explicitClientId === 'string' && explicitClientId.trim()
    ? explicitClientId.trim()
    : userAgent;

  return `${clientIp}:${normalizedClientId}`;
};

const hashRateLimitDimension = (value) => createHash('sha256')
  .update(String(value || 'unknown'))
  .digest('hex')
  .slice(0, 24);

const checkPassengerLoginRateLimits = async ({
  authUid,
  clientKey,
  bookingRef,
  email,
  limiter = checkRateLimit,
}) => {
  const authDimension = hashRateLimitDimension(authUid);
  const networkDimension = hashRateLimitDimension(clientKey);
  const credentialDimension = hashRateLimitDimension(`${bookingRef}:${email}`);
  const accountDimension = hashRateLimitDimension(bookingRef);
  const checks = [
    {
      scope: 'credential',
      key: `passenger_credential_${credentialDimension}`,
      maxRequests: 8,
    },
    {
      scope: 'account',
      key: `passenger_account_${accountDimension}`,
      maxRequests: 24,
    },
    {
      scope: 'network',
      key: `passenger_network_${networkDimension}`,
      maxRequests: 300,
    },
  ];

  // Consume every dimension for every attempt. Otherwise an already-denied
  // narrow bucket could let the same traffic evade the broad network bucket.
  const results = await Promise.all(checks.map(async (check) => ({
    ...check,
    allowed: await limiter(check.key, check.maxRequests, 60000),
  })));
  const denied = results.find((check) => !check.allowed);
  if (denied) return { allowed: false, scope: denied.scope, authDimension, networkDimension };

  return { allowed: true, authDimension, networkDimension };
};

const getTrustedRequestNetworkKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwardedFor) ? forwardedFor : [forwardedFor])
    .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim())
    .filter(Boolean);
  // Google Front End appends the actual peer and load-balancer addresses. The
  // penultimate hop therefore ignores any attacker-prepended XFF entries.
  const platformAddress = chain.length >= 2
    ? chain[chain.length - 2]
    : chain[0] || req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  return String(platformAddress).trim().slice(0, 128) || 'unknown';
};

const PRIVATE_MEDIA_BATCH_LIMIT = 50;
const PRIVATE_MEDIA_URL_TTL_MS = 5 * 60 * 1000;
const GROUP_MEDIA_BATCH_LIMIT = 50;
const GROUP_MEDIA_URL_TTL_MS = 5 * 60 * 1000;
const GROUP_MEDIA_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const GROUP_MEDIA_ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic']);

const normalizePrivateMediaRequest = (body = {}) => {
  const tourId = normalizeTourKeyForComparison(body.tourId);
  const ownerKey = resolveTrimmedString(body.ownerKey);
  const photoIds = Array.isArray(body.photoIds)
    ? [...new Set(body.photoIds.map(resolveTrimmedString).filter(Boolean))]
    : [];
  if (!tourId || !ownerKey || !isValidFirebaseKey(ownerKey) || photoIds.length < 1
    || photoIds.length > PRIVATE_MEDIA_BATCH_LIMIT || photoIds.some((id) => !isValidFirebaseKey(id))) {
    return null;
  }
  return { tourId, ownerKey, photoIds };
};

const isPrivateMediaPathForRecord = ({ path, tourId, ownerKey }) => {
  const normalized = resolveTrimmedString(path);
  return Boolean(normalized && normalized.startsWith(`private_tour_photos/${tourId}/${ownerKey}/`)
    && !normalized.includes('..'));
};

const PRIVATE_MEDIA_READ_CONCURRENCY = 8;
const readPrivateMediaRecords = async ({ db, tourId, ownerKey, photoIds, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  const records = {};
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, photoIds.length) }, async () => {
    while (nextIndex < photoIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const photoId = photoIds[index];
      const snapshot = await db.ref(`private_tour_photos/${tourId}/${ownerKey}/${photoId}`).once('value');
      if (snapshot.exists()) records[photoId] = snapshot.val();
    }
  });
  await Promise.all(workers);
  return records;
};

const signPrivateMediaRecords = async ({
  bucket,
  input,
  records,
  expires,
  concurrency = PRIVATE_MEDIA_READ_CONCURRENCY,
}) => {
  const media = {};
  const tasks = input.photoIds.flatMap((photoId) => {
    const record = records[photoId];
    if (!record) return [];
    const fields = [
      ['sourceUrl', record.storagePath],
      ['viewerUrl', record.viewerStoragePath],
      ['thumbnailUrl', record.thumbnailStoragePath],
    ];
    return fields
      .filter(([, objectPath]) => isPrivateMediaPathForRecord({ path: objectPath, ...input }))
      .map(([field, objectPath]) => ({ photoId, field, objectPath }));
  });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const [url] = await bucket.file(task.objectPath).getSignedUrl({ action: 'read', expires });
      if (!media[task.photoId]) media[task.photoId] = {};
      media[task.photoId][task.field] = url;
    }
  });
  await Promise.all(workers);
  return media;
};

const verifyCurrentTourPhotoAccess = async ({ db, authUid, tourId }) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(tourId)) {
    return { allowed: false, reason: 'INVALID_INPUT' };
  }
  const [tourSnapshot, adminSnapshot] = await Promise.all([
    db.ref(`tours/${tourId}`).once('value'),
    db.ref(`admin_users/${authUid}`).once('value'),
  ]);
  if (!tourSnapshot.exists()) return { allowed: false, reason: 'NOT_FOUND' };
  if (authUid === OPERATIONS_ADMIN_UID || adminSnapshot.val() === true) {
    return { allowed: true, role: 'admin', principalId: authUid };
  }
  const access = await verifyActiveAppSession({ db, authUid, expectedTourId: tourId });
  if (!access.allowed) return { allowed: false, reason: access.reason };
  return {
    allowed: true,
    role: access.role === 'driver' ? 'assigned_driver' : 'passenger',
    principalId: access.principalId,
    driverId: access.driverId,
    session: access.session,
  };
};

const enforceGroupMediaAppCheck = async (req, env = process.env, appCheck = admin.appCheck()) => {
  const required = env.REQUIRE_APP_CHECK_FOR_GROUP_MEDIA === 'true'
    || env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true';
  if (!required && !isDeployedFunctionsRuntime(env)) return true;
  if (!required && isDeployedFunctionsRuntime(env)) {
    const error = new Error('Production group media App Check enforcement is not configured');
    error.code = 'GROUP_MEDIA_APP_CHECK_CONFIGURATION_REQUIRED';
    throw error;
  }
  const token = req.headers['x-firebase-appcheck'];
  if (typeof token !== 'string' || !token.trim()) return false;
  try {
    await appCheck.verifyToken(token.trim());
    return true;
  } catch (error) {
    return false;
  }
};

const normalizeGroupMediaRequest = (body = {}) => {
  const tourId = normalizeTourKeyForComparison(body.tourId);
  const photoIds = Array.isArray(body.photoIds)
    ? [...new Set(body.photoIds.map(resolveTrimmedString).filter(Boolean))]
    : [];
  if (!tourId || !isValidFirebaseKey(tourId) || photoIds.length < 1
    || photoIds.length > GROUP_MEDIA_BATCH_LIMIT || photoIds.some((id) => !isValidFirebaseKey(id))) {
    return null;
  }
  return { tourId, photoIds };
};

const isGroupMediaPathForRecord = ({ path, tourId }) => {
  const normalized = resolveTrimmedString(path);
  return Boolean(normalized && normalized.startsWith(`group_tour_photos/${tourId}/`)
    && !normalized.includes('..'));
};

const readGroupMediaRecords = async ({ db, tourId, photoIds, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  const records = {};
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, photoIds.length) }, async () => {
    while (nextIndex < photoIds.length) {
      const photoId = photoIds[nextIndex];
      nextIndex += 1;
      const snapshot = await db.ref(`group_tour_photos/${tourId}/${photoId}`).once('value');
      if (snapshot.exists()) records[photoId] = snapshot.val();
    }
  });
  await Promise.all(workers);
  return records;
};

const signGroupMediaRecords = async ({ bucket, input, records, expires, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  const media = {};
  const tasks = input.photoIds.flatMap((photoId) => {
    const record = records[photoId];
    if (!record) return [];
    return [
      ['sourceUrl', record.storagePath],
      ['viewerUrl', record.viewerStoragePath],
      ['thumbnailUrl', record.thumbnailStoragePath],
    ].filter(([, objectPath]) => isGroupMediaPathForRecord({ path: objectPath, tourId: input.tourId }))
      .map(([field, objectPath]) => ({ photoId, field, objectPath }));
  });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const [url] = await bucket.file(task.objectPath).getSignedUrl({ action: 'read', expires });
      if (!media[task.photoId]) media[task.photoId] = {};
      media[task.photoId][task.field] = url;
    }
  });
  await Promise.all(workers);
  return media;
};

exports.resolvePrivatePhotoMedia = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (req, res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const input = normalizePrivateMediaRequest(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: input.tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed || access.principalId !== input.ownerKey) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }
    const records = await readPrivateMediaRecords({ db: admin.database(), ...input });
    if (Object.keys(records).length === 0) return res.status(404).json({ success: false, reason: 'NOT_FOUND' });
    const bucket = admin.storage().bucket();
    const expires = Date.now() + PRIVATE_MEDIA_URL_TTL_MS;
    const media = await signPrivateMediaRecords({ bucket, input, records, expires });
    return res.status(200).json({ success: true, expiresAtMs: expires, media });
  },
);

const normalizePrivatePhotoUploadMetadata = (rawHeader) => {
  const input = normalizeGroupPhotoUploadMetadata(rawHeader);
  return input ? { ...input, uploaderName: undefined } : null;
};

const reservePrivatePhotoRecord = async ({ db, input, principalId, contentType, fileSize, nowMs = Date.now() }) => {
  const photoId = toRealtimeKeySegment(input.idempotencyKey);
  const extension = extensionForGroupPhotoContentType(contentType);
  const storagePath = `private_tour_photos/${input.tourId}/${principalId}/${photoId}.${extension}`;
  const recordRef = db.ref(`private_tour_photos/${input.tourId}/${principalId}/${photoId}`);
  let conflict = false;
  let deduped = false;
  const result = await recordRef.transaction((current) => {
    if (current) {
      if (current.idempotencyKey === input.idempotencyKey && current.userId === principalId
        && current.storagePath === storagePath) {
        deduped = true;
        return current;
      }
      conflict = true;
      return undefined;
    }
    return {
      userId: principalId,
      caption: input.caption,
      timestamp: nowMs,
      storagePath,
      fileSize,
      fileType: contentType,
      idempotencyKey: input.idempotencyKey,
      variantStatus: 'processing',
      variantUpdatedAt: nowMs,
      variantError: null,
      variantVersion: 2,
    };
  });
  if (conflict || !result.committed) return { success: false, reason: 'IDEMPOTENCY_CONFLICT' };
  return { success: true, photoId, storagePath, deduped, recordRef };
};

exports.uploadPrivatePhoto = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 60, memory: '512MiB', cors: true },
  async (req, res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizePrivatePhotoUploadMetadata(req.headers['x-private-photo-metadata']);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: input.tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed) return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    const contentType = resolveTrimmedString(req.headers['content-type'])?.toLowerCase();
    const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!body || body.length < 1 || body.length > GROUP_MEDIA_MAX_UPLOAD_BYTES
      || !GROUP_MEDIA_ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({ success: false, reason: 'INVALID_IMAGE' });
    }
    const reservation = await reservePrivatePhotoRecord({
      db: admin.database(),
      input,
      principalId: access.principalId,
      contentType,
      fileSize: body.length,
    });
    if (!reservation.success) return res.status(409).json({ success: false, reason: reservation.reason });
    const file = admin.storage().bucket().file(reservation.storagePath);
    if (!reservation.deduped || !(await file.exists())[0]) {
      await file.save(body, {
        resumable: false,
        metadata: {
          contentType,
          cacheControl: PRIVATE_PHOTO_CACHE_CONTROL_HEADER,
          metadata: { visibility: 'private', sourceRole: 'source' },
        },
      });
    }
    return res.status(200).json({
      success: true,
      photo: {
        id: reservation.photoId,
        userId: access.principalId,
        caption: input.caption,
        storagePath: reservation.storagePath,
        deduped: reservation.deduped,
      },
    });
  },
);

exports.deletePrivatePhoto = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (req, res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    const photoId = resolveTrimmedString(req.body?.photoId);
    if (!tourId || !isValidFirebaseKey(tourId) || !photoId || !isValidFirebaseKey(photoId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed) return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    const recordRef = admin.database().ref(`private_tour_photos/${tourId}/${access.principalId}/${photoId}`);
    const snapshot = await recordRef.once('value');
    if (!snapshot.exists()) return res.status(200).json({ success: true, alreadyDeleted: true });
    const record = snapshot.val() || {};
    if (record.userId !== access.principalId) {
      return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    }
    const paths = [record.storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
      .filter((path) => isPrivateMediaPathForRecord({ path, tourId, ownerKey: access.principalId }));
    await Promise.all(paths.map((path) => admin.storage().bucket().file(path).delete({ ignoreNotFound: true })));
    await recordRef.remove();
    return res.status(200).json({ success: true, alreadyDeleted: false });
  },
);

const authorizeGroupMediaRequest = async ({ req, res, tourId, db = admin.database() }) => {
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    return null;
  }
  let appCheckValid = false;
  try {
    appCheckValid = await enforceGroupMediaAppCheck(req);
  } catch (error) {
    log.error('Group media App Check configuration failure', error);
    res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    return null;
  }
  if (!appCheckValid) {
    res.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
    return null;
  }
  const access = await verifyCurrentTourPhotoAccess({ db, authUid: requestAuth.uid, tourId });
  if (!access.allowed) {
    res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    return null;
  }
  return { requestAuth, access };
};

exports.resolveGroupPhotoMedia = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizeGroupMediaRequest(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId: input.tourId });
    if (!authorization) return null;
    const records = await readGroupMediaRecords({ db: admin.database(), ...input });
    const expires = Date.now() + GROUP_MEDIA_URL_TTL_MS;
    const media = await signGroupMediaRecords({ bucket: admin.storage().bucket(), input, records, expires });
    return res.status(200).json({ success: true, expiresAtMs: expires, media });
  },
);

const normalizeGroupPhotoUploadMetadata = (rawHeader) => {
  if (typeof rawHeader !== 'string' || rawHeader.length > 4096) return null;
  try {
    const input = JSON.parse(decodeURIComponent(rawHeader));
    const tourId = normalizeTourKeyForComparison(input.tourId);
    const idempotencyKey = resolveTrimmedString(input.idempotencyKey);
    const caption = resolveTrimmedString(input.caption) || '';
    const uploaderName = resolveTrimmedString(input.uploaderName) || 'Tour Member';
    if (!tourId || !isValidFirebaseKey(tourId) || !idempotencyKey || idempotencyKey.length > 180
      || !isValidFirebaseKey(toRealtimeKeySegment(idempotencyKey)) || caption.length > 500
      || uploaderName.length > 100) return null;
    return { tourId, idempotencyKey, caption, uploaderName };
  } catch (error) {
    return null;
  }
};

const extensionForGroupPhotoContentType = (contentType) => ({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}[contentType] || null);

const reserveGroupPhotoRecord = async ({ db, input, access, contentType, fileSize, nowMs = Date.now() }) => {
  const photoId = toRealtimeKeySegment(input.idempotencyKey);
  const extension = extensionForGroupPhotoContentType(contentType);
  const storagePath = `group_tour_photos/${input.tourId}/${photoId}.${extension}`;
  const recordRef = db.ref(`group_tour_photos/${input.tourId}/${photoId}`);
  let conflict = false;
  let deduped = false;
  const result = await recordRef.transaction((current) => {
    if (current) {
      if (current.idempotencyKey === input.idempotencyKey && current.userId === access.principalId
        && current.storagePath === storagePath) {
        deduped = true;
        return current;
      }
      conflict = true;
      return;
    }
    return {
      userId: access.principalId,
      caption: input.caption,
      uploaderName: input.uploaderName,
      timestamp: nowMs,
      storagePath,
      fileSize,
      fileType: contentType,
      idempotencyKey: input.idempotencyKey,
      variantStatus: 'processing',
      variantUpdatedAt: nowMs,
      variantError: null,
      variantVersion: 2,
    };
  });
  if (conflict || !result.committed) return { success: false, reason: 'IDEMPOTENCY_CONFLICT' };
  return { success: true, photoId, storagePath, deduped, recordRef };
};

exports.uploadGroupPhoto = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 60, memory: '512MiB', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizeGroupPhotoUploadMetadata(req.headers['x-group-photo-metadata']);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId: input.tourId });
    if (!authorization) return null;
    const contentType = resolveTrimmedString(req.headers['content-type'])?.toLowerCase();
    const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!body || body.length < 1 || body.length > GROUP_MEDIA_MAX_UPLOAD_BYTES
      || !GROUP_MEDIA_ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({ success: false, reason: 'INVALID_IMAGE' });
    }
    const reservation = await reserveGroupPhotoRecord({
      db: admin.database(),
      input,
      access: authorization.access,
      contentType,
      fileSize: body.length,
    });
    if (!reservation.success) return res.status(409).json({ success: false, reason: reservation.reason });
    const file = admin.storage().bucket().file(reservation.storagePath);
    if (!reservation.deduped || !(await file.exists())[0]) {
      await file.save(body, {
        resumable: false,
        metadata: {
          contentType,
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: { visibility: 'group', sourceRole: 'source' },
        },
      });
    }
    return res.status(200).json({
      success: true,
      photo: {
        id: reservation.photoId,
        userId: authorization.access.principalId,
        caption: input.caption,
        uploaderName: input.uploaderName,
        storagePath: reservation.storagePath,
        deduped: reservation.deduped,
      },
    });
  },
);

exports.deleteGroupPhoto = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    const photoId = resolveTrimmedString(req.body?.photoId);
    if (!tourId || !isValidFirebaseKey(tourId) || !photoId || !isValidFirebaseKey(photoId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId });
    if (!authorization) return null;
    const recordRef = admin.database().ref(`group_tour_photos/${tourId}/${photoId}`);
    const snapshot = await recordRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, reason: 'NOT_FOUND' });
    const record = snapshot.val() || {};
    if (authorization.access.role !== 'admin' && record.userId !== authorization.access.principalId) {
      return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    }
    const paths = [record.storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
      .filter((path) => isGroupMediaPathForRecord({ path, tourId }));
    await Promise.all(paths.map(async (path) => {
      try { await admin.storage().bucket().file(path).delete(); } catch (error) { if (error?.code !== 404) throw error; }
    }));
    await recordRef.remove();
    return res.status(200).json({ success: true });
  },
);

exports.createGroupPhotoChatMessage = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    const photoId = resolveTrimmedString(req.body?.photoId);
    const messageId = resolveTrimmedString(req.body?.messageId);
    const caption = resolveTrimmedString(req.body?.caption) || '';
    const senderName = resolveTrimmedString(req.body?.senderName) || 'Tour Member';
    const clientCreatedAt = Number(req.body?.clientCreatedAt);
    if (!tourId || !isValidFirebaseKey(tourId) || !photoId || !isValidFirebaseKey(photoId)
      || !messageId || !isValidFirebaseKey(messageId) || messageId.length > 160
      || caption.length > 500 || senderName.length > 100 || !Number.isFinite(clientCreatedAt) || clientCreatedAt <= 0) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId });
    if (!authorization) return null;
    const photoSnapshot = await admin.database().ref(`group_tour_photos/${tourId}/${photoId}`).once('value');
    if (!photoSnapshot.exists()) return res.status(404).json({ success: false, reason: 'PHOTO_NOT_FOUND' });
    const isDriver = authorization.access.role === 'assigned_driver';
    const message = {
      schemaVersion: 2,
      text: caption,
      senderName,
      senderId: authorization.access.principalId,
      senderStableId: authorization.access.principalId,
      senderType: isDriver ? 'driver' : 'passenger',
      timestamp: admin.database.ServerValue.TIMESTAMP,
      clientCreatedAt,
      isDriver,
      status: 'sent',
      type: 'image',
      idempotencyKey: messageId,
      photoId,
    };
    const messageRef = admin.database().ref(`chats/${tourId}/messages/${messageId}`);
    let conflict = false;
    const transaction = await messageRef.transaction((current) => {
      if (!current) return message;
      if (current.idempotencyKey === messageId && current.photoId === photoId
        && current.senderId === authorization.access.principalId) return current;
      conflict = true;
      return;
    });
    if (conflict || !transaction.committed) {
      return res.status(409).json({ success: false, reason: 'IDEMPOTENCY_CONFLICT' });
    }
    return res.status(200).json({ success: true, message: { ...transaction.snapshot.val(), id: messageId } });
  },
);

const checkDriverLoginRateLimits = async ({
  authUid,
  clientKey,
  driverId,
  limiter = checkRateLimit,
}) => {
  const authDimension = hashRateLimitDimension(authUid);
  const networkDimension = hashRateLimitDimension(clientKey);
  const credentialDimension = hashRateLimitDimension(driverId);
  const accountDimension = credentialDimension;
  const checks = [
    {
      scope: 'credential',
      key: `driver_credential_${authDimension}_${credentialDimension}`,
      maxRequests: 8,
    },
    {
      scope: 'account',
      key: `driver_account_${accountDimension}`,
      maxRequests: 24,
    },
    {
      scope: 'network',
      key: `driver_network_${networkDimension}`,
      maxRequests: 200,
    },
  ];

  const results = await Promise.all(checks.map(async (check) => ({
    ...check,
    allowed: await limiter(check.key, check.maxRequests, 60000),
  })));
  const denied = results.find((check) => !check.allowed);
  if (denied) return { allowed: false, scope: denied.scope, authDimension, networkDimension };

  return { allowed: true, authDimension, networkDimension };
};

const isDeployedFunctionsRuntime = (env = process.env) => Boolean(env.K_SERVICE);

const shouldRequireLoginAppCheck = (env = process.env) => {
  if (env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true') return true;
  if (isDeployedFunctionsRuntime(env)) {
    const error = new Error('Production login App Check enforcement is not configured');
    error.code = 'LOGIN_APP_CHECK_CONFIGURATION_REQUIRED';
    throw error;
  }
  return false;
};

const enforceLoginAppCheck = async ({ req, networkDimension, loginType }) => {
  const requireAppCheck = shouldRequireLoginAppCheck();
  if (!requireAppCheck) return true;
  const appCheckToken = req.headers['x-firebase-appcheck'];
  if (typeof appCheckToken !== 'string' || !appCheckToken.trim()) return false;
  try {
    await admin.appCheck().verifyToken(appCheckToken.trim());
    return true;
  } catch (error) {
    log.warn(`${loginType} login rejected: invalid App Check token`, {
      networkDimension,
      error: error?.message || String(error),
    });
    return false;
  }
};

let distributedLoginRateLimiterInstance = null;
const distributedLoginRateLimiter = async (...args) => {
  if (!distributedLoginRateLimiterInstance) {
    // Resolve the Admin database lazily so pure Node tests and deployment
    // discovery do not require a runtime database URL merely to load exports.
    distributedLoginRateLimiterInstance = createDistributedLoginRateLimiter({
      database: admin.database(),
    });
  }
  return distributedLoginRateLimiterInstance(...args);
};

let distributedSafetyRateLimiterInstance = null;
const distributedSafetyRateLimiter = async (...args) => {
  if (!distributedSafetyRateLimiterInstance) {
    distributedSafetyRateLimiterInstance = createDistributedLoginRateLimiter({
      database: admin.database(),
      rootPath: SAFETY_RATE_LIMIT_ROOT,
    });
  }
  return distributedSafetyRateLimiterInstance(...args);
};

const checkSafetySubmissionRateLimit = async ({ authUid, limiter = distributedSafetyRateLimiter } = {}) => {
  const normalizedAuthUid = resolveTrimmedString(authUid);
  if (!normalizedAuthUid) return false;
  return limiter(
    `safety_uid_${hashRateLimitDimension(normalizedAuthUid)}`,
    SAFETY_RATE_LIMIT_MAX_REQUESTS,
    SAFETY_RATE_LIMIT_WINDOW_MS,
  );
};

exports.verifyPassengerLogin = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const bookingRef = normalizeBookingRef(req.body?.bookingRef);
    const email = normalizeEmail(req.body?.email);

    if (!bookingRef || !email) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    try {
      const requestAuth = await verifyRequestAuthUid(req);
      const networkKey = getTrustedRequestNetworkKey(req);
      const networkDimension = hashRateLimitDimension(networkKey);
      if (!requestAuth.success) {
        log.warn('Passenger login rejected: missing or invalid Firebase auth token', {
          bookingRef,
          networkDimension,
          reason: requestAuth.reason,
        });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      try {
        const appCheckValid = await enforceLoginAppCheck({
          req,
          networkDimension,
          loginType: 'Passenger',
        });
        if (!appCheckValid) {
          log.warn('Passenger login rejected: missing or invalid App Check token', { networkDimension });
          return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
        }
      } catch (configurationError) {
        log.error('Passenger login disabled by unsafe App Check configuration', configurationError, {
          networkDimension,
        });
        return res.status(503).json({ valid: false, reason: 'SERVICE_UNAVAILABLE' });
      }

      let rateLimit;
      try {
        rateLimit = await checkPassengerLoginRateLimits({
          authUid: requestAuth.uid,
          clientKey: networkKey,
          bookingRef,
          email,
          limiter: distributedLoginRateLimiter,
        });
      } catch (rateLimitError) {
        log.error('Passenger login disabled because distributed rate limiting failed', rateLimitError, {
          networkDimension,
        });
        return res.status(503).json({ valid: false, reason: 'SERVICE_UNAVAILABLE' });
      }
      if (!rateLimit.allowed) {
        log.warn('Passenger login rate limit exceeded', {
          scope: rateLimit.scope,
          authDimension: rateLimit.authDimension,
          networkDimension: rateLimit.networkDimension,
        });
        return res.status(429).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
      }

      const database = admin.database();
      const identityRef = database.ref(`booking_identities/${bookingRef}`);
      const identitySnapshot = await identityRef.once('value');

      if (!identitySnapshot.exists()) {
        log.warn('Passenger login verification failed', { bookingRef, networkDimension, cause: 'BOOKING_NOT_FOUND' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const identity = identitySnapshot.val() || {};
      const storedEmail = normalizeEmail(identity.email);

      if (!storedEmail || storedEmail !== email) {
        log.warn('Passenger login verification failed', { bookingRef, networkDimension, cause: 'EMAIL_MISMATCH' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const resolvedBookingRef = normalizeBookingRef(identity.bookingRef || bookingRef);
      const resolvedTourId = typeof identity.tourId === 'string' ? identity.tourId.trim() : '';
      const canonicalTourId = normalizeTourKeyForComparison(resolvedTourId);

      if (!resolvedBookingRef || !canonicalTourId) {
        log.warn('Booking identity missing essential identifiers', { bookingRef });
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      const [bookingSnapshot, tourSnapshot] = await Promise.all([
        admin.database().ref(`bookings/${resolvedBookingRef}`).once('value'),
        admin.database().ref(`tours/${canonicalTourId}`).once('value'),
      ]);

      if (!bookingSnapshot.exists() || !tourSnapshot.exists()) {
        log.warn('Booking identity points at missing booking or tour', {
          bookingRef,
          resolvedBookingRef,
          tourId: canonicalTourId,
          hasBooking: bookingSnapshot.exists(),
          hasTour: tourSnapshot.exists(),
        });
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      const tourData = tourSnapshot.val() || {};
      if (tourData.isActive === false) {
        log.warn('Passenger login rejected for inactive tour', {
          bookingRef,
          tourId: canonicalTourId,
        });
        return res.status(200).json({ valid: false, reason: 'TOUR_INACTIVE' });
      }

      const canonicalTourCode = resolveTrimmedString(tourData.tourCode) || null;
      const securityRef = database.ref(`passenger_identity_security/${resolvedBookingRef}`);
      const securedIdentity = await ensureOpaquePassengerIdentity({
        securityRef,
        // Transitional seed preserves the live binding while the security-root
        // migration is rolling out. Booking sync is never authoritative after this.
        seed: {
          ...(isOpaquePassengerId(identity.passengerPrincipalId)
            ? {
              passengerPrincipalId: identity.passengerPrincipalId,
              passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
              passengerIdentityIssuedAtMs: identity.passengerIdentityIssuedAtMs || Date.now(),
            }
            : {}),
          ...(typeof identity.authorizedAuthUid === 'string' && identity.authorizedAuthUid.trim()
            ? { authorizedAuthUid: identity.authorizedAuthUid.trim() }
            : {}),
          ...(identity.loginLocked === true
            ? { loginLocked: true, loginLockReason: identity.loginLockReason || 'migration_review_required' }
            : {}),
        },
      });
      const stablePassengerId = securedIdentity.passengerPrincipalId;
      if (!isOpaquePassengerId(stablePassengerId)) {
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      try {
        await authorizePassengerLoginDevice({
          securityRef,
          authUid: requestAuth.uid,
        });
      } catch (authorizationError) {
        const reason = authorizationError?.code === 'REAUTHORIZE_REQUIRED'
          ? 'REAUTHORIZE_REQUIRED'
          : 'IDENTITY_INCOMPLETE';
        log.warn('Passenger login rejected by device-bound credential', {
          bookingRef,
          networkDimension,
          reason,
        });
        return res.status(reason === 'REAUTHORIZE_REQUIRED' ? 403 : 200).json({ valid: false, reason });
      }

      const sessionIssuedAtMs = Date.now();
      const grantUpdates = buildVerifiedLoginGrantUpdates({
        authUid: requestAuth.uid,
        bookingRef: resolvedBookingRef,
        tourId: canonicalTourId,
        nowMs: sessionIssuedAtMs,
      });

      if (!grantUpdates) {
        log.warn('Passenger login could not build verified access grant', {
          bookingRef,
          tourId: canonicalTourId,
          authUid: requestAuth.uid,
        });
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      const userRef = database.ref(`users/${requestAuth.uid}`);
      const userSnapshot = await userRef.once('value');
      const identityUpdates = buildPassengerIdentitySecurityUpdates({
        authUid: requestAuth.uid,
        bookingRef: resolvedBookingRef,
        tourId: canonicalTourId,
        passengerPrincipalId: stablePassengerId,
        previousProfile: userSnapshot.val() || {},
        nowMs: sessionIssuedAtMs,
      });
      if (!identityUpdates) {
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      // Preserve unrelated claims while projecting only the RTDB-safe owner key needed
      // by transitional account-deletion code. Storage no longer trusts this claim.
      const authUser = await admin.auth().getUser(requestAuth.uid);
      await admin.auth().setCustomUserClaims(requestAuth.uid, {
        ...(authUser.customClaims || {}),
        privatePhotoOwnerKey: stablePassengerId,
        passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
      });

      const appSession = await issuePassengerAppSession({
        db: database,
        authUid: requestAuth.uid,
        principalId: stablePassengerId,
        tourId: canonicalTourId,
        bookingRef: resolvedBookingRef,
        identityUpdates,
        grantUpdates,
        nowMs: sessionIssuedAtMs,
      });

      return res.status(200).json({
        valid: true,
        reason: 'OK',
        bookingRef: resolvedBookingRef,
        tourId: canonicalTourId,
        tourCode: canonicalTourCode,
        stablePassengerId,
        identityVersion: PASSENGER_IDENTITY_VERSION,
        session: toClientSession(appSession),
        booking: buildPassengerSafeBooking(resolvedBookingRef, bookingSnapshot.val() || {}, canonicalTourId),
        tour: buildPassengerSafeTour(canonicalTourId, tourData),
        grantExpiresAtMs: grantUpdates[`tour_access_grants/${canonicalTourId}/${requestAuth.uid}`].expiresAtMs,
      });
    } catch (error) {
      log.error('Passenger login verification failed', error, { bookingRef });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);

exports.createManualPassengerBooking = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    const corsAllowed = applyAuthenticatedCors(req, res);
    if (req.method === 'OPTIONS') {
      return corsAllowed
        ? res.status(204).send('')
        : res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    }
    if (!corsAllowed) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }

    const db = admin.database();
    const isAdmin = await verifyOperationsAdminAccess({ authUid: requestAuth.uid, db });
    if (!isAdmin) {
      log.warn('Manual passenger creation rejected for non-admin user', {
        authUid: requestAuth.uid,
      });
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`create_manual_passenger_${requestAuth.uid}_${clientKey}`, 20, 60000)) {
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    const requestedTourId = normalizeTourKeyForComparison(req.body?.tourId);
    const requestedBookingRef = normalizeBookingRef(req.body?.bookingRef);
    const lockOwner = randomUUID();
    const lockPaths = [
      requestedBookingRef && isValidFirebaseKey(requestedBookingRef)
        ? `manual_booking_creation_locks/bookings/${requestedBookingRef}`
        : null,
      requestedTourId && isValidFirebaseKey(requestedTourId)
        ? `manual_booking_creation_locks/tours/${requestedTourId}`
        : null,
    ].filter(Boolean);
    const acquiredLocks = [];

    try {
      if (lockPaths.length !== 2) {
        throw createManualPassengerError('INVALID_INPUT', 'Tour and booking reference are required.');
      }

      for (const lockPath of lockPaths) {
        const acquired = await acquireManualBookingLock({
          db,
          path: lockPath,
          owner: lockOwner,
          nowMs: Date.now(),
        });
        if (!acquired) {
          throw createManualPassengerError(
            'CREATE_IN_PROGRESS',
            'Another passenger booking is currently being added. Try again shortly.',
          );
        }
        acquiredLocks.push(lockPath);
      }

      const [
        tourSnapshot,
        bookingSnapshot,
        identitySnapshot,
        manifestSnapshot,
        bookingsByTourSnapshot,
        pickupPointsSnapshot,
      ] = await Promise.all([
        db.ref(`tours/${requestedTourId}`).once('value'),
        db.ref(`bookings/${requestedBookingRef}`).once('value'),
        db.ref(`booking_identities/${requestedBookingRef}`).once('value'),
        db.ref(`tour_manifests/${requestedTourId}/bookings/${requestedBookingRef}`).once('value'),
        db.ref('bookings').orderByChild('tourId').equalTo(requestedTourId).once('value'),
        db.ref(`pickupPoints/${requestedTourId}`).once('value'),
      ]);

      if (!tourSnapshot.exists()) {
        throw createManualPassengerError('TOUR_NOT_FOUND', 'The selected tour no longer exists.');
      }
      if (bookingSnapshot.exists() || identitySnapshot.exists() || manifestSnapshot.exists()) {
        throw createManualPassengerError(
          'BOOKING_REFERENCE_EXISTS',
          'That booking reference is already in use.',
        );
      }

      const tourData = tourSnapshot.val() || {};
      const normalized = normalizeManualPassengerPayload(req.body, tourData);
      const existingTourBookings = bookingsByTourSnapshot.val() || {};
      const seatConflicts = findManualPassengerSeatConflicts(
        existingTourBookings,
        normalized.passengers,
      );
      if (seatConflicts.length > 0) {
        throw createManualPassengerError(
          'SEAT_ALREADY_ASSIGNED',
          `Seat ${seatConflicts.join(', ')} is already assigned on this tour.`,
        );
      }

      const writePlan = buildManualPassengerBookingUpdates({
        normalized,
        actorUid: requestAuth.uid,
        tourData,
        existingTourBookings,
        existingTopLevelPickupPoints: pickupPointsSnapshot.val() || [],
      });
      await db.ref().update(writePlan.updates);

      log.info('Manual passenger booking created', {
        authUid: requestAuth.uid,
        bookingRef: normalized.bookingRef,
        tourId: normalized.tourId,
        passengerCount: normalized.passengers.length,
      });

      return res.status(201).json({
        success: true,
        bookingRef: normalized.bookingRef,
        tourId: normalized.tourId,
        tourCode: normalized.tourCode,
        email: normalized.email,
        passengerCount: normalized.passengers.length,
      });
    } catch (error) {
      const reason = error?.code || 'INTERNAL_ERROR';
      const statusByReason = {
        INVALID_INPUT: 400,
        INVALID_TOUR: 400,
        INVALID_BOOKING_REFERENCE: 400,
        INVALID_EMAIL: 400,
        INVALID_PICKUP_DATE: 400,
        INVALID_PICKUP_TIME: 400,
        INVALID_PICKUP_LOCATION: 400,
        INVALID_PASSENGERS: 400,
        INVALID_PASSENGER_NAME: 400,
        INVALID_SEAT_NUMBER: 400,
        INVALID_PHONE: 400,
        DUPLICATE_SEAT_IN_BOOKING: 400,
        PICKUP_DATE_OUTSIDE_TOUR: 400,
        TOUR_DATES_INVALID: 409,
        TOUR_IDENTITY_MISMATCH: 409,
        TOUR_INACTIVE: 409,
        TOUR_NOT_FOUND: 404,
        BOOKING_REFERENCE_EXISTS: 409,
        SEAT_ALREADY_ASSIGNED: 409,
        TOUR_CAPACITY_EXCEEDED: 409,
        CREATE_IN_PROGRESS: 409,
      };
      const status = statusByReason[reason] || 500;
      if (status >= 500) {
        log.error('Manual passenger booking creation failed', error, {
          authUid: requestAuth.uid,
          bookingRef: requestedBookingRef,
          tourId: requestedTourId,
        });
      } else {
        log.warn('Manual passenger booking creation rejected', {
          authUid: requestAuth.uid,
          bookingRef: requestedBookingRef,
          tourId: requestedTourId,
          reason,
        });
      }
      return res.status(status).json({ success: false, reason });
    } finally {
      await Promise.all(acquiredLocks.map((path) => releaseManualBookingLock({
        db,
        path,
        owner: lockOwner,
      })));
    }
  },
);

exports.deleteTourData = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 5,
    timeoutSeconds: 300,
  },
  async (req, res) => {
    const corsAllowed = applyAuthenticatedCors(req, res);
    if (req.method === 'OPTIONS') return corsAllowed
      ? res.status(204).send('')
      : res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (!corsAllowed) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    const db = admin.database();
    if (!(await verifyOperationsAdminAccess({ authUid: requestAuth.uid, db }))) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }

    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    if (!tourId || !isValidFirebaseKey(tourId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_TOUR' });
    }

    const lockPath = `tour_deletion_locks/${tourId}`;
    const lockOwner = randomUUID();
    const lockAcquired = await acquireManualBookingLock({
      db,
      path: lockPath,
      owner: lockOwner,
      nowMs: Date.now(),
      ttlMs: TOUR_DELETION_LOCK_TTL_MS,
    });
    if (!lockAcquired) return res.status(409).json({ success: false, reason: 'DELETE_IN_PROGRESS' });

    try {
      const [tourSnapshot, driversSnapshot, driverUsersSnapshot, reportsSnapshot, safetySnapshot] = await Promise.all([
        db.ref(`tours/${tourId}`).once('value'),
        db.ref('drivers').once('value'),
        db.ref('users').orderByChild('driverAssignedTourId').equalTo(tourId).once('value'),
        db.ref('content_reports').once('value'),
        db.ref('globalSafetyAlerts').once('value'),
      ]);
      const tourExisted = tourSnapshot.exists();
      const tour = tourSnapshot.val() || {};
      const bookings = await getBookingsForTour({ db, tourId, tourCode: tour.tourCode || tourId });
      const updates = buildTourDeletionUpdates({
        tourId,
        bookings,
        drivers: driversSnapshot.val() || {},
        driverUsers: driverUsersSnapshot.val() || {},
        contentReports: reportsSnapshot.val() || {},
        globalSafetyAlerts: safetySnapshot.val() || {},
      });
      const deletedStorageObjects = await deleteStoragePrefixes({
        prefixes: [`group_tour_photos/${tourId}/`, `private_tour_photos/${tourId}/`],
      });
      await db.ref().update(updates);

      const summary = {
        bookingsDeleted: Object.keys(bookings).length,
        storageObjectsDeleted: deletedStorageObjects,
        databasePathsDeleted: Object.keys(updates).filter((path) => updates[path] === null).length,
        alreadyDeleted: !tourExisted,
      };
      log.info('Tour deletion completed', { tourId, ...summary });
      return res.status(200).json({ success: true, tourId, alreadyDeleted: !tourExisted, summary });
    } catch (error) {
      log.error('Tour deletion failed', error, { tourId });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await releaseManualBookingLock({ db, path: lockPath, owner: lockOwner });
    }
  },
);

exports.removeReportedPhoto = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
    timeoutSeconds: 120,
  },
  async (req, res) => {
    const corsAllowed = applyAuthenticatedCors(req, res);
    if (req.method === 'OPTIONS') return corsAllowed
      ? res.status(204).send('')
      : res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (!corsAllowed) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    const db = admin.database();
    if (!(await verifyOperationsAdminAccess({ authUid: requestAuth.uid, db }))) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }

    const reportId = resolveTrimmedString(req.body?.reportId);
    if (!reportId || !isValidFirebaseKey(reportId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_REPORT' });
    }

    try {
      const reportSnapshot = await db.ref(`content_reports/${reportId}`).once('value');
      if (!reportSnapshot.exists()) return res.status(404).json({ success: false, reason: 'INVALID_REPORT' });
      const report = reportSnapshot.val() || {};
      const tourId = normalizeTourKeyForComparison(report.tourId);
      const photoId = resolveTrimmedString(report.contentId);
      if (report.contentType !== 'group_photo' || !tourId || !photoId || !isValidFirebaseKey(photoId)) {
        return res.status(409).json({ success: false, reason: 'UNSUPPORTED_CONTENT' });
      }

      const contentPath = `group_tour_photos/${tourId}/${photoId}`;
      const photoSnapshot = await db.ref(contentPath).once('value');
      const photo = photoSnapshot.val() || {};
      const storagePaths = resolveReportedPhotoStoragePaths({ tourId, photo });
      const deletedStorageObjects = await deleteStoragePaths({ paths: storagePaths });
      const now = Date.now();
      await db.ref().update({
        [contentPath]: null,
        [`content_reports/${reportId}/status`]: 'actioned',
        [`content_reports/${reportId}/updatedAt`]: new Date(now).toISOString(),
        [`content_reports/${reportId}/updatedAtMs`]: now,
        [`content_reports/${reportId}/moderationAction`]: 'photo_and_storage_removed',
      });

      log.info('Reported photo removed', { reportId, tourId, deletedStorageObjects });
      return res.status(200).json({ success: true, contentPath, deletedStorageObjects });
    } catch (error) {
      log.error('Reported photo removal failed', error, { reportId });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    }
  },
);

exports.getTourManifest = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }

    const requestedTour = resolveTrimmedString(req.body?.tourId);
    const tourId = normalizeTourKeyForComparison(requestedTour);
    if (!tourId || !isValidFirebaseKey(tourId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`get_tour_manifest_${requestAuth.uid}_${tourId}_${clientKey}`, 30, 60000)) {
      log.warn('Tour manifest rate limit exceeded', {
        authUid: requestAuth.uid,
        tourId,
        networkDimension: hashRateLimitDimension(clientKey),
      });
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    try {
      const access = await verifyActiveAppSession({
        db: admin.database(),
        authUid: requestAuth.uid,
        expectedTourId: tourId,
      });
      if (!access.allowed) {
        log.warn('Tour manifest request denied', {
          authUid: requestAuth.uid,
          tourId,
          reason: access.reason,
        });
        return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
      }

      const manifest = await buildTourManifestPayload({
        tourId,
        requestedTourCode: requestedTour,
      });

      log.info('Tour manifest response built', {
        authUid: requestAuth.uid,
        tourId,
        role: access.role,
        bookingCount: manifest.bookings.length,
      });
      return res.status(200).json({ success: true, ...manifest });
    } catch (error) {
      const reason = error?.code === 'TOUR_NOT_FOUND' ? 'TOUR_NOT_FOUND' : 'INTERNAL_ERROR';
      log.error('Tour manifest request failed', error, {
        authUid: requestAuth.uid,
        tourId,
        reason,
      });
      return res.status(reason === 'TOUR_NOT_FOUND' ? 404 : 500).json({ success: false, reason });
    }
  }
);

exports.verifyDriverLogin = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
    }

    const driverId = normalizeDriverId(req.body?.driverId);
    if (!driverId || !isValidFirebaseKey(driverId)) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    const networkKey = getTrustedRequestNetworkKey(req);
    const networkDimension = hashRateLimitDimension(networkKey);
    try {
      const appCheckValid = await enforceLoginAppCheck({ req, networkDimension, loginType: 'Driver' });
      if (!appCheckValid) return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
    } catch (configurationError) {
      log.error('Driver login disabled by unsafe App Check configuration', configurationError, {
        networkDimension,
      });
      return res.status(503).json({ valid: false, reason: 'SERVICE_UNAVAILABLE' });
    }

    let rateLimit;
    try {
      rateLimit = await checkDriverLoginRateLimits({
        authUid: requestAuth.uid,
        clientKey: networkKey,
        driverId,
        limiter: distributedLoginRateLimiter,
      });
    } catch (rateLimitError) {
      log.error('Driver login disabled because distributed rate limiting failed', rateLimitError, {
        networkDimension,
      });
      return res.status(503).json({ valid: false, reason: 'SERVICE_UNAVAILABLE' });
    }
    if (!rateLimit.allowed) {
      log.warn('Driver login rate limit exceeded', {
        scope: rateLimit.scope,
        authDimension: rateLimit.authDimension,
        driverId,
        networkDimension: rateLimit.networkDimension,
      });
      return res.status(429).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
    }

    try {
      const db = admin.database();
      const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
      if (!driverSnapshot.exists()) {
        log.warn('Driver login rejected: driver not found', { driverId, authUid: requestAuth.uid });
        return res.status(200).json({ valid: false, reason: 'DRIVER_NOT_FOUND' });
      }

      const driverData = driverSnapshot.val() || {};
      const claimedAuthUid = resolveTrimmedString(driverData.authUid);
      if (claimedAuthUid && claimedAuthUid !== requestAuth.uid) {
        log.warn('Driver login rejected: driver code already linked to another auth uid', {
          driverId,
          authUid: requestAuth.uid,
        });
        return res.status(403).json({ valid: false, reason: 'DRIVER_ALREADY_LINKED' });
      }

      const claimResult = await claimDriverAuthUid({
        db,
        driverId,
        authUid: requestAuth.uid,
      });
      if (!claimResult.claimed) {
        log.warn('Driver login rejected: driver claim lost to another auth uid', {
          driverId,
          authUid: requestAuth.uid,
        });
        return res.status(403).json({ valid: false, reason: 'DRIVER_ALREADY_LINKED' });
      }

      const assignment = await resolveDriverAssignment({ driverId, driverData, db });
      let assignedTourCode = assignment.assignedTourCode;
      let resolvedTour = null;

      if (assignment.assignedTourId) {
        const tourSnapshot = await db.ref(`tours/${assignment.assignedTourId}`).once('value');
        if (tourSnapshot.exists()) {
          const tourData = tourSnapshot.val() || {};
          resolvedTour = {
            id: assignment.assignedTourId,
            ...tourData,
          };
        }
      }

      const nowMs = Date.now();
      const driverProfileUpdates = buildDriverIdentityProfileUpdates({
        driverId,
        authUid: requestAuth.uid,
        assignedTourId: assignment.assignedTourId,
        nowMs,
      });
      const appSession = await issueDriverAppSession({
        db,
        authUid: requestAuth.uid,
        driverId,
        tourId: assignment.assignedTourId,
        profileUpdates: driverProfileUpdates,
        nowMs,
      });

      log.info('Driver login reference validated', {
        driverId,
        authUid: requestAuth.uid,
        assignedTourId: assignment.assignedTourId,
        assignmentSource: assignment.assignmentSource,
        hasResolvedTour: Boolean(resolvedTour),
      });

      return res.status(200).json({
        valid: true,
        type: 'driver',
        driver: {
          id: driverId,
          name: driverData.name || null,
          assignedTourId: assignment.assignedTourId,
          assignedTourCode,
          hasAssignedTour: Boolean(assignment.assignedTourId),
        },
        tour: resolvedTour,
        assignmentStatus: assignment.assignedTourId
          ? (resolvedTour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND')
          : 'UNASSIGNED',
        identityClaimed: true,
        session: toClientSession(appSession),
      });
    } catch (error) {
      log.error('Driver login verification failed', error, {
        driverId,
        authUid: requestAuth.uid,
      });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);

exports.assignDriverToTour = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }

    const driverId = normalizeDriverId(req.body?.driverId);
    const requestedTour = resolveTrimmedString(req.body?.tourCode || req.body?.tourId);
    const tourId = normalizeTourKeyForComparison(requestedTour);
    const expectedSessionId = resolveTrimmedString(req.body?.expectedSessionId);
    if (!driverId || !isValidFirebaseKey(driverId) || !tourId || !isValidFirebaseKey(tourId)
      || !isValidAppSessionId(expectedSessionId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`assign_driver_${requestAuth.uid}_${hashRateLimitDimension(clientKey)}`, 12, 60000)) {
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    const db = admin.database();
    const lockOwner = randomUUID();
    let appSessionLock = null;
    const lockPaths = [
      `driver_assignment_locks/drivers/${driverId}`,
      `driver_assignment_locks/tours/${tourId}`,
    ].sort();
    const acquiredLocks = [];

    try {
      appSessionLock = await acquireAppSessionLock({
        db,
        authUid: requestAuth.uid,
        operation: 'assign',
      });
      if (!appSessionLock.acquired) {
        return res.status(409).json({ success: false, reason: 'SESSION_IN_PROGRESS' });
      }
      const activeAccess = await verifyActiveAppSession({
        db,
        authUid: requestAuth.uid,
        expectedRole: 'driver',
        expectedSessionId,
        allowUnassignedDriver: true,
      });
      if (!activeAccess.allowed || activeAccess.session.driverId !== driverId) {
        const status = activeAccess.reason === 'SESSION_CHANGED' ? 409 : 403;
        return res.status(status).json({ success: false, reason: activeAccess.reason || 'NOT_AUTHORIZED' });
      }

      for (const lockPath of lockPaths) {
        const acquired = await acquireManualBookingLock({
          db,
          path: lockPath,
          owner: lockOwner,
          nowMs: Date.now(),
          ttlMs: DRIVER_ASSIGNMENT_LOCK_TTL_MS,
        });
        if (!acquired) {
          return res.status(409).json({ success: false, reason: 'ASSIGNMENT_IN_PROGRESS' });
        }
        acquiredLocks.push(lockPath);
      }

      const [driverSnapshot, tourSnapshot, manifestSnapshot] = await Promise.all([
        db.ref(`drivers/${driverId}`).once('value'),
        db.ref(`tours/${tourId}`).once('value'),
        db.ref(`tour_manifests/${tourId}`).once('value'),
      ]);

      if (!driverSnapshot.exists()) {
        return res.status(404).json({ success: false, reason: 'DRIVER_NOT_FOUND' });
      }
      const driverData = driverSnapshot.val() || {};
      if (resolveTrimmedString(driverData.authUid) !== requestAuth.uid) {
        return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
      }

      if (!tourSnapshot.exists()) {
        return res.status(404).json({ success: false, reason: 'TOUR_NOT_FOUND' });
      }
      const tourData = tourSnapshot.val() || {};
      if (tourData.isActive === false) {
        return res.status(409).json({ success: false, reason: 'TOUR_INACTIVE' });
      }

      const conflicts = collectDriverAssignmentConflicts({
        driverId,
        tourData,
        manifestData: manifestSnapshot.val() || {},
      });
      if (conflicts.length > 0) {
        log.warn('Driver self-assignment rejected because tour already has another driver', {
          driverId,
          authUid: requestAuth.uid,
          tourId,
          conflictCount: conflicts.length,
        });
        return res.status(409).json({ success: false, reason: 'TOUR_ALREADY_ASSIGNED' });
      }

      const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
      const previousTourSnapshot = previousTourId && previousTourId !== tourId
        ? await db.ref(`tours/${previousTourId}`).once('value')
        : null;
      const assignment = buildDriverSelfAssignmentUpdates({
        driverId,
        authUid: requestAuth.uid,
        driverData,
        tourId,
        tourData,
        previousTourData: previousTourSnapshot?.val?.() || {},
      });
      const nowMs = Date.now();
      const updatedSession = {
        ...activeAccess.session,
        tourId,
        lastAuthenticatedAtMs: nowMs,
        expiresAtMs: calculateSessionExpiry({ principalType: 'driver', tourId, nowMs }),
        sessionRevision: activeAccess.session.sessionRevision + 1,
      };
      assignment.updates[`app_sessions/${requestAuth.uid}`] = updatedSession;
      assignment.updates[`app_session_events/${db.ref('app_session_events').push().key}`] = buildSafeAppSessionEvent({
        session: updatedSession,
        eventType: 'assignment_changed',
        reason: 'driver_self_assignment',
        actorType: 'driver',
        nowMs,
      });
      await db.ref().update(assignment.updates);
      if (assignment.previousTourId && assignment.previousTourId !== tourId) {
        await cleanupDriverLocationForSession({
          db,
          session: { ...activeAccess.session, tourId: assignment.previousTourId },
        });
      }
      log.info('Driver self-assignment completed', {
        driverId,
        authUid: requestAuth.uid,
        tourId,
        previousTourId: assignment.previousTourId,
        updatePathCount: Object.keys(assignment.updates).length,
      });
      return res.status(200).json({
        success: true,
        tourId,
        tourCode: assignment.canonicalTourCode,
        previousTourId: assignment.previousTourId,
        session: toClientSession(updatedSession),
      });
    } catch (error) {
      log.error('Driver self-assignment failed', error, {
        driverId,
        authUid: requestAuth.uid,
        tourId,
      });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await Promise.all(acquiredLocks.map((path) => releaseManualBookingLock({
        db,
        path,
        owner: lockOwner,
      })));
      if (appSessionLock?.acquired) {
        await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: appSessionLock.owner });
      }
    }
  }
);

const authorizeAppSessionMobileRequest = async ({ req, res }) => {
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    return null;
  }
  let appCheckValid = false;
  try {
    appCheckValid = await enforceGroupMediaAppCheck(req);
  } catch (error) {
    log.error('App session App Check configuration failure', error);
    res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    return null;
  }
  if (!appCheckValid) {
    res.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
    return null;
  }
  return requestAuth;
};

exports.endAppSession = onRequest(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const expectedSessionId = resolveTrimmedString(req.body?.expectedSessionId);
    if (!isValidAppSessionId(expectedSessionId) || req.body?.reason !== 'user_logout') {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    try {
      const allowed = await distributedLoginRateLimiter(
        `session_end_${hashRateLimitDimension(requestAuth.uid)}`,
        20,
        60 * 1000,
      );
      if (!allowed) return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    } catch (error) {
      log.error('App session end rate limit failed closed', error);
      return res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    }

    const db = admin.database();
    const lock = await acquireAppSessionLock({ db, authUid: requestAuth.uid, operation: 'end' });
    if (!lock.acquired) return res.status(409).json({ success: false, reason: 'SESSION_IN_PROGRESS' });
    try {
      const snapshot = await db.ref(`app_sessions/${requestAuth.uid}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          reason: 'ENDED',
          endedSessionId: expectedSessionId,
          alreadyEnded: true,
          endedAtMs: Date.now(),
        });
      }
      const session = snapshot.val();
      if (session.sessionId !== expectedSessionId) {
        return res.status(409).json({ success: false, reason: 'SESSION_CHANGED' });
      }
      const endedAtMs = Date.now();
      await cleanupAppSession({
        db,
        session,
        expectedSessionId,
        eventType: 'ended_by_user',
        reason: 'user_logout',
        actorType: session.principalType,
        nowMs: endedAtMs,
        createEventId: () => db.ref('app_session_events').push().key,
      });
      log.info('App session ended by user', {
        authUid: requestAuth.uid,
        principalType: session.principalType,
        tourId: session.tourId,
      });
      return res.status(200).json({
        success: true,
        reason: 'ENDED',
        endedSessionId: expectedSessionId,
        alreadyEnded: false,
        endedAtMs,
      });
    } catch (error) {
      log.error('App session end failed', error, { authUid: requestAuth.uid });
      return res.status(error?.code === 'SESSION_CHANGED' ? 409 : 500).json({
        success: false,
        reason: error?.code === 'SESSION_CHANGED' ? 'SESSION_CHANGED' : 'INTERNAL_ERROR',
      });
    } finally {
      await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: lock.owner });
    }
  },
);

const APP_SESSION_REVOCATION_REASONS = new Set([
  'lost_device',
  'security_review',
  'staff_request',
  'account_support',
]);

exports.revokeAppSession = onRequest(
  { region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: false },
  async (req, res) => {
    if (!applyAuthenticatedCors(req, res)) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) return res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    const db = admin.database();
    if (!(await verifyOperationsAdminAccess({ authUid: requestAuth.uid, db }))) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }
    const targetAuthUid = resolveTrimmedString(req.body?.authUid);
    const expectedSessionId = resolveTrimmedString(req.body?.expectedSessionId);
    const reason = resolveTrimmedString(req.body?.reason);
    if (!isValidFirebaseKey(targetAuthUid) || !APP_SESSION_REVOCATION_REASONS.has(reason)
      || (expectedSessionId && !isValidAppSessionId(expectedSessionId))) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const lock = await acquireAppSessionLock({ db, authUid: targetAuthUid, operation: 'revoke' });
    if (!lock.acquired) return res.status(409).json({ success: false, reason: 'SESSION_IN_PROGRESS' });
    try {
      const snapshot = await db.ref(`app_sessions/${targetAuthUid}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({ success: true, reason: 'ENDED', alreadyEnded: true });
      }
      const session = snapshot.val();
      if (expectedSessionId && session.sessionId !== expectedSessionId) {
        return res.status(409).json({ success: false, reason: 'SESSION_CHANGED' });
      }
      const endedAtMs = Date.now();
      await cleanupAppSession({
        db,
        session,
        expectedSessionId: session.sessionId,
        eventType: 'ended_by_admin',
        reason,
        actorType: 'operations_admin',
        nowMs: endedAtMs,
        createEventId: () => db.ref('app_session_events').push().key,
      });
      log.info('App session revoked by operations', {
        authUid: targetAuthUid,
        adminUid: requestAuth.uid,
        principalType: session.principalType,
        reason,
      });
      return res.status(200).json({ success: true, reason: 'ENDED', alreadyEnded: false, endedAtMs });
    } catch (error) {
      log.error('Admin app session revocation failed', error, { authUid: targetAuthUid, reason });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await releaseAppSessionLock({ db, authUid: targetAuthUid, owner: lock.owner });
    }
  },
);

exports.submitSafetyReport = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 20,
    timeoutSeconds: 30,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }
    try {
      const allowed = await checkSafetySubmissionRateLimit({ authUid: requestAuth.uid });
      if (!allowed) {
        return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
      }
    } catch (error) {
      log.error('Safety rate-limit check failed closed', error, { authUid: requestAuth.uid });
      return res.status(503).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    let input;
    try {
      input = normalizeSafetySubmissionInput(req.body, Date.now());
    } catch (error) {
      return res.status(400).json({ success: false, reason: error?.code || 'INVALID_INPUT' });
    }

    const db = admin.database();
    const lockPath = `safety_submission_locks/${input.tourId}/${input.clientEventId}`;
    const lockOwner = randomUUID();
    let lockAcquired = false;
    try {
      const access = await verifyActiveAppSession({
        db,
        authUid: requestAuth.uid,
        expectedTourId: input.tourId,
        expectedRole: input.role,
      });
      if (!access.allowed) {
        return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
      }

      const existingSnapshot = await db.ref(`tours/${input.tourId}/safetyAlerts/${input.clientEventId}`).once('value');
      if (existingSnapshot.exists()) {
        const existing = existingSnapshot.val() || {};
        if (resolveTrimmedString(existing.reporterAuthUid || existing.userId) !== requestAuth.uid) {
          return res.status(409).json({ success: false, reason: 'EVENT_ID_CONFLICT' });
        }
        return res.status(200).json({
          success: true,
          eventId: input.clientEventId,
          alreadySubmitted: true,
          receivedAtMs: Number(existing.receivedAtMs || existing.timestampMs) || null,
        });
      }

      lockAcquired = await acquireManualBookingLock({
        db,
        path: lockPath,
        owner: lockOwner,
        nowMs: Date.now(),
        ttlMs: SAFETY_SUBMISSION_LOCK_TTL_MS,
      });
      if (!lockAcquired) {
        const retrySnapshot = await db.ref(`tours/${input.tourId}/safetyAlerts/${input.clientEventId}`).once('value');
        if (retrySnapshot.exists() && resolveTrimmedString(retrySnapshot.val()?.reporterAuthUid || retrySnapshot.val()?.userId) === requestAuth.uid) {
          return res.status(200).json({ success: true, eventId: input.clientEventId, alreadySubmitted: true });
        }
        return res.status(409).json({ success: false, reason: 'SUBMISSION_IN_PROGRESS' });
      }

      const lockedExistingSnapshot = await db.ref(`tours/${input.tourId}/safetyAlerts/${input.clientEventId}`).once('value');
      if (lockedExistingSnapshot.exists()) {
        const lockedExisting = lockedExistingSnapshot.val() || {};
        if (resolveTrimmedString(lockedExisting.reporterAuthUid || lockedExisting.userId) !== requestAuth.uid) {
          return res.status(409).json({ success: false, reason: 'EVENT_ID_CONFLICT' });
        }
        return res.status(200).json({ success: true, eventId: input.clientEventId, alreadySubmitted: true });
      }

      const nowMs = Date.now();
      const record = buildCanonicalSafetyRecord({
        input,
        authUid: requestAuth.uid,
        principalId: access.principalId,
        nowMs,
      });
      await db.ref().update(buildSafetySubmissionUpdates({ record, lockPath }));
      lockAcquired = false;
      log.warn('Safety report submitted', {
        authUid: requestAuth.uid,
        tourId: input.tourId,
        eventId: input.clientEventId,
        category: input.category,
        severity: input.severity,
        isSOS: input.isSOS,
        processedFromQueue: input.processedFromQueue,
      });
      return res.status(201).json({
        success: true,
        eventId: input.clientEventId,
        alreadySubmitted: false,
        receivedAtMs: nowMs,
      });
    } catch (error) {
      log.error('Safety report submission failed', error, {
        authUid: requestAuth.uid,
        tourId: input.tourId,
        eventId: input.clientEventId,
      });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      if (lockAcquired) {
        await releaseManualBookingLock({ db, path: lockPath, owner: lockOwner });
      }
    }
  },
);

const validateBroadcastData = (broadcastData) => {
  const errors = [];

  if (!broadcastData || typeof broadcastData !== 'object') {
    errors.push('Broadcast data is null or invalid');
    return { valid: false, errors };
  }

  if (!broadcastData.message || typeof broadcastData.message !== 'string') {
    errors.push('Missing broadcast message');
  } else if (broadcastData.message.trim().length === 0 || broadcastData.message.length > 2000) {
    errors.push('Broadcast message must be 1-2000 characters');
  }

  if (typeof broadcastData.createdAtMs !== 'number' || !Number.isFinite(broadcastData.createdAtMs)) {
    errors.push('Missing or invalid createdAtMs');
  }

  if (!broadcastData.createdByUid || typeof broadcastData.createdByUid !== 'string') {
    errors.push('Missing createdByUid');
  }

  if (broadcastData.source && typeof broadcastData.source !== 'string') {
    errors.push('Invalid source');
  }

  return { valid: errors.length === 0, errors };
};

const validateCategoryBroadcastData = (categoryKey, broadcastData) => {
  const validation = validateBroadcastData(broadcastData);
  const errors = [...validation.errors];

  if (!isSupportedTourNotificationCategory(categoryKey)) {
    errors.push('Unsupported tour notification category');
  }

  if (broadcastData?.categoryKey && broadcastData.categoryKey !== categoryKey) {
    errors.push('categoryKey must match the broadcast path');
  }

  if (broadcastData?.categoryLabel && (
    typeof broadcastData.categoryLabel !== 'string'
    || broadcastData.categoryLabel.trim().length === 0
    || broadcastData.categoryLabel.length > 120
  )) {
    errors.push('Invalid categoryLabel');
  }

  return { valid: errors.length === 0, errors };
};

const BROADCAST_TERMINAL_STATUSES = new Set(['delivered', 'partial', 'failed', 'no_recipients']);

const resolveBroadcastDeliveryStatus = ({ successCount = 0, errorCount = 0, recipientCount = 0 } = {}) => {
  if (recipientCount <= 0) return 'no_recipients';
  if (successCount > 0 && errorCount > 0) return 'partial';
  if (successCount > 0) return 'delivered';
  return 'failed';
};

const updateBroadcastDelivery = async ({ root, targetId, broadcastId, status, details = {} }) => {
  if (!isValidFirebaseKey(targetId) || !isValidFirebaseKey(broadcastId)) return;
  const now = Date.now();
  const payload = {
    deliveryStatus: status,
    deliveryUpdatedAtMs: now,
    ...details,
  };
  if (BROADCAST_TERMINAL_STATUSES.has(status)) payload.deliveryCompletedAtMs = now;
  await admin.database().ref(`${root}/${targetId}/${broadcastId}`).update(payload);
};

const fetchCategoryBroadcastUsers = async (categoryKey, context = {}) => {
  const usersMap = {};
  const preferenceKeys = [
    categoryKey,
    ...(LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS[categoryKey] || []),
  ];

  for (const preferenceKey of preferenceKeys) {
    const snapshot = await admin.database()
      .ref('users')
      .orderByChild(`preferences/marketing/${preferenceKey}`)
      .equalTo(true)
      .limitToFirst(NOTIFICATION_RECIPIENT_CAP + 1)
      .once('value');

    const users = snapshot.val() || {};
    Object.entries(users).forEach(([userId, userData]) => {
      usersMap[userId] = userData;
      setCachedUserProfile(userId, userData);
    });

    if (Object.keys(users).length > NOTIFICATION_RECIPIENT_CAP) {
      log.warn('Category broadcast preference query exceeded recipient cap', {
        ...context,
        preferenceKey,
        cap: NOTIFICATION_RECIPIENT_CAP,
      });
    }
  }

  log.info('Fetched category broadcast users', {
    ...context,
    preferenceQueryCount: preferenceKeys.length,
    resolvedUserCount: Object.keys(usersMap).length,
  });

  return usersMap;
};

/**
 * Trigger: When a new admin broadcast is written to /broadcasts/{tourId}/{broadcastId}
 * Writes a normalized system chat message so existing chat notification flow can fan out push notifications.
 */
exports.processBroadcastWrite = onValueCreated(
  {
    ref: '/broadcasts/{tourId}/{broadcastId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const { tourId, broadcastId } = event.params;

    try {
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(broadcastId)) {
        log.warn('Invalid broadcast path parameters', { tourId, broadcastId });
        return null;
      }

      const broadcastData = event.data?.val();
      const validation = validateBroadcastData(broadcastData);
      if (!validation.valid) {
        log.warn('Invalid broadcast payload; skipping fanout', { tourId, broadcastId, errors: validation.errors });
        await updateBroadcastDelivery({
          root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_PAYLOAD' },
        });
        return null;
      }

      await updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId, status: 'processing' });

      const adminRecord = await admin.auth().getUser(broadcastData.createdByUid);
      const isAnonymous = adminRecord.providerData.length === 0;
      if (adminRecord.disabled || isAnonymous) {
        log.warn('Broadcast author is not eligible for admin broadcast fanout', {
          tourId,
          broadcastId,
          createdByUid: broadcastData.createdByUid,
        });
        await updateBroadcastDelivery({
          root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_AUTHOR' },
        });
        return null;
      }

      await admin.database().ref(`chats/${tourId}/messages/${broadcastId}`).set({
        text: `ANNOUNCEMENT: ${broadcastData.message.trim()}`,
        senderName: 'Loch Lomond Travel HQ',
        senderId: 'admin_hq_broadcast',
        senderUid: broadcastData.createdByUid,
        timestamp: broadcastData.createdAtMs,
        messageType: 'ADMIN_BROADCAST',
        source: broadcastData.source || 'web_admin',
        isDriver: true,
        broadcastId,
      });

      await persistTourNotification({
        record: buildTourNotificationRecord({
          type: 'announcement',
          tourId,
          sourceId: broadcastId,
          title: 'Loch Lomond Travel update',
          body: broadcastData.message,
          screen: 'Chat',
          messageId: broadcastId,
          createdAtMs: broadcastData.createdAtMs,
          priority: 'high',
        }),
      });

      await updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId, status: 'chat_queued' });
      log.info('Broadcast fanout to chat completed', { tourId, broadcastId });
      return null;
    } catch (error) {
      log.error('Failed to process broadcast write', error, { tourId, broadcastId });
      await updateBroadcastDelivery({
        root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'FANOUT_FAILED' },
      }).catch((statusError) => log.error('Failed to persist broadcast failure status', statusError, { tourId, broadcastId }));
      return null;
    }
  }
);

/**
 * Trigger: When a new admin category broadcast is written to
 * /category_broadcasts/{categoryKey}/{broadcastId}
 * Sends a direct push to clients who opted in to that future-tour category.
 */
exports.processCategoryBroadcastWrite = onValueCreated(
  {
    ref: '/category_broadcasts/{categoryKey}/{broadcastId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const { categoryKey, broadcastId } = event.params;

    try {
      if (!isValidFirebaseKey(categoryKey) || !isValidFirebaseKey(broadcastId)) {
        log.warn('Invalid category broadcast path parameters', { categoryKey, broadcastId });
        return null;
      }

      const broadcastData = event.data?.val();
      const validation = validateCategoryBroadcastData(categoryKey, broadcastData);
      if (!validation.valid) {
        log.warn('Invalid category broadcast payload; skipping fanout', {
          categoryKey,
          broadcastId,
          errors: validation.errors,
        });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_PAYLOAD' },
        });
        return null;
      }

      await updateBroadcastDelivery({ root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'processing' });

      const adminRecord = await admin.auth().getUser(broadcastData.createdByUid);
      const isAnonymous = adminRecord.providerData.length === 0;
      if (adminRecord.disabled || isAnonymous) {
        log.warn('Category broadcast author is not eligible for fanout', {
          categoryKey,
          broadcastId,
          createdByUid: broadcastData.createdByUid,
        });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_AUTHOR' },
        });
        return null;
      }

      const categoryLabel = resolveTourNotificationCategoryLabel(categoryKey);
      const usersMap = await fetchCategoryBroadcastUsers(categoryKey, {
        categoryKey,
        notificationType: 'category_broadcast',
      });
      const candidateUserIds = applyRecipientCap(Object.keys(usersMap), NOTIFICATION_RECIPIENT_CAP, {
        categoryKey,
        notificationType: 'category_broadcast',
      });

      if (candidateUserIds.length === 0) {
        log.info('No users opted in to category broadcast', { categoryKey, broadcastId });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'no_recipients', details: { recipientCount: 0, successCount: 0, errorCount: 0 },
        });
        return null;
      }

      const assemblyStart = Date.now();
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: candidateUserIds,
        usersMap,
        preferencePath: ['preferences', 'marketing', categoryKey],
        preferenceResolver: (userData) => userWantsTourCategoryBroadcast(userData, categoryKey),
        senderId: null,
        excludeSender: false,
        context: { categoryKey, broadcastId, notificationType: 'category_broadcast' },
      });

      const pushMessages = buildCategoryBroadcastPushMessages({
        validRecipients,
        categoryKey,
        categoryLabel,
        broadcastId,
        message: broadcastData.message,
        timestamp: broadcastData.createdAtMs,
      });

      log.info('Using deterministic recipient chunking for category broadcast notifications', {
        categoryKey,
        broadcastId,
        chunks: Math.ceil(pushMessages.length / RECIPIENT_CHUNK_SIZE),
        chunkSize: RECIPIENT_CHUNK_SIZE,
      });
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      if (pushMessages.length === 0) {
        log.info('No valid recipients for category broadcast', { categoryKey, broadcastId });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'no_recipients', details: { recipientCount: 0, successCount: 0, errorCount: 0 },
        });
        return null;
      }

      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error('Category broadcast notification ticket error', {
                error: ticket.message,
                details: ticket.details,
              }, { categoryKey, broadcastId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error('Error sending category broadcast chunk', chunkError, {
            categoryKey,
            broadcastId,
            chunkSize: chunk.length,
          });
        }
      }

      const pushSendDurationMs = Date.now() - pushSendStart;
      const duration = Date.now() - startTime;
      await updateBroadcastDelivery({
        root: 'category_broadcasts',
        targetId: categoryKey,
        broadcastId,
        status: resolveBroadcastDeliveryStatus({ successCount, errorCount, recipientCount: pushMessages.length }),
        details: { recipientCount: pushMessages.length, successCount, errorCount },
      });
      log.info('Category broadcast notification completed', {
        categoryKey,
        broadcastId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`,
      });

      return null;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Fatal error in processCategoryBroadcastWrite', error, {
        categoryKey,
        broadcastId,
        duration: `${duration}ms`,
      });
      await updateBroadcastDelivery({
        root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'FANOUT_FAILED' },
      }).catch((statusError) => log.error('Failed to persist category broadcast failure status', statusError, { categoryKey, broadcastId }));
      return null;
    }
  }
);

/**
 * Trigger: When a new message is added to /chats/{tourId}/messages/{messageId}
 * Enhanced with validation, security checks, and better error handling
 */
exports.sendChatNotification = onValueCreated(
  {
    ref: "/chats/{tourId}/messages/{messageId}",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;
    const messageId = event.params.messageId;
    const initialMessageData = event.data?.val?.() || {};
    const trackedBroadcastId = resolveTrimmedString(initialMessageData.broadcastId);
    const updateTrackedBroadcast = (status, details = {}) => (
      trackedBroadcastId
        ? updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId: trackedBroadcastId, status, details })
        : Promise.resolve()
    );

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) {
        log.error("Invalid path parameters", null, { tourId, messageId });
        return null;
      }

      // 1. Validate event data
      const snapshot = event.data;
      if (!snapshot) {
        log.warn("No data associated with event", { tourId, messageId });
        return null;
      }

      const messageData = initialMessageData;

      // 2. Validate message data
      const validation = validateMessageData(messageData);
      if (!validation.valid) {
        log.error("Invalid message data", { errors: validation.errors }, { tourId, messageId });
        await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_CHAT_MESSAGE' });
        return null;
      }

      const { senderId, senderName } = messageData;

      // 3. Rate limiting check (prevent spam)
      const rateLimitKey = `chat_notify_${tourId}_${senderId}`;
      if (!checkRateLimit(rateLimitKey, 20, 60000)) {
        log.warn("Rate limit exceeded", { tourId, senderId });
        if (isAdminBroadcast(senderId)) await updateTrackedBroadcast('failed', { deliveryErrorCode: 'RATE_LIMITED' });
        return null;
      }

      // 4. Security: Verify admin broadcast authenticity up-front.
      let isAdmin = isAdminBroadcast(senderId);
      if (isAdmin) {
        // Verify the admin broadcast is legitimate (not spoofed by a regular user)
        const isVerifiedAdmin = await verifyAdminBroadcast(messageData);
        if (!isVerifiedAdmin) {
          log.error("Spoofed admin broadcast rejected - invalid or missing senderUid", null, { tourId, senderId });
          await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_AUTHOR' });
          return null;
        }
      }

      log.info("Processing chat notification", { tourId, senderId, senderName, isAdmin });

      // 5. Get only the fields needed for notifications.
      const [tourNameSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tour_manifests/${tourId}`).once("value"),
      ]);

      const tourName = tourNameSnapshot.val() || "Tour Chat";
      const participants = participantsSnapshot.val() || {};
      const manifestData = manifestSnapshot.val() || {};
      const participantIds = Object.keys(participants);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData,
        context: { tourId, messageId, notificationType: 'chat' },
      });
      let senderDeliveryIds = [];

      // Security: regular chat messages must be sent by a participant.
      if (!isAdmin) {
        senderDeliveryIds = await resolveChatSenderDeliveryIds({
          tourId,
          participants,
          manifestData,
          messageData,
          context: { tourId, messageId, notificationType: 'chat' },
        });
      }

      if (!isAdmin) {
        senderDeliveryIds = await filterOperationalRecipientsByActiveSession({
          recipientIds: senderDeliveryIds,
          tourId,
          participants,
        });
      }
      if (!isAdmin && senderDeliveryIds.length === 0) {
        log.error("Sender is not an active participant or assigned driver of the tour", null, {
          tourId,
          senderId,
          senderStableId: toRealtimeKeySegment(messageData.senderStableId),
        });
        return null;
      }

      const audienceIds = [...new Set([...participantIds, ...assignedDriverRecipientIds])];
      const activeAudienceIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: audienceIds,
        tourId,
        participants,
      });
      const cappedParticipantIds = applyRecipientCap(activeAudienceIds, NOTIFICATION_RECIPIENT_CAP, {
        tourId,
        notificationType: 'chat',
      });

      const fetchUsersStart = Date.now();
      const usersMap = await fetchUsersSnapshot(cappedParticipantIds, { tourId, notificationType: 'chat' });
      const userFetchDurationMs = Date.now() - fetchUsersStart;

      const assemblyStart = Date.now();
      const prefKey = isAdmin ? 'driver_updates' : 'group_chat';
      const preferencePath = ['preferences', 'ops', prefKey];
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedParticipantIds,
        usersMap,
        preferencePath,
        senderId,
        senderParticipantIds: senderDeliveryIds,
        excludeSender: true,
        context: { tourId, notificationType: 'chat' },
      });

      const notificationContent = buildChatNotificationContent({
        messageData,
        tourName,
        isAdmin,
      });
      const pushMessages = [];

      const recipientChunks = chunkArrayDeterministically(
        validRecipients.map((recipient) => recipient.userId),
        RECIPIENT_CHUNK_SIZE,
      );
      log.info('Using deterministic recipient chunking for chat notifications', {
        tourId,
        chunks: recipientChunks.length,
        chunkSize: RECIPIENT_CHUNK_SIZE,
      });

      for (const recipientChunk of recipientChunks) {
        for (const userId of recipientChunk) {
          const userData = usersMap[userId];
          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: notificationContent.title,
            body: notificationContent.body,
            data: buildPushNavigationData({
              tourId,
              screen: "Chat",
              messageId,
              noticeId: isAdmin && trackedBroadcastId
                ? buildTourNotificationId({ type: 'announcement', tourId, sourceId: trackedBroadcastId })
                : null,
              notificationType: isAdmin ? 'announcement' : 'chat_message',
            }),
            priority: isAdmin ? "high" : "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 7. Complete invalid-token cleanup before the serverless invocation exits.
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      // 8. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients found", { tourId });
        if (isAdmin) await updateTrackedBroadcast('no_recipients', { recipientCount: 0, successCount: 0, errorCount: 0 });
        return null;
      }

      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }
      const pushSendDurationMs = Date.now() - pushSendStart;

      const duration = Date.now() - startTime;
      if (isAdmin) {
        await updateTrackedBroadcast(
          resolveBroadcastDeliveryStatus({ successCount, errorCount, recipientCount: pushMessages.length }),
          { recipientCount: pushMessages.length, successCount, errorCount },
        );
      }
      log.info("Chat notification completed", {
        tourId,
        recipients: pushMessages.length,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        isAdminBroadcast: isAdmin,
        userFetchDurationMs,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendChatNotification", error, { tourId, messageId, duration: `${duration}ms` });
      await updateTrackedBroadcast('failed', { deliveryErrorCode: 'NOTIFICATION_FAILED' })
        .catch((statusError) => log.error('Failed to persist tour broadcast failure status', statusError, { tourId, messageId }));
      return null;
    }
  }
);

/** Notify the other assigned drivers when an internal driver-chat message is created. */
exports.sendInternalChatNotification = onValueCreated(
  {
    ref: "/internal_chats/{tourId}/messages/{messageId}",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const tourId = event.params.tourId;
    const messageId = event.params.messageId;
    const messageData = event.data?.val?.() || {};

    try {
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) return null;
      const validation = validateMessageData(messageData);
      if (!validation.valid || messageData.isDriver !== true) {
        log.warn('Invalid internal chat message skipped', { tourId, messageId, errors: validation.errors });
        return null;
      }
      if (!checkRateLimit(`internal_chat_notify_${tourId}_${messageData.senderId}`, 20, 60000)) {
        log.warn('Internal chat notification rate limit exceeded', { tourId });
        return null;
      }

      const [tourNameSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once('value'),
        admin.database().ref(`tour_manifests/${tourId}`).once('value'),
      ]);
      const manifestData = manifestSnapshot.val() || {};
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData,
        context: { tourId, messageId, notificationType: 'internal_chat' },
      });
      const senderDeliveryIds = await resolveChatSenderDeliveryIds({
        tourId,
        manifestData,
        messageData,
        context: { tourId, messageId, notificationType: 'internal_chat' },
      });
      if (senderDeliveryIds.length === 0) {
        log.warn('Internal chat sender is not an active assigned driver', { tourId, messageId });
        return null;
      }

      const activeDriverRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: assignedDriverRecipientIds,
        tourId,
      });
      const activeSenderDeliveryIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: senderDeliveryIds,
        tourId,
      });
      if (activeSenderDeliveryIds.length === 0) {
        log.warn('Internal chat sender has no active app session', { tourId, messageId });
        return null;
      }
      const cappedRecipientIds = applyRecipientCap(
        activeDriverRecipientIds,
        NOTIFICATION_RECIPIENT_CAP,
        { tourId, notificationType: 'internal_chat' },
      );
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, { tourId, notificationType: 'internal_chat' });
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'group_chat'],
        senderId: messageData.senderId,
        senderParticipantIds: activeSenderDeliveryIds,
        excludeSender: true,
        context: { tourId, notificationType: 'internal_chat' },
      });
      if (invalidTokens.length > 0) await cleanupInvalidTokens(invalidTokens);

      const tourName = tourNameSnapshot.val() || 'Tour Chat';
      const content = buildChatNotificationContent({ messageData, tourName });
      const pushMessages = validRecipients.map(({ userId }) => ({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: `Driver team · ${tourName}`,
        body: content.body,
        data: buildPushNavigationData({
          tourId,
          screen: 'Chat',
          messageId,
          notificationType: 'internal_chat_message',
          internalDriverChat: true,
        }),
        priority: 'default',
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          const deviceFailures = collectExpoTokenFailures(tickets, chunk);
          successCount += tickets.filter((ticket) => ticket.status !== 'error').length;
          errorCount += tickets.filter((ticket) => ticket.status === 'error').length;
          await Promise.all(deviceFailures.map(async ({ token, errorCode }) => {
            const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
            if (recipient?.userId) {
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }
          }));
        } catch (error) {
          errorCount += chunk.length;
          log.error('Internal chat notification chunk failed', error, { tourId, chunkSize: chunk.length });
        }
      }

      log.info('Internal chat notification completed', {
        tourId,
        messageId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
      });
      return null;
    } catch (error) {
      log.error('Fatal error in sendInternalChatNotification', error, { tourId, messageId });
      return null;
    }
  },
);

exports.sendSafetyAlertNotification = onValueCreated(
  {
    ref: '/tours/{tourId}/safetyAlerts/{eventId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 20,
  },
  async (event) => {
    const tourId = event.params.tourId;
    const eventId = event.params.eventId;
    const alert = event.data?.val?.() || {};
    if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(eventId)) return null;
    if (
      resolveTrimmedString(alert.tourId) !== tourId
      || resolveTrimmedString(alert.status) !== 'pending'
      || !SAFETY_CATEGORIES.has(resolveTrimmedString(alert.category)?.toLowerCase())
      || !SAFETY_SEVERITIES.has(resolveTrimmedString(alert.severity)?.toLowerCase())
      || (alert.schemaVersion === 2 && resolveTrimmedString(alert.eventId) !== eventId)
    ) {
      log.warn('Invalid safety alert skipped for notification', { tourId, eventId });
      return null;
    }

    const db = admin.database();
    try {
      const [tourNameSnapshot, manifestSnapshot, adminUsersSnapshot] = await Promise.all([
        db.ref(`tours/${tourId}/name`).once('value'),
        db.ref(`tour_manifests/${tourId}`).once('value'),
        db.ref('admin_users').once('value'),
      ]);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData: manifestSnapshot.val() || {},
        context: { tourId, eventId, notificationType: 'safety_alert' },
      });
      const delegatedAdminIds = Object.entries(adminUsersSnapshot.val() || {})
        .filter(([, enabled]) => enabled === true)
        .map(([uid]) => uid);
      const activeDriverRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: assignedDriverRecipientIds,
        tourId,
      });
      const audienceIds = applyRecipientCap(
        [...new Set([OPERATIONS_ADMIN_UID, ...delegatedAdminIds, ...activeDriverRecipientIds])],
        NOTIFICATION_RECIPIENT_CAP,
        { tourId, notificationType: 'safety_alert' },
      );
      const usersMap = await fetchUsersSnapshot(audienceIds, { tourId, notificationType: 'safety_alert' });
      const reporterAuthUid = resolveTrimmedString(alert.reporterAuthUid || alert.userId);
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: audienceIds,
        usersMap,
        preferenceResolver: () => true,
        senderId: reporterAuthUid,
        senderParticipantIds: reporterAuthUid ? [reporterAuthUid] : [],
        excludeSender: true,
        context: { tourId, notificationType: 'safety_alert' },
      });
      if (invalidTokens.length > 0) await cleanupInvalidTokens(invalidTokens);

      const content = buildSafetyNotificationContent({
        alert,
        tourName: tourNameSnapshot.val() || tourId,
      });
      const pushMessages = validRecipients.map(({ userId }) => ({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: content.title,
        body: content.body,
        data: buildPushNavigationData({
          tourId,
          screen: 'SafetySupport',
          notificationType: alert.isSOS === true || alert.severity === 'critical'
            ? 'critical_safety_alert'
            : 'safety_alert',
        }),
        priority: content.priority,
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          const deviceFailures = collectExpoTokenFailures(tickets, chunk);
          successCount += tickets.filter((ticket) => ticket.status !== 'error').length;
          errorCount += tickets.filter((ticket) => ticket.status === 'error').length;
          await Promise.all(deviceFailures.map(async ({ token, errorCode }) => {
            const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
            if (recipient?.userId) {
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }
          }));
        } catch (error) {
          errorCount += chunk.length;
          log.error('Safety notification chunk failed', error, { tourId, eventId, chunkSize: chunk.length });
        }
      }

      const deliveryStatus = pushMessages.length === 0
        ? 'no_recipients'
        : errorCount === 0
          ? 'accepted'
          : successCount > 0
            ? 'partial'
            : 'failed';
      const deliveryUpdate = {
        notificationDeliveryStatus: deliveryStatus,
        notificationRecipientCount: pushMessages.length,
        notificationSuccessCount: successCount,
        notificationErrorCount: errorCount,
        notificationUpdatedAtMs: Date.now(),
      };
      const mirrorUpdates = Object.fromEntries(
        Object.entries(deliveryUpdate).flatMap(([key, value]) => [
          [`tours/${tourId}/safetyAlerts/${eventId}/${key}`, value],
          ...(alert.isSOS === true || alert.severity === 'critical'
            ? [[`globalSafetyAlerts/${eventId}/${key}`, value]]
            : []),
        ]),
      );
      await db.ref().update(mirrorUpdates);
      log.info('Safety notification completed', {
        tourId,
        eventId,
        recipients: pushMessages.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        deliveryStatus,
      });
      return null;
    } catch (error) {
      log.error('Fatal error in sendSafetyAlertNotification', error, { tourId, eventId });
      await db.ref(`tours/${tourId}/safetyAlerts/${eventId}`).update({
        notificationDeliveryStatus: 'failed',
        notificationUpdatedAtMs: Date.now(),
      }).catch(() => {});
      return null;
    }
  },
);

const findPhotoRecordByStoragePath = async ({
  dbRoot,
  objectPath,
  maxAttempts = 5,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await dbRoot
      .orderByChild('storagePath')
      .equalTo(objectPath)
      .once('value');
    const [photoId, photoRecord] = Object.entries(snapshot.val() || {})[0] || [];
    if (photoId && photoRecord?.storagePath === objectPath) return { photoId, photoRecord };
    if (attempt < maxAttempts - 1) await wait(Math.min(250 * (2 ** attempt), 2_000));
  }
  return null;
};

const isPhotoVariantRecordReady = ({ visibility, photoRecord }) => {
  if (photoRecord?.variantStatus !== "ready") return false;
  return Boolean(photoRecord.viewerStoragePath && photoRecord.thumbnailStoragePath);
};

const processPhotoVariantObject = async (event) => {
    const objectData = event.data || {};
    const bucketName = objectData.bucket;
    const objectPath = objectData.name || "";
    const metadata = objectData.metadata || {};

    if (!bucketName || !objectPath) {
      return null;
    }

    if (metadata.variant && metadata.variant !== "source") {
      return null;
    }

    const parsed = parseSourcePhotoPath(objectPath);
    if (!parsed) {
      return null;
    }

    const { tourId, visibility, ownerKey } = parsed;
    if (!tourId) {
      return null;
    }

    const dbRoot = admin.database().ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
    const match = await findPhotoRecordByStoragePath({ dbRoot, objectPath });
    if (!match) return null;
    const { photoId, photoRecord } = match;
    if (isPhotoVariantRecordReady({ visibility, photoRecord })) {
      return null;
    }

    await generatePhotoVariantsForRecord({
      bucketName,
      visibility,
      tourId,
      ownerKey,
      photoId,
      photoRecord: {
        ...photoRecord,
        storagePath: objectPath,
      },
    });

    return null;
  };

exports.generatePhotoVariants = onObjectFinalized(
  {
    // Storage triggers must run in the same region as the bucket.
    // We keep this trigger in us-east1 to match Firebase free-tier bucket location.
    region: "us-east1",
    maxInstances: 10,
  },
  processPhotoVariantObject,
);
/**
 * Trigger: When the itinerary is published, updated, or withdrawn.
 * Enhanced with validation, better error handling, and performance tracking
 */
exports.sendItineraryNotification = onValueWritten(
  {
    ref: "/tours/{tourId}/itinerary",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId)) {
        log.error("Invalid tourId path parameter", null, { tourId });
        return null;
      }

      log.info("Processing itinerary update notification", { tourId });

      const itineraryChange = summarizeItineraryChange(
        event.data?.before?.val?.() || {},
        event.data?.after?.val?.() || {},
      );
      if (!itineraryChange.hasMeaningfulChange) {
        log.info('Skipping metadata-only itinerary notification', { tourId });
        return null;
      }
      // 1. Rate limiting check (prevent notification spam on rapid updates)
      const rateLimitKey = `itinerary_notify_${tourId}`;
      if (!checkRateLimit(rateLimitKey, 5, 300000)) { // Max 5 updates per 5 minutes
        log.warn("Itinerary update rate limit exceeded", { tourId });
        return null;
      }

      // 2. Get only fields required for itinerary notifications.
      const [isActiveSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/isActive`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tour_manifests/${tourId}`).once("value"),
      ]);

      // Check if tour is active
      if (isActiveSnapshot.val() === false) {
        log.info("Tour is inactive, skipping notification", { tourId });
        return null;
      }

      const itineraryNotice = buildTourNotificationRecord({
          type: 'itinerary',
          tourId,
          sourceId: event.id || `${Date.now()}`,
          title: itineraryChange.title,
          body: itineraryChange.body,
          screen: 'Itinerary',
          createdAtMs: Date.now(),
          priority: 'high',
        });
      await persistTourNotification({
        record: itineraryNotice,
      });

      const participants = participantsSnapshot.exists() ? (participantsSnapshot.val() || {}) : {};
      const participantIds = Object.keys(participants);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData: manifestSnapshot.val() || {},
        context: { tourId, notificationType: 'itinerary' },
      });
      const recipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: [...new Set([...participantIds, ...assignedDriverRecipientIds])],
        tourId,
        participants,
      });

      if (recipientIds.length === 0) {
        log.info("No participants or assigned drivers for itinerary update", { tourId });
        return null;
      }

      const cappedRecipientIds = applyRecipientCap(recipientIds, NOTIFICATION_RECIPIENT_CAP, {
        tourId,
        notificationType: 'itinerary',
      });

      const fetchUsersStart = Date.now();
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, { tourId, notificationType: 'itinerary' });
      const userFetchDurationMs = Date.now() - fetchUsersStart;

      const assemblyStart = Date.now();
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'itinerary_changes'],
        senderId: null,
        excludeSender: false,
        context: { tourId, notificationType: 'itinerary' },
      });

      const pushMessages = [];
      const recipientChunks = chunkArrayDeterministically(
        validRecipients.map((recipient) => recipient.userId),
        RECIPIENT_CHUNK_SIZE,
      );
      log.info('Using deterministic recipient chunking for itinerary notifications', {
        tourId,
        chunks: recipientChunks.length,
        chunkSize: RECIPIENT_CHUNK_SIZE,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
      });

      for (const recipientChunk of recipientChunks) {
        for (const userId of recipientChunk) {
          const userData = usersMap[userId];
          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: itineraryChange.title,
            body: itineraryChange.body,
            data: buildPushNavigationData({
              tourId,
              screen: "Itinerary",
              noticeId: itineraryNotice.noticeId,
              notificationType: 'itinerary',
            }),
            priority: "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 4. Complete invalid-token cleanup before the serverless invocation exits.
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      // 5. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients for itinerary update", { tourId });
        return null;
      }

      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }
      const pushSendDurationMs = Date.now() - pushSendStart;

      const duration = Date.now() - startTime;
      log.info("Itinerary notification completed", {
        tourId,
        recipients: pushMessages.length,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        userFetchDurationMs,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendItineraryNotification", error, { tourId, duration: `${duration}ms` });
      return null;
    }
  }
);

/**
 * Derives one privacy-safe semantic change record from a published Driver Tour
 * Pack revision and notifies only coherently assigned drivers. Publication
 * metadata is excluded by the pure change summarizer, so identical/no-op
 * republishes never create a notice or push.
 */
exports.sendDriverTourPackChangeNotification = onValueWritten(
  {
    ref: '/driver_tour_packs/{departureKey}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const departureKey = event.params.departureKey;
    const beforePack = event.data?.before?.val?.() || null;
    const afterPack = event.data?.after?.val?.() || null;
    if (!isValidFirebaseKey(departureKey) || afterPack?.departureKey !== departureKey) {
      log.warn('Driver Tour Pack change trigger rejected invalid identity', { departureKey });
      return null;
    }

    const change = summarizeDriverTourPackChange(beforePack, afterPack, {
      eventId: event.id,
      createdAtMs: Date.now(),
    });
    if (!change) {
      log.info('Skipping metadata-only Driver Tour Pack notification', { departureKey });
      return null;
    }

    const db = admin.database();
    const changePath = `driver_tour_pack_changes/${departureKey}/latest`;
    const safeChange = {
      ...change,
      changedSections: Object.fromEntries(change.changedSections.map((section) => [section, true])),
      notificationStatus: 'processing',
      notificationUpdatedAtMs: Date.now(),
    };

    try {
      await db.ref(changePath).set(safeChange);
      const [manifestSnapshot, featureFlagsSnapshot] = await Promise.all([
        db.ref(`tour_manifests/${afterPack.tourId}`).once('value'),
        db.ref('driver_tour_pack_feature_flags').once('value'),
      ]);
      const manifestData = manifestSnapshot.val() || {};
      const featureFlags = featureFlagsSnapshot.val() || {};
      const globalNotificationsEnabled = featureFlags.global === true;
      const enabledDriverFlags = featureFlags.drivers && typeof featureFlags.drivers === 'object'
        ? featureFlags.drivers
        : {};
      const notificationManifest = globalNotificationsEnabled
        ? manifestData
        : {
          ...manifestData,
          assigned_drivers: Object.fromEntries(Object.entries(manifestData.assigned_drivers || {})
            .filter(([driverId, assigned]) => assigned === true && enabledDriverFlags[driverId] === true)),
        };
      const recipientIds = await resolveAssignedDriverRecipientIds({
        tourId: afterPack.tourId,
        manifestData: notificationManifest,
        context: { departureKey, notificationType: 'driver_tour_pack' },
      });
      const activeRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds,
        tourId: afterPack.tourId,
      });
      const cappedRecipientIds = applyRecipientCap(activeRecipientIds, NOTIFICATION_RECIPIENT_CAP, {
        departureKey,
        notificationType: 'driver_tour_pack',
      });
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, {
        departureKey,
        notificationType: 'driver_tour_pack',
      });
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'driver_updates'],
        senderId: null,
        excludeSender: false,
        context: { departureKey, notificationType: 'driver_tour_pack' },
      });
      if (invalidTokens.length) await cleanupInvalidTokens(invalidTokens);

      const title = 'Operational information changed';
      const body = change.critical
        ? 'A critical operational update requires your acknowledgement in the Driver Command Centre.'
        : 'Open the Driver Command Centre to review the updated sections.';
      const notice = buildTourNotificationRecord({
        type: 'driver_tour_pack',
        tourId: afterPack.tourId,
        sourceId: `${departureKey}:${afterPack.revision}`,
        title,
        body,
        screen: 'DriverTourPack',
        createdAtMs: change.createdAtMs,
        priority: change.critical ? 'high' : 'normal',
        departureKey,
        revision: afterPack.revision,
        changedSections: change.changedSections,
        critical: change.critical,
        requiresAcknowledgement: change.requiresAcknowledgement,
      });
      // Driver Tour Pack notices live in the exact-assignment change root. They
      // are deliberately not copied into the tour-wide passenger inbox.

      const pushMessages = validRecipients.map(({ userData }) => ({
        to: userData.pushToken,
        sound: 'default',
        title,
        body,
        data: buildPushNavigationData({
          screen: 'DriverTourPack',
          tourId: afterPack.tourId,
          noticeId: notice.noticeId,
          notificationType: 'driver_tour_pack',
          departureKey,
          revision: afterPack.revision,
          changedSections: change.changedSections,
          critical: change.critical,
          requiresAcknowledgement: change.requiresAcknowledgement,
        }),
        priority: change.critical ? 'high' : 'default',
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          tickets.forEach((ticket) => {
            if (ticket?.status === 'ok') successCount += 1;
            else errorCount += 1;
          });
          const tokenFailures = collectExpoTokenFailures(tickets, chunk);
          if (tokenFailures.length) {
            await Promise.all(tokenFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate.userData?.pushToken === token);
              if (recipient?.userId) await removeInvalidToken(recipient.userId, token, { reason: errorCode });
            }));
          }
        } catch (error) {
          errorCount += chunk.length;
          log.error('Driver Tour Pack notification chunk failed', error, { departureKey, chunkSize: chunk.length });
        }
      }

      await db.ref(changePath).update({
        notificationStatus: pushMessages.length === 0
          ? (globalNotificationsEnabled || Object.values(enabledDriverFlags).some((enabled) => enabled === true)
            ? 'no_recipients'
            : 'feature_disabled')
          : errorCount === 0 ? 'delivered' : successCount > 0 ? 'partial' : 'failed',
        notificationRecipientCount: pushMessages.length,
        notificationSuccessCount: successCount,
        notificationErrorCount: errorCount,
        notificationUpdatedAtMs: Date.now(),
        noticeId: notice.noticeId,
      });
      log.info('Driver Tour Pack semantic notification completed', {
        departureKey,
        revision: afterPack.revision,
        changedSections: change.changedSections,
        critical: change.critical,
        recipientCount: pushMessages.length,
        successCount,
        errorCount,
      });
    } catch (error) {
      await db.ref(changePath).update({
        notificationStatus: 'failed',
        notificationUpdatedAtMs: Date.now(),
      }).catch(() => {});
      log.error('Driver Tour Pack semantic notification failed', error, {
        departureKey,
        revision: afterPack.revision,
      });
    }
    return null;
  },
);

const normalizeTourDateIndexesForEvent = async (event) => {
  const tourId = event.params.tourId;
  if (!isValidFirebaseKey(tourId)) return null;
  const tourRef = admin.database().ref(`tours/${tourId}`);
  const tourSnapshot = await tourRef.once('value');
  const tour = tourSnapshot.val() || null;
  if (!tour) return null;
  const indexUpdate = deriveTourDateIndexUpdate(tour);
  if (!indexUpdate) return null;
  await tourRef.update(indexUpdate);
  log.info('Tour date query indexes normalized', {
    tourId,
    indexed: indexUpdate.startDateEpochMs !== null,
  });
  return null;
};

/**
 * Keeps the bounded admin date query fields coherent for every producer.
 * Date-leaf triggers avoid charging an invocation for unrelated high-volume
 * tour children such as live location, participant, and safety updates.
 */
exports.normalizeTourDateIndexes = onValueWritten(
  {
    ref: '/tours/{tourId}/startDate',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  normalizeTourDateIndexesForEvent,
);

exports.normalizeTourEndDateIndex = onValueWritten(
  {
    ref: '/tours/{tourId}/endDate',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  normalizeTourDateIndexesForEvent,
);

/**
 * Projects driver-owned action state into a compact operations view. The
 * progress projection contains counts only; the admin issue index contains
 * structured category/severity/status facts and deliberately omits free text.
 */
exports.projectDriverTourPackActionState = onValueWritten(
  {
    ref: '/driver_tour_pack_actions/{departureKey}/{driverId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 20,
  },
  async (event) => {
    const { departureKey, driverId } = event.params;
    if (!isValidFirebaseKey(departureKey) || !isValidFirebaseKey(driverId)) return null;
    const db = admin.database();
    const packSnapshot = await db.ref(`driver_tour_packs/${departureKey}`).once('value');
    const updates = buildDriverTourPackActionProjectionUpdates({
      departureKey,
      driverId,
      pack: packSnapshot.val() || null,
      beforeActions: event.data?.before?.val?.() || null,
      afterActions: event.data?.after?.val?.() || null,
      updatedAtMs: Date.now(),
    });
    // Legacy projections used only issueId as the global key, so different
    // departures could overwrite one another. Remove a legacy entry only when
    // it still belongs to this exact source identity; v2 composite entries are
    // written by the pure projection builder above.
    const beforeIssues = event.data?.before?.val?.()?.issues || {};
    const afterIssues = event.data?.after?.val?.()?.issues || {};
    const legacyIssueIds = new Set([...Object.keys(beforeIssues), ...Object.keys(afterIssues)]
      .filter((issueId) => JSON.stringify(beforeIssues[issueId] ?? null) !== JSON.stringify(afterIssues[issueId] ?? null)));
    await Promise.all([...legacyIssueIds].map(async (issueId) => {
      if (!isValidFirebaseKey(issueId)) return;
      const legacyPath = `driver_tour_pack_issues/${issueId}`;
      const legacySnapshot = await db.ref(legacyPath).once('value');
      const legacy = legacySnapshot.val();
      if (legacy?.departureKey === departureKey && legacy?.driverId === driverId && legacy?.issueId === issueId) {
        updates[legacyPath] = null;
      }
    }));
    if (Object.keys(updates).length) await db.ref('/').update(updates);
    log.info('Driver Tour Pack action projection updated', {
      departureKey,
      driverId,
      updateCount: Object.keys(updates).length,
    });
    return null;
  },
);

/**
 * Purges expired Driver Tour Pack operational data. The pack root is indexed
 * by expiresAtMs, so each scheduled invocation reads and deletes one bounded
 * batch. A PII-free expiry tombstone is retained for audit and client cache
 * invalidation; retries are naturally idempotent because deleted packs no
 * longer match the query.
 */
exports.cleanupExpiredDriverTourPacks = onSchedule(
  {
    schedule: 'every 6 hours',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const result = await cleanupExpiredDriverTourPacks({ database: admin.database() });
    log.info('Driver Tour Pack expiry cleanup completed', result);
    return result;
  },
);

/**
 * Removes expired live driver-coordinate leases in a bounded batch. Each
 * candidate is transactionally compared with the queried session so a fresh
 * publication can never be deleted by an older cleanup run.
 */
exports.cleanupExpiredDriverLocations = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
  },
  async () => {
    const result = await cleanupExpiredDriverLocations({ database: admin.database() });
    if (result.hasMore) log.warn('Expired driver-location cleanup reached its bounded ceiling', result);
    else log.info('Expired driver-location cleanup completed', result);
    return result;
  },
);

/**
 * Removes only expired, opaque login limiter counters. Active counters remain
 * authoritative across all Gen2 instances; no login or network identifiers are
 * stored in this branch.
 */
exports.cleanupExpiredLoginRateLimits = onSchedule(
  {
    schedule: 'every 1 hours',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
  },
  async () => {
    const database = admin.database();
    const [loginResult, safetyResult] = await Promise.all([
      cleanupExpiredLoginRateLimits({ database }),
      cleanupExpiredLoginRateLimits({ database, rootPath: SAFETY_RATE_LIMIT_ROOT }),
    ]);
    if (loginResult.hasMore) log.warn('Expired login rate-limit cleanup reached its bounded ceiling', loginResult);
    else log.info('Expired login rate-limit cleanup completed', loginResult);
    if (safetyResult.hasMore) log.warn('Expired safety rate-limit cleanup reached its bounded ceiling', safetyResult);
    else log.info('Expired safety rate-limit cleanup completed', safetyResult);
    return { login: loginResult, safety: safetyResult };
  },
);

exports.cleanupExpiredAppSessions = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const db = admin.database();
    const nowMs = Date.now();
    const snapshot = await db.ref('app_sessions')
      .orderByChild('expiresAtMs')
      .endAt(nowMs)
      .limitToFirst(50)
      .once('value');
    const candidates = snapshot.val() || {};
    const summary = { scanned: 0, expired: 0, alreadyEnded: 0, locked: 0, failed: 0, eventsRemoved: 0 };
    for (const [authUid, candidate] of Object.entries(candidates)) {
      summary.scanned += 1;
      const lock = await acquireAppSessionLock({ db, authUid, operation: 'cleanup', nowMs });
      if (!lock.acquired) {
        summary.locked += 1;
        continue;
      }
      try {
        const currentSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
        const current = currentSnapshot.val();
        if (!current || current.sessionId !== candidate.sessionId) {
          summary.alreadyEnded += 1;
          continue;
        }
        if (Number(current.expiresAtMs) > nowMs) continue;
        await cleanupAppSession({
          db,
          session: current,
          expectedSessionId: current.sessionId,
          eventType: 'expired',
          reason: 'session_expired',
          actorType: 'system',
          nowMs,
          createEventId: () => db.ref('app_session_events').push().key,
        });
        summary.expired += 1;
      } catch (error) {
        summary.failed += 1;
        log.error('Expired app session cleanup failed', error, { authUid });
      } finally {
        await releaseAppSessionLock({ db, authUid, owner: lock.owner });
      }
    }

    const eventsSnapshot = await db.ref('app_session_events')
      .orderByChild('expiresAtMs')
      .endAt(nowMs)
      .limitToFirst(100)
      .once('value');
    const eventUpdates = {};
    eventsSnapshot.forEach((child) => { eventUpdates[child.key] = null; });
    if (Object.keys(eventUpdates).length) {
      await db.ref('app_session_events').update(eventUpdates);
      summary.eventsRemoved = Object.keys(eventUpdates).length;
    }
    log.info('Expired app session cleanup completed', summary);
    return summary;
  },
);

/**
 * Deletes ambiguous legacy auth-UID read markers once a canonical passenger
 * or driver principal is active. UID-only history cannot be safely attributed
 * on shared devices, so it is never copied into the canonical branch.
 */
exports.processNotificationReadMigrationRequest = onValueCreated(
  {
    ref: '/notification_read_migration_requests/{tourId}/{authUid}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
    retry: true,
  },
  async (event) => {
    const { tourId, authUid } = event.params;
    try {
      const result = await processNotificationReadMigrationRequest({
        db: admin.database(),
        tourId,
        authUid,
        request: event.data?.val(),
      });
      log.info('Notification read-state migration request completed', {
        tourId,
        legacyRemoved: result.legacyRemoved,
        invalid: result.invalid,
      });
      return result;
    } catch (error) {
      log.error('Notification read-state migration request failed', error, { tourId, authUid });
      throw error;
    }
  },
);

/**
 * Continues exact notice read-state cleanup in bounded user pages. Eviction
 * only enqueues a small durable job; notification delivery never downloads a
 * tour-wide read-state fanout.
 */
exports.cleanupNotificationReadState = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const database = admin.database();
    const results = await processNotificationReadCleanupJobs({ db: database });
    let legacyResult = null;
    try {
      legacyResult = await processLegacyNotificationReadStateCleanup({ db: database });
    } catch (error) {
      log.warn('Legacy notification read-state cleanup deferred', {
        error: error?.message || String(error),
      });
    }
    log.info('Notification read-state cleanup pass completed', {
      jobCount: results.length,
      completedCount: results.filter((result) => result.completed).length,
      deferredCount: results.filter((result) => result.error).length,
      legacyProcessedCount: legacyResult?.processedCount || 0,
      legacyDeletedCount: legacyResult?.deletedCount || 0,
      legacyCompleted: legacyResult?.completed === true,
    });
    return { jobs: results, legacy: legacyResult };
  },
);

/**
 * Private cross-project boundary for management-generated Driver Tour Packs.
 * Cloud Run IAM and a second in-process Google OIDC check both restrict the
 * caller to the management sync service account.
 */
exports.ingestDriverTourPacks = onRequest(
  {
    region: 'europe-west1',
    cors: false,
    invoker: [DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT],
    memory: '512MiB',
    timeoutSeconds: 120,
    maxInstances: 4,
    concurrency: 4,
  },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');

    const requestGate = validateDriverTourPackHttpRequest(req, {
      maxBodyBytes: DRIVER_TOUR_PACK_INGESTION_LIMITS.maxBodyBytes,
    });
    if (!requestGate.valid) {
      if (requestGate.status === 405) res.set('Allow', 'POST');
      res.status(requestGate.status).json({ ok: false, error: { code: requestGate.code } });
      return;
    }

    try {
      await verifyManagementOidcRequest(req);
      const publisher = createDriverTourPackPublisher({ database: admin.database() });
      const result = await publisher.handle(req.body);
      log.info('Driver Tour Pack ingestion request completed', {
        action: result.action,
        runId: result.runId,
        packCount: result.packCount ?? result.expectedPackCount ?? 0,
        batchIndex: result.batchIndex,
        aggregateFingerprint: result.aggregateFingerprint,
        batchFingerprint: result.batchFingerprint,
        idempotent: result.idempotent,
      });
      res.status(200).json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = error?.code || 'INGESTION_FAILED';
      log.warn('Driver Tour Pack ingestion request rejected', {
        action: req.body?.action,
        runId: req.body?.runId,
        status,
        code,
      });
      res.status(status).json({
        ok: false,
        error: {
          code,
          message: status >= 500 ? 'Driver Tour Pack ingestion failed.' : String(error.message || code),
        },
      });
    }
  },
);

exports.__testables = {
  toRealtimeKeySegment,
  validateMessageData,
  buildChatNotificationContent,
  buildSafetyNotificationContent,
  normalizeSafetySubmissionInput,
  buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates,
  resolveSafetyReporterAccess,
  checkSafetySubmissionRateLimit,
  resolveChatSenderParticipantIds,
  resolveChatSenderDeliveryIds,
  collectAssignedDriverIds,
  isDriverProfileAssignedToTour,
  resolveAssignedDriverRecipientIds,
  getPushTokenIneligibilityReason,
  shouldRemoveInvalidToken,
  cleanupInvalidTokens,
  selectNotificationRecipients,
  parseSourcePhotoPath,
  buildPhotoCollectionPath,
  processPhotoVariantObject,
  findPhotoRecordByStoragePath,
  isPhotoVariantRecordReady,
  hardenPrivateSourceObjectMetadata,
  hardenGroupSourceObjectMetadata,
  createPhotoVariantBuffers,
  buildPhotoVariantPaths,
  generatePhotoVariantsForRecord,
  sanitizeLogText,
  buildVerifiedLoginGrantUpdates,
  buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
  buildPassengerSafeItinerary,
  buildPassengerSafeBooking,
  buildPassengerSafeTour,
  verifyRequestAuthUid,
  verifyCurrentTourPhotoAccess,
  enforceGroupMediaAppCheck,
  normalizeGroupMediaRequest,
  isGroupMediaPathForRecord,
  readGroupMediaRecords,
  signGroupMediaRecords,
  normalizeGroupPhotoUploadMetadata,
  extensionForGroupPhotoContentType,
  reserveGroupPhotoRecord,
  normalizeManualPassengerPayload,
  findManualPassengerSeatConflicts,
  buildManualPassengerBookingUpdates,
  verifyOperationsAdminAccess,
  isAllowedAdminOrigin,
  buildTourManifestPayload,
  verifyTourManifestAccess,
  normalizeManifestPassengerRows,
  normalizeManifestBooking,
  buildDriverManifestBooking,
  resolveDriverAssignment,
  claimDriverAuthUid,
  buildDriverIdentityProfileUpdates,
  collectDriverAssignmentConflicts,
  buildDriverSelfAssignmentUpdates,
  checkDriverLoginRateLimits,
  validateCategoryBroadcastData,
  userWantsTourCategoryBroadcast,
  resolveBroadcastDeliveryStatus,
  buildTourDeletionUpdates,
  resolveReportedPhotoStoragePaths,
  checkPassengerLoginRateLimits,
  shouldRequireLoginAppCheck,
  isDeployedFunctionsRuntime,
  enforceLoginAppCheck,
  getTrustedRequestNetworkKey,
  createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits,
  buildTourNotificationId,
  buildTourNotificationRecord,
  buildPushNavigationData,
  buildCategoryBroadcastPushMessages,
  summarizeItineraryChange,
  summarizeDriverTourPackChange,
  buildDriverTourPackActionProjectionUpdates,
  persistTourNotification,
  buildNotificationReadCleanupJobId,
  enqueueNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest,
  fetchRealtimeDatabaseShallowKeys,
  shouldDeleteLegacyNotificationReadPrincipal,
  processLegacyNotificationReadStateCleanup,
  processNotificationReadCleanupJob,
  processNotificationReadCleanupJobs,
  createDriverTourPackPublisher,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
  normalizePrivateMediaRequest,
  isPrivateMediaPathForRecord,
  readPrivateMediaRecords,
  signPrivateMediaRecords,
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
  calculateSessionExpiry,
  createAppSessionId,
  isActiveSessionRecord,
  isValidAppSessionId,
  toClientSession,
  acquireAppSessionLock,
  releaseAppSessionLock,
  verifyActiveAppSession,
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupAppSession,
  cleanupDriverLocationForSession,
  normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord,
};
