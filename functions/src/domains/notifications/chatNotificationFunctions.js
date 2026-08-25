'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { checkRateLimit } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { cleanupInvalidTokens } = require('./invalidTokenCleanup');
const { verifyAdminBroadcast } = require('./adminBroadcastAuthorization');
const { resolveBroadcastDeliveryStatus, updateBroadcastDelivery } = require('./broadcastFunctions');
const {
  applyRecipientCap, buildChatNotificationContent, chunkArrayDeterministically,
  removeInvalidToken, resolveTrimmedString, toRealtimeKeySegment, validateMessageData,
} = require('./notificationPolicy');
const {
  collectExpoTokenFailures, fetchUsersSnapshot, filterOperationalRecipientsByActiveSession,
  selectNotificationRecipients,
} = require('./notificationRecipients');
const {
  isAdminBroadcast, resolveAssignedDriverRecipientIds, resolveChatSenderDeliveryIds,
} = require('./notificationDelivery');
const { buildPushNavigationData, buildTourNotificationId } = require('./notificationState');

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;

/** @type {(...args: any[]) => any} */
const createTrackedBroadcastUpdater = ({ trackedBroadcastId, tourId }) => (
  (/** @type {string} */ status, details = {}) => (
    trackedBroadcastId
      ? updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId: trackedBroadcastId, status, details })
      : Promise.resolve()
  )
);

/** @type {(...args: any[]) => Promise<any>} */
const validateChatNotificationEvent = async ({ event, tourId, messageId, updateTrackedBroadcast }) => {
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) {
    log.error('Invalid path parameters', null, { tourId, messageId });
    return null;
  }
  if (!event.data) {
    log.warn('No data associated with event', { tourId, messageId });
    return null;
  }
  const messageData = event.data.val?.() || {};
  const validation = validateMessageData(messageData);
  if (!validation.valid) {
    log.error('Invalid message data', { errors: validation.errors }, { tourId, messageId });
    await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_CHAT_MESSAGE' });
    return null;
  }
  const { senderId, senderName } = messageData;
  if (!checkRateLimit(`chat_notify_${tourId}_${senderId}`, 20, 60000)) {
    log.warn('Rate limit exceeded', { tourId, senderId });
    if (isAdminBroadcast(senderId)) {
      await updateTrackedBroadcast('failed', { deliveryErrorCode: 'RATE_LIMITED' });
    }
    return null;
  }
  const isAdmin = isAdminBroadcast(senderId);
  if (isAdmin && !(await verifyAdminBroadcast(messageData))) {
    log.error('Spoofed admin broadcast rejected - invalid or missing senderUid', null, { tourId, senderId });
    await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_AUTHOR' });
    return null;
  }
  return { isAdmin, messageData, senderId, senderName };
};

/** @type {(...args: any[]) => Promise<any>} */
const resolveChatNotificationAudience = async ({ tourId, messageId, messageData, senderId, isAdmin }) => {
  const [tourNameSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
    admin.database().ref(`tours/${tourId}/name`).once('value'),
    admin.database().ref(`tours/${tourId}/participants`).once('value'),
    admin.database().ref(`tour_manifests/${tourId}`).once('value'),
  ]);
  const tourName = tourNameSnapshot.val() || 'Tour Chat';
  const participants = participantsSnapshot.val() || {};
  const manifestData = manifestSnapshot.val() || {};
  const participantIds = Object.keys(participants);
  const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
    tourId, manifestData, context: { tourId, messageId, notificationType: 'chat' },
  });
  let senderDeliveryIds = isAdmin ? [] : await resolveChatSenderDeliveryIds({
    tourId,
    participants,
    manifestData,
    messageData,
    context: { tourId, messageId, notificationType: 'chat' },
  });
  if (!isAdmin) {
    senderDeliveryIds = await filterOperationalRecipientsByActiveSession({
      recipientIds: senderDeliveryIds, tourId, participants,
    });
  }
  if (!isAdmin && senderDeliveryIds.length === 0) {
    log.error('Sender is not an active participant or assigned driver of the tour', null, {
      tourId,
      senderId,
      senderStableId: toRealtimeKeySegment(messageData.senderStableId),
    });
    return null;
  }
  const audienceIds = [...new Set([...participantIds, ...assignedDriverRecipientIds])];
  const activeAudienceIds = await filterOperationalRecipientsByActiveSession({
    recipientIds: audienceIds, tourId, participants,
  });
  const cappedParticipantIds = applyRecipientCap(activeAudienceIds, NOTIFICATION_RECIPIENT_CAP, {
    tourId, notificationType: 'chat',
  });
  const fetchUsersStart = Date.now();
  const usersMap = await fetchUsersSnapshot(cappedParticipantIds, { tourId, notificationType: 'chat' });
  const { validRecipients, invalidTokens } = selectNotificationRecipients({
    participantIds: cappedParticipantIds,
    usersMap,
    preferencePath: ['preferences', 'ops', isAdmin ? 'driver_updates' : 'group_chat'],
    senderId,
    senderParticipantIds: senderDeliveryIds,
    excludeSender: true,
    context: { tourId, notificationType: 'chat' },
  });
  return {
    assignedDriverRecipientIds,
    invalidTokens,
    participantIds,
    tourName,
    userFetchDurationMs: Date.now() - fetchUsersStart,
    usersMap,
    validRecipients,
  };
};

/** @type {(...args: any[]) => any[]} */
const buildChatPushMessages = ({
  validRecipients, usersMap, messageData, tourName, isAdmin, trackedBroadcastId, tourId, messageId,
}) => {
  const content = buildChatNotificationContent({ messageData, tourName, isAdmin });
  const messages = [];
  const recipientChunks = chunkArrayDeterministically(
    validRecipients.map((/** @type {any} */ recipient) => recipient.userId),
    RECIPIENT_CHUNK_SIZE,
  );
  log.info('Using deterministic recipient chunking for chat notifications', {
    tourId, chunks: recipientChunks.length, chunkSize: RECIPIENT_CHUNK_SIZE,
  });
  for (const recipientChunk of recipientChunks) {
    for (const userId of recipientChunk) {
      messages.push({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: content.title,
        body: content.body,
        data: buildPushNavigationData({
          tourId,
          screen: 'Chat',
          messageId,
          noticeId: isAdmin && trackedBroadcastId
            ? buildTourNotificationId({ type: 'announcement', tourId, sourceId: trackedBroadcastId })
            : null,
          notificationType: isAdmin ? 'announcement' : 'chat_message',
        }),
        priority: isAdmin ? 'high' : 'default',
        channelId: 'default',
      });
    }
  }
  return messages;
};

/** @type {(...args: any[]) => Promise<any>} */
const deliverChatPushMessages = async ({ pushMessages, validRecipients, tourId }) => {
  const chunks = getExpoPushClient().chunkPushNotifications(pushMessages);
  let successCount = 0;
  let errorCount = 0;
  for (const chunk of chunks) {
    try {
      const tickets = await getExpoPushClient().sendPushNotificationsAsync(chunk);
      const failures = collectExpoTokenFailures(tickets, chunk);
      tickets.forEach((/** @type {any} */ ticket) => {
        if (ticket.status === 'error') {
          errorCount += 1;
          log.error('Notification ticket error', { error: ticket.message, details: ticket.details }, { tourId });
        } else successCount += 1;
      });
      await Promise.all(failures.map(async ({ token, errorCode }) => {
        const recipient = validRecipients.find((/** @type {any} */ candidate) => (
          candidate?.userData?.pushToken === token
        ));
        if (recipient?.userId) {
          await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
        }
      }));
    } catch (chunkError) {
      errorCount += chunk.length;
      log.error('Error sending notification chunk', chunkError, { tourId, chunkSize: chunk.length });
    }
  }
  return { successCount, errorCount };
};

const sendChatNotification = onValueCreated(
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
    const updateTrackedBroadcast = createTrackedBroadcastUpdater({ trackedBroadcastId, tourId });

    try {
      const validated = await validateChatNotificationEvent({ event, tourId, messageId, updateTrackedBroadcast });
      if (!validated) return null;
      const { isAdmin, messageData, senderId, senderName } = validated;
      log.info('Processing chat notification', { tourId, senderId, senderName, isAdmin });
      const audience = await resolveChatNotificationAudience({ tourId, messageId, messageData, senderId, isAdmin });
      if (!audience) return null;
      const assemblyStart = Date.now();
      const pushMessages = buildChatPushMessages({
        ...audience, messageData, isAdmin, trackedBroadcastId, tourId, messageId,
      });
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;
      if (audience.invalidTokens.length > 0) await cleanupInvalidTokens(audience.invalidTokens);
      if (pushMessages.length === 0) {
        log.info('No valid recipients found', { tourId });
        if (isAdmin) await updateTrackedBroadcast('no_recipients', { recipientCount: 0, successCount: 0, errorCount: 0 });
        return null;
      }
      const pushSendStart = Date.now();
      const { successCount, errorCount } = await deliverChatPushMessages({
        pushMessages, validRecipients: audience.validRecipients, tourId,
      });
      const pushSendDurationMs = Date.now() - pushSendStart;
      const duration = Date.now() - startTime;
      if (isAdmin) {
        await updateTrackedBroadcast(
          resolveBroadcastDeliveryStatus({ successCount, errorCount, recipientCount: pushMessages.length }),
          { recipientCount: pushMessages.length, successCount, errorCount },
        );
      }
      log.info('Chat notification completed', {
        tourId,
        recipients: pushMessages.length,
        passengerRecipientCount: audience.participantIds.length,
        assignedDriverRecipientCount: audience.assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        isAdminBroadcast: isAdmin,
        userFetchDurationMs: audience.userFetchDurationMs,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`
      });

      return null;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendChatNotification", error, { tourId, messageId, duration: `${duration}ms` });
      await updateTrackedBroadcast('failed', { deliveryErrorCode: 'NOTIFICATION_FAILED' })
        .catch((/** @type {any} */ statusError) => (
          log.error('Failed to persist tour broadcast failure status', statusError, { tourId, messageId })
        ));
      return null;
    }
  },
);

/** Notify the other assigned drivers when an internal driver-chat message is created. */
const sendInternalChatNotification = onValueCreated(
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
      const pushMessages = validRecipients.map((/** @type {any} */ { userId }) => ({
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
      const expo = getExpoPushClient();
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          const deviceFailures = collectExpoTokenFailures(tickets, chunk);
          successCount += tickets.filter((/** @type {any} */ ticket) => ticket.status !== 'error').length;
          errorCount += tickets.filter((/** @type {any} */ ticket) => ticket.status === 'error').length;
          await Promise.all(deviceFailures.map(async ({ token, errorCode }) => {
            const recipient = validRecipients.find((/** @type {any} */ candidate) => (
              candidate?.userData?.pushToken === token
            ));
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

module.exports = { sendChatNotification, sendInternalChatNotification };
