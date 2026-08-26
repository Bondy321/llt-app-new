'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { verifyAdminBroadcast } = require('./adminBroadcastAuthorization');
const { isAdminBroadcast } = require('./notificationDelivery');
const { validateMessageData } = require('./notificationPolicy');
const { enqueueNotificationJob } = require('./notificationJobs');
const {
  buildChatNotificationJob,
  buildInternalChatNotificationJob,
} = require('./notificationProducerJobs');

/** @param {any} event @param {boolean} internal */
const enqueueChatEvent = async (event, internal = false) => {
  const tourId = event.params.tourId;
  const messageId = event.params.messageId;
  const messageData = event.data?.val?.() || {};
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) {
    log.warn('Notification source rejected invalid chat identity', { tourId, messageId, internal });
    return null;
  }
  const validation = validateMessageData(messageData);
  if (!validation.valid || (internal && messageData.isDriver !== true)) {
    log.warn('Notification source rejected invalid chat message', {
      tourId, messageId, internal, errors: validation.errors,
    });
    return null;
  }
  const isAdmin = !internal && isAdminBroadcast(messageData.senderId);
  if (isAdmin && !(await verifyAdminBroadcast(messageData))) {
    log.warn('Notification source rejected unauthorised admin announcement', { tourId, messageId });
    return null;
  }
  const tourName = (await admin.database().ref(`tours/${tourId}/name`).once('value')).val() || 'Tour Chat';
  const nowMs = Date.now();
  const job = internal
    ? buildInternalChatNotificationJob({ tourId, messageId, messageData, tourName, nowMs })
    : buildChatNotificationJob({ tourId, messageId, messageData, tourName, isAdmin, nowMs });
  const result = await enqueueNotificationJob({ job });
  if (isAdmin && messageData.broadcastId) {
    await admin.database().ref(`broadcasts/${tourId}/${messageData.broadcastId}`).update({
      deliveryStatus: 'queued',
      deliveryJobId: result.jobId,
      deliveryUpdatedAtMs: nowMs,
    });
  }
  log.info('Notification source enqueued durable chat job', {
    jobId: result.jobId,
    notificationType: job.notificationType,
    created: result.created,
    tourId,
  });
  return { jobId: result.jobId, created: result.created };
};

const sendChatNotification = onValueCreated({
  ref: '/chats/{tourId}/messages/{messageId}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
}, (event) => enqueueChatEvent(event, false));

const sendInternalChatNotification = onValueCreated({
  ref: '/internal_chats/{tourId}/messages/{messageId}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
}, (event) => enqueueChatEvent(event, true));

module.exports = {
  enqueueChatEvent,
  sendChatNotification,
  sendInternalChatNotification,
};
