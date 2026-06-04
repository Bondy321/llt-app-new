/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 * Updated for Cloud Functions Gen 2 (v2) - Region Fix
 * Enhanced with comprehensive error handling, validation, and performance improvements
 */

const { onValueCreated, onValueUpdated } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Expo SDK
const expo = new Expo();

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;
const USER_PROFILE_FETCH_CHUNK_SIZE = 100;
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_PROFILE_CACHE_MAX_ENTRIES = 5000;
const userProfileCache = new Map();
const PHOTO_CACHE_CONTROL_HEADER = "public,max-age=31536000,immutable";
const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;
const VERIFIED_LOGIN_GRANT_TTL_MS = 30 * 60 * 1000;
const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const MANIFEST_STATUS = {
  PENDING: 'PENDING',
  BOARDED: 'BOARDED',
  NO_SHOW: 'NO_SHOW',
  PARTIAL: 'PARTIAL',
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

  if (!messageData.text || typeof messageData.text !== 'string') {
    errors.push('Invalid or missing message text');
  } else if (messageData.text.length > 10000) {
    errors.push('Message text exceeds maximum length (10000 characters)');
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

const getPushTokenIneligibilityReason = (userData = {}) => {
  const tokenStatus = typeof userData?.pushTokenStatus === 'string'
    ? userData.pushTokenStatus.trim().toUpperCase()
    : '';
  if (tokenStatus === 'INVALID' || tokenStatus === 'UNAVAILABLE') {
    return `token_status_${tokenStatus.toLowerCase()}`;
  }

  const permissionState = typeof userData?.pushPermissionState === 'string'
    ? userData.pushPermissionState.trim().toLowerCase()
    : '';
  if (permissionState === 'denied' || permissionState === 'blocked' || permissionState === 'unavailable') {
    return `permission_${permissionState}`;
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

const selectNotificationRecipients = ({
  participantIds,
  usersMap,
  preferencePath,
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

    const wantsFeatureNotifications = getPreferenceValue(userData, preferencePath, true);
    if (!wantsFeatureNotifications) {
      log.info('User opted out of notification feature', {
        ...context,
        userId,
        preferencePath: preferencePath.join('.'),
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
  const candidatePrincipals = [
    resolveTrimmedString(messageData.senderId),
    resolveTrimmedString(messageData.senderStableId),
    resolveTrimmedString(messageData.senderUid),
  ].filter(Boolean);

  candidatePrincipals.forEach((candidate) => {
    if (participantMap[candidate]) {
      senderParticipantIds.add(candidate);
    }
  });

  if (senderParticipantIds.size > 0) {
    return [...senderParticipantIds];
  }

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
  const legacyActiveTourId = normalizeTourKeyForComparison(driverData?.activeTourId);

  if (!currentTourId && !legacyActiveTourId) {
    return true;
  }

  return currentTourId === expectedTourId || legacyActiveTourId === expectedTourId;
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

const buildFirebaseStorageDownloadUrl = ({ bucketName, objectPath, token }) => {
  if (!bucketName || !objectPath || !token) return null;
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
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
    const { viewerBuffer, thumbnailBuffer } = await createPhotoVariantBuffers(sourceBuffer);
    const viewerToken = randomUUID();
    const thumbnailToken = randomUUID();

    await Promise.all([
      resolvedBucket.file(viewerPath).save(viewerBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: {
            variant: "viewer",
            idempotencyKey: photoRecord.idempotencyKey || "",
            firebaseStorageDownloadTokens: viewerToken,
          },
        },
      }),
      resolvedBucket.file(thumbnailPath).save(thumbnailBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: {
            variant: "thumbnail",
            idempotencyKey: photoRecord.idempotencyKey || "",
            firebaseStorageDownloadTokens: thumbnailToken,
          },
        },
      }),
    ]);

    const viewerUrl = buildFirebaseStorageDownloadUrl({
      bucketName,
      objectPath: viewerPath,
      token: viewerToken,
    });
    const thumbnailUrl = buildFirebaseStorageDownloadUrl({
      bucketName,
      objectPath: thumbnailPath,
      token: thumbnailToken,
    });

    await resolvedDbRoot.child(photoId).update({
      viewerUrl,
      viewerStoragePath: viewerPath,
      thumbnailUrl,
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

/**
 * Rate limiting check (simple implementation)
 */
const rateLimitCache = new Map();
const checkRateLimit = (key, maxRequests = 10, windowMs = 60000) => {
  const now = Date.now();
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

/**
 * Cleanup old rate limit entries (called periodically)
 */
const maintenanceInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitCache.entries()) {
    if (now > record.resetTime) {
      rateLimitCache.delete(key);
    }
  }

  cleanupUserProfileCache(now);
}, 300000); // Clean up every 5 minutes
if (typeof maintenanceInterval.unref === 'function') {
  maintenanceInterval.unref();
}



const normalizeBookingRef = (bookingRef) => {
  if (typeof bookingRef !== 'string') return '';
  return bookingRef.trim().toUpperCase();
};

const normalizeEmail = (email) => {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
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

    return { success: true, uid };
  } catch (error) {
    log.warn('Request auth token verification failed', {
      reason: error?.code || 'AUTH_TOKEN_INVALID',
      error: error?.message || String(error),
    });
    return { success: false, reason: 'AUTH_TOKEN_INVALID' };
  }
};

const buildVerifiedLoginGrantUpdates = ({
  authUid,
  bookingRef,
  normalizedPassengerEmail,
  tourId,
  tourCode = null,
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

  if (normalizedPassengerEmail) {
    grantPayload.normalizedPassengerEmail = normalizedPassengerEmail;
  }

  if (tourCode) {
    grantPayload.tourCode = tourCode;
  }

  return {
    [`tour_access_grants/${tourId}/${authUid}`]: grantPayload,
    [`booking_access_grants/${bookingRef}/${authUid}`]: grantPayload,
  };
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
  const passengerNames = Array.isArray(bookingData.passengerNames)
    ? bookingData.passengerNames
    : Array.isArray(bookingData.passengers)
      ? bookingData.passengers
      : [];
  const seatNumbers = Array.isArray(bookingData.seatNumbers) ? [...bookingData.seatNumbers] : [];

  if (passengerNames.length > seatNumbers.length) {
    seatNumbers.push(...Array(passengerNames.length - seatNumbers.length).fill('TBA'));
  } else if (seatNumbers.length > passengerNames.length && passengerNames.length > 0) {
    seatNumbers.length = passengerNames.length;
  }

  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [{
        location: bookingData.pickupLocation || 'To be confirmed',
        time: bookingData.pickupTime || 'TBA',
      }];

  return {
    id: bookingRef,
    ...bookingData,
    passengerNames,
    seatNumbers,
    pickupPoints,
    pickupTime: bookingData.pickupTime || pickupPoints?.[0]?.time || 'TBA',
    pickupLocation: bookingData.pickupLocation || pickupPoints?.[0]?.location || 'To be confirmed',
  };
};

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

  const tourSnapshot = await db.ref(`tours/${canonicalTourId}`).once('value');
  if (!tourSnapshot.exists()) {
    const error = new Error('Tour not found');
    error.code = 'TOUR_NOT_FOUND';
    throw error;
  }

  const tourData = tourSnapshot.val() || {};
  const tourCodeForSearch = resolveTrimmedString(tourData.tourCode)
    || resolveTrimmedString(requestedTourCode)
    || canonicalTourId.replace(/_/g, ' ');

  const [bookingsByTourCodeSnapshot, bookingsByTourIdSnapshot, manifestSnapshot] = await Promise.all([
    db.ref('bookings').orderByChild('tourCode').equalTo(tourCodeForSearch).once('value'),
    db.ref('bookings').orderByChild('tourId').equalTo(canonicalTourId).once('value'),
    db.ref(`tour_manifests/${canonicalTourId}`).once('value'),
  ]);

  const rawBookings = {
    ...(bookingsByTourCodeSnapshot.val() || {}),
    ...(bookingsByTourIdSnapshot.val() || {}),
  };
  const manifestData = manifestSnapshot.val() || {};
  const bookingStatuses = manifestData.bookings || {};
  const bookings = Object.entries(rawBookings).map(([bookingRef, bookingData]) => {
    const normalizedBooking = normalizeManifestBooking(bookingRef, bookingData || {});
    const liveStatus = bookingStatuses[bookingRef] || {};
    const totalPax = normalizedBooking.passengerNames.length;
    const hasPassengerStatuses = Array.isArray(liveStatus.passengerStatus)
      || Array.isArray(liveStatus.passengers);
    const rawPassengerStatuses = Array.isArray(liveStatus.passengerStatus)
      ? liveStatus.passengerStatus
      : liveStatus.passengers;
    const passengerStatus = normalizePassengerStatuses(rawPassengerStatuses, totalPax);
    const derivedStatus = hasPassengerStatuses ? deriveParentStatusFromPassengers(passengerStatus) : null;

    return {
      ...normalizedBooking,
      status: derivedStatus || liveStatus.status || MANIFEST_STATUS.PENDING,
      hasPassengerStatuses,
      passengerStatus,
      notes: liveStatus.notes || '',
    };
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
    tourId: canonicalTourId,
    tourCode: tourCodeForSearch,
    bookings,
    stats,
  };
};

const normalizeDriverId = (driverId) => {
  if (typeof driverId !== 'string') return '';
  return driverId.trim().toUpperCase();
};

const normalizeAssignedDriverCodeRecord = ({ value, driverId, fallbackTourId = null, fallbackTourCode = null }) => {
  if (!value) return null;

  if (typeof value === 'string') {
    const normalizedTourId = normalizeTourKeyForComparison(value) || fallbackTourId;
    return normalizedTourId
      ? {
          tourId: normalizedTourId,
          tourCode: fallbackTourCode || normalizedTourId.replace(/_/g, ' '),
          driverId,
          legacy: true,
        }
      : null;
  }

  if (typeof value !== 'object') return null;

  const normalizedTourId = normalizeTourKeyForComparison(value.tourId) || fallbackTourId;
  const tourCode = resolveTrimmedString(value.tourCode)
    || fallbackTourCode
    || (normalizedTourId ? normalizedTourId.replace(/_/g, ' ') : null);

  return normalizedTourId && tourCode
    ? {
        tourId: normalizedTourId,
        tourCode,
        driverId,
        legacy: false,
      }
    : null;
};

const resolveDriverAssignment = async ({ driverId, driverData = {}, db = admin.database() }) => {
  let assignedTourId = normalizeTourKeyForComparison(driverData.currentTourId)
    || normalizeTourKeyForComparison(driverData.activeTourId);
  let assignedTourCode = resolveTrimmedString(driverData.currentTourCode);

  if (assignedTourId) {
    return {
      assignedTourId,
      assignedTourCode,
      assignmentSource: driverData.currentTourId ? 'driver_profile' : 'legacy_active_tour',
    };
  }

  const manifestsSnapshot = await db.ref('tour_manifests').once('value');
  const manifests = manifestsSnapshot.val() || {};
  for (const [manifestTourId, manifestData] of Object.entries(manifests)) {
    const normalized = normalizeAssignedDriverCodeRecord({
      value: manifestData?.assigned_driver_codes?.[driverId],
      driverId,
      fallbackTourId: normalizeTourKeyForComparison(manifestTourId),
      fallbackTourCode: resolveTrimmedString(manifestData?.tourCode)
        || normalizeTourKeyForComparison(manifestTourId)?.replace(/_/g, ' '),
    });

    if (normalized?.tourId) {
      assignedTourId = normalized.tourId;
      assignedTourCode = normalized.tourCode;
      return {
        assignedTourId,
        assignedTourCode,
        assignmentSource: normalized.legacy ? 'legacy_manifest_string' : 'manifest_driver_code',
      };
    }
  }

  return {
    assignedTourId: null,
    assignedTourCode: null,
    assignmentSource: 'unassigned',
  };
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

exports.verifyPassengerLogin = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`verify_passenger_login_${clientKey}`, 12, 60000)) {
      log.warn('Passenger login rate limit exceeded', { clientKey });
      return res.status(429).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
    }

    const bookingRef = normalizeBookingRef(req.body?.bookingRef);
    const email = normalizeEmail(req.body?.email);

    if (!bookingRef || !email) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    try {
      const requestAuth = await verifyRequestAuthUid(req);
      if (!requestAuth.success) {
        log.warn('Passenger login rejected: missing or invalid Firebase auth token', {
          bookingRef,
          clientKey,
          reason: requestAuth.reason,
        });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const requireAppCheck = process.env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true';
      const appCheckToken = req.headers['x-firebase-appcheck'];

      if (requireAppCheck) {
        if (typeof appCheckToken !== 'string' || !appCheckToken.trim()) {
          log.warn('Passenger login rejected: missing App Check token', { clientKey, bookingRef });
          return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
        }

        try {
          await admin.appCheck().verifyToken(appCheckToken.trim());
        } catch (appCheckError) {
          log.warn('Passenger login rejected: invalid App Check token', {
            clientKey,
            bookingRef,
            error: appCheckError.message,
          });
          return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
        }
      }

      const identitySnapshot = await admin.database().ref(`booking_identities/${bookingRef}`).once('value');

      if (!identitySnapshot.exists()) {
        log.warn('Passenger login verification failed', { bookingRef, clientKey, cause: 'BOOKING_NOT_FOUND' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const identity = identitySnapshot.val() || {};
      const storedEmail = normalizeEmail(identity.email);

      if (!storedEmail || storedEmail !== email) {
        log.warn('Passenger login verification failed', { bookingRef, clientKey, cause: 'EMAIL_MISMATCH' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const resolvedBookingRef = normalizeBookingRef(identity.bookingRef || bookingRef);
      const resolvedTourId = typeof identity.tourId === 'string' ? identity.tourId.trim() : '';
      const resolvedTourCode = typeof identity.tourCode === 'string' ? identity.tourCode.trim() : '';
      const canonicalTourId = normalizeTourKeyForComparison(resolvedTourId || resolvedTourCode);

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

      const bookingData = bookingSnapshot.val() || {};
      const canonicalTourCode = resolveTrimmedString(resolvedTourCode)
        || resolveTrimmedString(tourData.tourCode)
        || resolveTrimmedString(bookingData.tourCode)
        || null;
      const grantUpdates = buildVerifiedLoginGrantUpdates({
        authUid: requestAuth.uid,
        bookingRef: resolvedBookingRef,
        normalizedPassengerEmail: email,
        tourId: canonicalTourId,
        tourCode: canonicalTourCode,
      });

      if (!grantUpdates) {
        log.warn('Passenger login could not build verified access grant', {
          bookingRef,
          tourId: canonicalTourId,
          authUid: requestAuth.uid,
        });
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      await admin.database().ref().update(grantUpdates);

      return res.status(200).json({
        valid: true,
        reason: 'OK',
        bookingRef: resolvedBookingRef,
        tourId: canonicalTourId,
        tourCode: canonicalTourCode,
        grantExpiresAtMs: grantUpdates[`tour_access_grants/${canonicalTourId}/${requestAuth.uid}`].expiresAtMs,
      });
    } catch (error) {
      log.error('Passenger login verification failed', error, { bookingRef });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
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

    const requestedTour = resolveTrimmedString(req.body?.tourId) || resolveTrimmedString(req.body?.tourCode);
    const tourId = normalizeTourKeyForComparison(requestedTour);
    if (!tourId || !isValidFirebaseKey(tourId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`get_tour_manifest_${requestAuth.uid}_${tourId}_${clientKey}`, 30, 60000)) {
      log.warn('Tour manifest rate limit exceeded', {
        authUid: requestAuth.uid,
        tourId,
        clientKey,
      });
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    try {
      const access = await verifyTourManifestAccess({ authUid: requestAuth.uid, tourId });
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

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`verify_driver_login_${requestAuth.uid}_${clientKey}`, 20, 60000)) {
      log.warn('Driver login rate limit exceeded', {
        authUid: requestAuth.uid,
        driverId,
        clientKey,
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

      const assignment = await resolveDriverAssignment({ driverId, driverData, db });
      let assignedTourCode = assignment.assignedTourCode;
      let resolvedTour = null;

      if (assignment.assignedTourId) {
        const tourSnapshot = await db.ref(`tours/${assignment.assignedTourId}`).once('value');
        if (tourSnapshot.exists()) {
          const tourData = tourSnapshot.val() || {};
          assignedTourCode = assignedTourCode || resolveTrimmedString(tourData.tourCode);
          resolvedTour = {
            id: assignment.assignedTourId,
            ...tourData,
          };
        }
      }

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
        return null;
      }

      const adminRecord = await admin.auth().getUser(broadcastData.createdByUid);
      const isAnonymous = adminRecord.providerData.length === 0;
      if (adminRecord.disabled || isAnonymous) {
        log.warn('Broadcast author is not eligible for admin broadcast fanout', {
          tourId,
          broadcastId,
          createdByUid: broadcastData.createdByUid,
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

      log.info('Broadcast fanout to chat completed', { tourId, broadcastId });
      return null;
    } catch (error) {
      log.error('Failed to process broadcast write', error, { tourId, broadcastId });
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

      const messageData = snapshot.val();

      // 2. Validate message data
      const validation = validateMessageData(messageData);
      if (!validation.valid) {
        log.error("Invalid message data", { errors: validation.errors }, { tourId, messageId });
        return null;
      }

      const { senderId, text: messageText, senderName } = messageData;

      // 3. Rate limiting check (prevent spam)
      const rateLimitKey = `chat_notify_${tourId}_${senderId}`;
      if (!checkRateLimit(rateLimitKey, 20, 60000)) {
        log.warn("Rate limit exceeded", { tourId, senderId });
        return null;
      }

      // 4. Security: Verify admin broadcast authenticity up-front.
      let isAdmin = isAdminBroadcast(senderId);
      if (isAdmin) {
        // Verify the admin broadcast is legitimate (not spoofed by a regular user)
        const isVerifiedAdmin = await verifyAdminBroadcast(messageData);
        if (!isVerifiedAdmin) {
          log.error("Spoofed admin broadcast rejected - invalid or missing senderUid", null, { tourId, senderId });
          return null;
        }
      }

      log.info("Processing chat notification", { tourId, senderId, senderName, isAdmin });

      // 5. Get only the fields needed for notifications.
      const [tourNameSnapshot, participantsSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value")
      ]);

      const tourName = tourNameSnapshot.val() || "Tour Chat";

      if (!participantsSnapshot.exists()) {
        log.info("No participants found", { tourId });
        return null;
      }

      const participants = participantsSnapshot.val();
      const participantIds = Object.keys(participants);
      let senderParticipantIds = [];

      // Security: regular chat messages must be sent by a participant.
      if (!isAdmin) {
        senderParticipantIds = await resolveChatSenderParticipantIds({
          participants,
          messageData,
          context: { tourId, messageId, notificationType: 'chat' },
        });
      }

      if (!isAdmin && senderParticipantIds.length === 0) {
        log.error("Sender is not a participant of the tour", null, {
          tourId,
          senderId,
          senderStableId: toRealtimeKeySegment(messageData.senderStableId),
        });
        return null;
      }

      const cappedParticipantIds = applyRecipientCap(participantIds, NOTIFICATION_RECIPIENT_CAP, {
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
        senderParticipantIds,
        excludeSender: true,
        context: { tourId, notificationType: 'chat' },
      });

      const pushMessages = [];
      const truncatedMessage = messageText.length > 200
        ? `${messageText.substring(0, 197)}...`
        : messageText;
      const notificationTitle = isAdmin
        ? `📢 ${tourName} Announcement`
        : `New message in ${tourName}`;
      const notificationBody = isAdmin
        ? truncatedMessage.replace(/^ANNOUNCEMENT:\s*/i, '')
        : `${senderName}: ${truncatedMessage}`;

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
            title: notificationTitle,
            body: notificationBody,
            data: {
              tourId: tourId,
              screen: "Chat",
              messageId: messageId,
              isAdminBroadcast: isAdmin,
            },
            priority: isAdmin ? "high" : "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 7. Clean up invalid tokens (async, don't wait)
      if (invalidTokens.length > 0) {
        Promise.all(invalidTokens.map(({ userId, token }) => removeInvalidToken(userId, token)))
          .catch(err => log.error("Error cleaning invalid tokens", err));
      }

      // 8. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients found", { tourId });
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
      log.info("Chat notification completed", {
        tourId,
        recipients: pushMessages.length,
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
      return null;
    }
  }
);

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
    const idempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey.trim() : "";
    if (!tourId || !idempotencyKey) {
      return null;
    }

    const dbRoot = admin.database().ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
    const existingSnapshot = await dbRoot
      .orderByChild("idempotencyKey")
      .equalTo(idempotencyKey)
      .once("value");

    if (!existingSnapshot.exists()) {
      return null;
    }

    const [photoId, photoRecord] = Object.entries(existingSnapshot.val() || {})[0] || [];
    if (!photoId || !photoRecord) return null;
    if (typeof photoRecord.storagePath !== "string" || photoRecord.storagePath !== objectPath) {
      log.warn("Skipping variant generation due to storagePath mismatch", {
        tourId,
        visibility,
        objectPath,
        photoId,
      });
      return null;
    }
    if (photoRecord.variantStatus === "ready" && photoRecord.viewerUrl && photoRecord.thumbnailUrl) {
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
        idempotencyKey,
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
 * Trigger: When the itinerary is updated at /tours/{tourId}/itinerary
 * Enhanced with validation, better error handling, and performance tracking
 */
exports.sendItineraryNotification = onValueUpdated(
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

      // 1. Rate limiting check (prevent notification spam on rapid updates)
      const rateLimitKey = `itinerary_notify_${tourId}`;
      if (!checkRateLimit(rateLimitKey, 5, 300000)) { // Max 5 updates per 5 minutes
        log.warn("Itinerary update rate limit exceeded", { tourId });
        return null;
      }

      // 2. Get only fields required for itinerary notifications.
      const [nameSnapshot, isActiveSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once("value"),
        admin.database().ref(`tours/${tourId}/isActive`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tour_manifests/${tourId}`).once("value"),
      ]);

      // Check if tour is active
      if (isActiveSnapshot.val() === false) {
        log.info("Tour is inactive, skipping notification", { tourId });
        return null;
      }

      const tourName = nameSnapshot.val() || "Your Tour";

      const participants = participantsSnapshot.exists() ? (participantsSnapshot.val() || {}) : {};
      const participantIds = Object.keys(participants);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData: manifestSnapshot.val() || {},
        context: { tourId, notificationType: 'itinerary' },
      });
      const recipientIds = [...new Set([...participantIds, ...assignedDriverRecipientIds])];

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
            title: "📅 Itinerary Update",
            body: `The schedule for ${tourName} has been updated. Tap to see the changes.`,
            data: {
              tourId: tourId,
              screen: "Itinerary",
              timestamp: Date.now(),
            },
            priority: "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 4. Clean up invalid tokens (async, don't wait)
      if (invalidTokens.length > 0) {
        Promise.all(invalidTokens.map(({ userId, token }) => removeInvalidToken(userId, token)))
          .catch(err => log.error("Error cleaning invalid tokens", err));
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

exports.__testables = {
  toRealtimeKeySegment,
  resolveChatSenderParticipantIds,
  collectAssignedDriverIds,
  isDriverProfileAssignedToTour,
  resolveAssignedDriverRecipientIds,
  getPushTokenIneligibilityReason,
  shouldRemoveInvalidToken,
  selectNotificationRecipients,
  parseSourcePhotoPath,
  buildPhotoCollectionPath,
  processPhotoVariantObject,
  createPhotoVariantBuffers,
  buildPhotoVariantPaths,
  buildFirebaseStorageDownloadUrl,
  generatePhotoVariantsForRecord,
  sanitizeLogText,
  buildVerifiedLoginGrantUpdates,
  verifyRequestAuthUid,
  buildTourManifestPayload,
  verifyTourManifestAccess,
  normalizeManifestBooking,
  resolveDriverAssignment,
  normalizeAssignedDriverCodeRecord,
};
