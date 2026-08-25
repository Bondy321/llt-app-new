'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  chunkArrayDeterministically,
  getPreferenceValue,
  getPushTokenIneligibilityReason,
  isValidPushToken,
  normalizePushToken,
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('./notificationPolicy');
const { isActiveSessionRecord } = loadLegacyLibrary('appSession');

const USER_PROFILE_FETCH_CHUNK_SIZE = 100;
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_PROFILE_CACHE_MAX_ENTRIES = 5000;
const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
/** @type {Map<string, { cachedAt: number, profile: any }>} */
const userProfileCache = new Map();

/** @type {(...args: any[]) => any} */
const getCachedUserProfile = (userId) => {
  const cached = userProfileCache.get(userId);
  if (!cached) return null;

  if ((Date.now() - cached.cachedAt) > USER_PROFILE_CACHE_TTL_MS) {
    userProfileCache.delete(userId);
    return null;
  }

  return cached.profile;
};

/** @type {(...args: any[]) => any} */
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

/** @type {(...args: any[]) => any} */
const enforceUserProfileCacheCap = () => {
  if (userProfileCache.size <= USER_PROFILE_CACHE_MAX_ENTRIES) {
    return 0;
  }

  const targetSize = Math.floor(USER_PROFILE_CACHE_MAX_ENTRIES * 0.9);
  const entriesByAge = [...userProfileCache.entries()].sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
  const evictCount = Math.max(0, userProfileCache.size - targetSize);

  for (let index = 0; index < evictCount; index += 1) {
    const entry = entriesByAge[index];
    if (!entry) break;
    const [userId] = entry;
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

/** @type {(...args: any[]) => any} */
const setCachedUserProfile = (userId, profile) => {
  cleanupUserProfileCache();

  userProfileCache.set(userId, {
    profile,
    cachedAt: Date.now(),
  });

  enforceUserProfileCacheCap();
};

/** @type {(participantIds?: string[], context?: Record<string, unknown>) => Promise<Record<string, any>>} */
const fetchUsersSnapshot = async (participantIds = [], context = {}) => {
  /** @type {Record<string, any>} */
  const usersMap = {};
  /** @type {string[]} */
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
      chunk.map(/** @param {string} userId */ (userId) => admin.database().ref(`users/${userId}`).once('value')),
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

/** @type {(options?: any) => Promise<string[]>} */
const filterOperationalRecipientsByActiveSession = async ({
  recipientIds = [],
  tourId,
  participants = {},
  allowOperationsAdmins = false,
  db = admin.database(),
} = {}) => {
  const uniqueIds = [...new Set(recipientIds.filter(/** @param {string} uid */ (uid) => isValidFirebaseKey(uid)))];
  /** @type {string[]} */
  const allowed = [];
  for (const chunk of chunkArrayDeterministically(uniqueIds, USER_PROFILE_FETCH_CHUNK_SIZE)) {
    const snapshots = await Promise.all(chunk.map(/** @param {string} uid */ (uid) => db.ref(`app_sessions/${uid}`).once('value')));
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

/** @type {(options: any) => any} */
const evaluateNotificationRecipient = ({
  userId,
  usersMap,
  preferencePath,
  preferenceResolver,
  excludeSender,
  excludedSenderIds,
  excludedPushTokens,
  seenPushTokens,
  context,
}) => {
  if (excludeSender && excludedSenderIds.has(userId)) return { outcome: 'skipped' };
  const userData = usersMap[userId];
  const pushToken = normalizePushToken(userData?.pushToken);
  if (!userData || !pushToken) {
    log.info('No token for user', { ...context, userId });
    return { outcome: 'skipped' };
  }
  const ineligibilityReason = getPushTokenIneligibilityReason(userData);
  if (ineligibilityReason) {
    log.info('Skipping unavailable push recipient', { ...context, userId, reason: ineligibilityReason });
    return { outcome: 'skipped' };
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
    return { outcome: 'skipped' };
  }
  if (!isValidPushToken(pushToken)) {
    log.warn('Invalid push token', { ...context, userId });
    return { outcome: 'invalid', invalidToken: { userId, token: pushToken } };
  }
  if (excludeSender && excludedPushTokens.has(pushToken)) return { outcome: 'excluded_sender_token' };
  if (seenPushTokens.has(pushToken)) return { outcome: 'duplicate' };
  seenPushTokens.add(pushToken);
  return { outcome: 'valid', recipient: { userId, userData: { ...userData, pushToken } } };
};

/** @type {(...args: any[]) => any} */
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
    const selection = evaluateNotificationRecipient({
      userId, usersMap, preferencePath, preferenceResolver, excludeSender,
      excludedSenderIds, excludedPushTokens, seenPushTokens, context,
    });
    if (selection.outcome === 'valid') validRecipients.push(selection.recipient);
    if (selection.outcome === 'invalid') invalidTokens.push(selection.invalidToken);
    if (selection.outcome === 'excluded_sender_token') excludedSenderTokenRecipientCount += 1;
    if (selection.outcome === 'duplicate') duplicateTokenRecipientCount += 1;
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

/** @type {(ticketChunk?: any[], messageChunk?: any[]) => any[]} */
const collectExpoTokenFailures = (ticketChunk = [], messageChunk = []) => {
  /** @type {any[]} */
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

/** @type {(principalId: string) => Promise<any>} */
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

/** @type {(options?: any) => Promise<string[]>} */
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return [...senderParticipantIds];
};

/** @type {(...args: any[]) => any} */
const collectAssignedDriverIds = (manifestData = {}) => {
  const driverIds = new Set();

  /** @param {string} driverId @param {unknown} value */
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

/** @type {(...args: any[]) => any} */
const isDriverProfileAssignedToTour = (driverData = {}, tourId) => {
  const expectedTourId = normalizeTourKeyForComparison(tourId);
  const currentTourId = normalizeTourKeyForComparison(driverData?.currentTourId);

  return Boolean(currentTourId && currentTourId === expectedTourId);
};


module.exports = {
  collectAssignedDriverIds,
  collectExpoTokenFailures,
  fetchUsersSnapshot,
  filterOperationalRecipientsByActiveSession,
  isDriverProfileAssignedToTour,
  loadIdentityBindingsForPrincipal,
  resolveChatSenderParticipantIds,
  selectNotificationRecipients,
};
