'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { cleanupInvalidTokens } = require('./invalidTokenCleanup');
const {
  applyRecipientCap, buildSafetyNotificationContent, resolveTrimmedString,
} = require('./notificationPolicy');
const {
  fetchUsersSnapshot, filterOperationalRecipientsByActiveSession, selectNotificationRecipients,
} = require('./notificationRecipients');
const { resolveAssignedDriverRecipientIds } = require('./notificationDelivery');
const { deliverPushNotifications } = require('./notificationPushDelivery');
const { buildPushNavigationData } = require('./notificationState');

const NOTIFICATION_RECIPIENT_CAP = 1000;
const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const SAFETY_CATEGORIES = new Set([
  'delay', 'incident', 'medical', 'lost_passenger', 'vehicle_issue',
  'sos', 'harassment', 'weather', 'custom',
]);
const SAFETY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/** @type {(...args: any[]) => boolean} */
const isValidSafetyAlert = ({ tourId, eventId, alert }) => (
  isValidFirebaseKey(tourId)
  && isValidFirebaseKey(eventId)
  && resolveTrimmedString(alert.tourId) === tourId
  && resolveTrimmedString(alert.status) === 'pending'
  && SAFETY_CATEGORIES.has(resolveTrimmedString(alert.category).toLowerCase())
  && SAFETY_SEVERITIES.has(resolveTrimmedString(alert.severity).toLowerCase())
  && (alert.schemaVersion !== 2 || resolveTrimmedString(alert.eventId) === eventId)
);

/** @param {number} recipientCount @param {number} successCount @param {number} errorCount */
const resolveSafetyDeliveryStatus = (recipientCount, successCount, errorCount) => {
  if (recipientCount === 0) return 'no_recipients';
  if (errorCount === 0) return 'accepted';
  return successCount > 0 ? 'partial' : 'failed';
};

const sendSafetyAlertNotification = onValueCreated(
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
    if (!isValidSafetyAlert({ tourId, eventId, alert })) {
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
      const pushMessages = validRecipients.map((/** @type {any} */ { userId }) => ({
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

      const { successCount, errorCount } = await deliverPushNotifications({
        pushMessages,
        validRecipients,
        context: { tourId, eventId },
        chunkErrorEvent: 'Safety notification chunk failed',
      });

      const deliveryStatus = resolveSafetyDeliveryStatus(pushMessages.length, successCount, errorCount);
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

module.exports = { sendSafetyAlertNotification };
