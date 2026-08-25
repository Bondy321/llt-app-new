'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { cleanupInvalidTokens } = require('./invalidTokenCleanup');
const { applyRecipientCap, chunkArrayDeterministically } = require('./notificationPolicy');
const {
  fetchUsersSnapshot, filterOperationalRecipientsByActiveSession, selectNotificationRecipients,
} = require('./notificationRecipients');
const { resolveAssignedDriverRecipientIds } = require('./notificationDelivery');
const { deliverPushNotifications } = require('./notificationPushDelivery');
const {
  buildPushNavigationData, buildTourNotificationRecord, persistTourNotification, summarizeItineraryChange,
} = require('./notificationState');

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;

/** @type {(...args: any[]) => any} */
const resolveItineraryChangeForNotification = ({ event, tourId }) => {
  if (!isValidFirebaseKey(tourId)) {
    log.error('Invalid tourId path parameter', null, { tourId });
    return null;
  }
  const change = summarizeItineraryChange(
    event.data?.before?.val?.() || {},
    event.data?.after?.val?.() || {},
  );
  if (!change.hasMeaningfulChange) {
    log.info('Skipping metadata-only itinerary notification', { tourId });
    return null;
  }
  if (!checkRateLimit(`itinerary_notify_${tourId}`, 5, 300000)) {
    log.warn('Itinerary update rate limit exceeded', { tourId });
    return null;
  }
  return change;
};

/** @type {(...args: any[]) => any[]} */
const buildItineraryPushMessages = ({
  validRecipients, usersMap, itineraryChange, itineraryNotice, tourId,
}) => {
  const messages = [];
  const chunks = chunkArrayDeterministically(
    validRecipients.map((/** @type {any} */ recipient) => recipient.userId),
    RECIPIENT_CHUNK_SIZE,
  );
  for (const recipientChunk of chunks) {
    for (const userId of recipientChunk) {
      messages.push({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: itineraryChange.title,
        body: itineraryChange.body,
        data: buildPushNavigationData({
          tourId, screen: 'Itinerary', noticeId: itineraryNotice.noticeId, notificationType: 'itinerary',
        }),
        priority: 'default',
        channelId: 'default',
      });
    }
  }
  return messages;
};

const sendItineraryNotification = onValueWritten(
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
      log.info("Processing itinerary update notification", { tourId });
      const itineraryChange = resolveItineraryChangeForNotification({ event, tourId });
      if (!itineraryChange) return null;

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

      const recipientChunks = chunkArrayDeterministically(
        validRecipients.map((/** @type {any} */ recipient) => recipient.userId),
        RECIPIENT_CHUNK_SIZE,
      );
      log.info('Using deterministic recipient chunking for itinerary notifications', {
        tourId,
        chunks: recipientChunks.length,
        chunkSize: RECIPIENT_CHUNK_SIZE,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
      });

      const pushMessages = buildItineraryPushMessages({
        validRecipients, usersMap, itineraryChange, itineraryNotice, tourId,
      });
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

      const pushSendStart = Date.now();
      const { successCount, errorCount } = await deliverPushNotifications({
        pushMessages,
        validRecipients,
        context: { tourId },
        chunkErrorEvent: 'Error sending notification chunk',
        ticketErrorEvent: 'Notification ticket error',
      });
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

module.exports = { sendItineraryNotification };
