'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  collectAssignedDriverIds,
  isDriverProfileAssignedToTour,
  loadIdentityBindingsForPrincipal,
  resolveChatSenderParticipantIds,
} = require('./notificationRecipients');
const { buildPushNavigationData } = require('./notificationState');
const {
  chunkArrayDeterministically,
  isSupportedTourNotificationCategory,
  resolveTourNotificationCategoryLabel,
  resolveTrimmedString,
} = require('./notificationPolicy');
const {
  driverBindingAllowedByPolicy,
  driverSessionMatchesPolicyGeneration,
  readDriverLoginPolicy,
} = require('../driver-auth/public');

const { isActiveSessionRecord } = loadLegacyLibrary('appSession');

const USER_PROFILE_FETCH_CHUNK_SIZE = 100;

/** @param {any} value @param {any} fallback */
const defaultValue = (value, fallback) => (value === undefined ? fallback : value);

/** @type {(...args: any[]) => any} */
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

/** @type {(...args: any[]) => Promise<any>} */
const loadDriverProfile = async (driverId) => {
  const snapshot = await admin.database().ref(`drivers/${driverId}`).once('value');
  return snapshot.val() || null;
};

/** @type {(...args: any[]) => Promise<string[]>} */
const loadDriverSessionAuthUids = async (driverId, { tourId, driverData, db = admin.database(), nowMs = Date.now() }) => {
  const [sessionsSnapshot, policyContext] = await Promise.all([
    db.ref('app_sessions').orderByChild('driverId').equalTo(driverId).once('value'),
    readDriverLoginPolicy({ db }),
  ]);
  const candidates = Object.entries(sessionsSnapshot.val() || {});
  const results = await Promise.all(candidates.map(async ([authUid, sessionValue]) => {
    const session = /** @type {any} */ (sessionValue);
    if (!isValidFirebaseKey(authUid)
      || !isActiveSessionRecord(session, { nowMs })
      || session.authUid !== authUid
      || session.principalType !== 'driver'
      || session.driverId !== driverId
      || session.tourId !== tourId
      || !driverSessionMatchesPolicyGeneration(session, policyContext.policy)
      || !driverBindingAllowedByPolicy({
        policy: policyContext.policy, authUid, claimedAuthUid: driverData?.authUid,
      })) return null;
    const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
    return profile.driverId === driverId
      && profile.driverPrincipalId === session.principalId
      && profile.principalType === 'driver'
      && profile.driverAssignedTourId === tourId
      ? authUid
      : null;
  }));
  return results.filter(Boolean).sort((left, right) => left.localeCompare(right));
};

/** @type {(...args: any[]) => Promise<any>} */
const resolveAssignedDriverRecipientIds = async ({
  tourId,
  manifestData = {},
  loadProfile = loadDriverProfile,
  loadSessionAuthUids = loadDriverSessionAuthUids,
  context = {},
}) => {
  const driverIds = collectAssignedDriverIds(manifestData);
  const recipientIds = new Set();
  const driverChunks = chunkArrayDeterministically(driverIds, USER_PROFILE_FETCH_CHUNK_SIZE);

  for (const chunk of driverChunks) {
    const profileResults = await Promise.all(chunk.map(async (/** @type {string} */ driverId) => {
      try {
        return {
          driverId,
          driverData: await loadProfile(driverId),
        };
      } catch (error) {
        log.warn('Failed to load assigned driver profile for notification fanout', {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
        return { driverId, driverData: null };
      }
    }));

    for (const { driverId, driverData } of profileResults) {
      if (!driverData || typeof driverData !== 'object') {
        continue;
      }

      if (!isDriverProfileAssignedToTour(driverData, tourId)) {
        continue;
      }
      try {
        const sessionUids = await loadSessionAuthUids(driverId, { tourId, driverData });
        sessionUids.forEach((authUid) => recipientIds.add(authUid));
      } catch (error) {
        log.warn('Failed to resolve assigned driver sessions for notification fanout', {
          ...context,
          driverId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  log.info('Resolved assigned driver notification recipients', {
    ...context,
    assignedDriverCount: driverIds.length,
    assignedDriverRecipientCount: recipientIds.size,
  });

  return [...recipientIds].sort((a, b) => a.localeCompare(b));
};

/** @type {(...args: any[]) => Promise<any>} */
const resolveChatSenderDeliveryIds = async (options = {}) => {
  const tourId = options.tourId;
  const participants = defaultValue(options.participants, {});
  const manifestData = defaultValue(options.manifestData, {});
  const messageData = defaultValue(options.messageData, {});
  const loadProfile = defaultValue(options.loadProfile, loadDriverProfile);
  const loadSessionAuthUids = defaultValue(options.loadSessionAuthUids, loadDriverSessionAuthUids);
  const loadIdentityBindings = defaultValue(options.loadIdentityBindings, loadIdentityBindingsForPrincipal);
  const context = defaultValue(options.context, {});
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
    return loadSessionAuthUids(driverId, { tourId, driverData });
  } catch (error) {
    log.warn('Failed to resolve chat sender driver profile', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

/**
 * Verifies user is a participant of the tour
 */
/** @type {(...args: any[]) => Promise<any>} */
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
/** @type {(...args: any[]) => any} */
const isAdminBroadcast = (senderId) => {
  return senderId && (
    senderId === 'admin_hq_broadcast' ||
    senderId.startsWith('admin_') ||
    senderId.startsWith('hq_')
  );
};


module.exports = {
  buildCategoryBroadcastPushMessages,
  isAdminBroadcast,
  loadDriverProfile,
  loadDriverSessionAuthUids,
  resolveAssignedDriverRecipientIds,
  resolveChatSenderDeliveryIds,
  verifyParticipant,
};
