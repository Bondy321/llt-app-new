'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
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

/** @type {(...args: any[]) => Promise<any>} */
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

    profileResults.forEach(/** @param {any} result */ ({ driverData }) => {
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

/** @type {(...args: any[]) => Promise<any>} */
const resolveChatSenderDeliveryIds = async (options = {}) => {
  const tourId = options.tourId;
  const participants = defaultValue(options.participants, {});
  const manifestData = defaultValue(options.manifestData, {});
  const messageData = defaultValue(options.messageData, {});
  const loadProfile = defaultValue(options.loadProfile, loadDriverProfile);
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
    const authUid = resolveTrimmedString(driverData.authUid);
    return authUid && isValidFirebaseKey(authUid) ? [authUid] : [];
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
  resolveAssignedDriverRecipientIds,
  resolveChatSenderDeliveryIds,
  verifyParticipant,
};
