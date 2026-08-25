'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { cleanupInvalidTokens } = require('./invalidTokenCleanup');
const {
  applyRecipientCap, isSupportedTourNotificationCategory, removeInvalidToken,
  resolveTourNotificationCategoryLabel, userWantsTourCategoryBroadcast,
} = require('./notificationPolicy');
const {
  collectExpoTokenFailures, selectNotificationRecipients, setCachedUserProfile,
} = require('./notificationRecipients');
const { buildCategoryBroadcastPushMessages } = require('./notificationDelivery');
const { buildTourNotificationRecord, persistTourNotification } = require('./notificationState');

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;
/** @type {Record<string, string[]>} */
const LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS = {
  mystery_breaks: ['mystery_tours'],
  scotland_highlands_islands: ['scotland_classics', 'hiking_nature'],
  steam_train_tours: ['steam_trains'],
};

/** @type {(...args: any[]) => any} */
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

/** @type {(...args: any[]) => any} */
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

/** @type {(...args: any[]) => string} */
const resolveBroadcastDeliveryStatus = ({ successCount = 0, errorCount = 0, recipientCount = 0 } = {}) => {
  if (recipientCount <= 0) return 'no_recipients';
  if (successCount > 0 && errorCount > 0) return 'partial';
  if (successCount > 0) return 'delivered';
  return 'failed';
};

/** @type {(...args: any[]) => Promise<void>} */
const updateBroadcastDelivery = async ({ root, targetId, broadcastId, status, details = {} }) => {
  if (!isValidFirebaseKey(targetId) || !isValidFirebaseKey(broadcastId)) return;
  const now = Date.now();
  const payload = /** @type {Record<string, any>} */ ({
    deliveryStatus: status,
    deliveryUpdatedAtMs: now,
    ...details,
  });
  if (BROADCAST_TERMINAL_STATUSES.has(status)) payload.deliveryCompletedAtMs = now;
  await admin.database().ref(`${root}/${targetId}/${broadcastId}`).update(payload);
};

/** @type {(...args: any[]) => Promise<Record<string, any>>} */
const fetchCategoryBroadcastUsers = async (categoryKey, context = {}) => {
  /** @type {Record<string, any>} */
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
const processBroadcastWrite = onValueCreated(
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
const processCategoryBroadcastWrite = onValueCreated(
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
        preferenceResolver: (/** @type {any} */ userData) => userWantsTourCategoryBroadcast(userData, categoryKey),
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

      const expo = getExpoPushClient();
      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          ticketChunk.forEach((/** @type {any} */ ticket) => {
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
              const recipient = validRecipients.find((/** @type {any} */ candidate) => (
                candidate?.userData?.pushToken === token
              ));
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

module.exports = {
  processBroadcastWrite,
  processCategoryBroadcastWrite,
  resolveBroadcastDeliveryStatus,
  updateBroadcastDelivery,
  validateBroadcastData,
  validateCategoryBroadcastData,
};
