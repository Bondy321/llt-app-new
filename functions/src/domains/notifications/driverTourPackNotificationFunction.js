'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { cleanupInvalidTokens } = require('./invalidTokenCleanup');
const { applyRecipientCap } = require('./notificationPolicy');
const {
  fetchUsersSnapshot, filterOperationalRecipientsByActiveSession, selectNotificationRecipients,
} = require('./notificationRecipients');
const { resolveAssignedDriverRecipientIds } = require('./notificationDelivery');
const { deliverPushNotifications } = require('./notificationPushDelivery');
const { buildPushNavigationData, buildTourNotificationRecord } = require('./notificationState');
const { summarizeDriverTourPackChange } = loadLegacyLibrary('driverTourPackOperations');

const NOTIFICATION_RECIPIENT_CAP = 1000;

/** @type {(...args: any[]) => any} */
const resolveDriverTourPackChange = ({ event, departureKey, beforePack, afterPack }) => {
  if (!isValidFirebaseKey(departureKey) || afterPack?.departureKey !== departureKey) {
    log.warn('Driver Tour Pack change trigger rejected invalid identity', { departureKey });
    return null;
  }
  const change = summarizeDriverTourPackChange(beforePack, afterPack, {
    eventId: event.id,
    createdAtMs: Date.now(),
  });
  if (!change) log.info('Skipping metadata-only Driver Tour Pack notification', { departureKey });
  return change;
};

/** @type {(...args: any[]) => any} */
const buildNotificationManifest = ({ manifestData, globalNotificationsEnabled, enabledDriverFlags }) => {
  if (globalNotificationsEnabled) return manifestData;
  return {
    ...manifestData,
    assigned_drivers: Object.fromEntries(Object.entries(manifestData.assigned_drivers || {})
      .filter(([driverId, assigned]) => assigned === true && enabledDriverFlags[driverId] === true)),
  };
};

/** @type {(...args: any[]) => string} */
const resolveDriverTourPackDeliveryStatus = ({
  recipientCount, successCount, errorCount, globalNotificationsEnabled, enabledDriverFlags,
}) => {
  if (recipientCount > 0) {
    if (errorCount === 0) return 'delivered';
    return successCount > 0 ? 'partial' : 'failed';
  }
  return globalNotificationsEnabled || Object.values(enabledDriverFlags).some((enabled) => enabled === true)
    ? 'no_recipients'
    : 'feature_disabled';
};

const sendDriverTourPackChangeNotification = onValueWritten(
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
    const change = resolveDriverTourPackChange({ event, departureKey, beforePack, afterPack });
    if (!change) return null;

    const db = admin.database();
    const changePath = `driver_tour_pack_changes/${departureKey}/latest`;
    const safeChange = {
      ...change,
      changedSections: Object.fromEntries(change.changedSections.map(
        (/** @type {string} */ section) => [section, true],
      )),
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
      const notificationManifest = buildNotificationManifest({
        manifestData, globalNotificationsEnabled, enabledDriverFlags,
      });
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

      const pushMessages = validRecipients.map((/** @type {any} */ { userData }) => ({
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

      const { successCount, errorCount } = await deliverPushNotifications({
        pushMessages,
        validRecipients,
        context: { departureKey },
        chunkErrorEvent: 'Driver Tour Pack notification chunk failed',
        successWhen: (/** @type {any} */ ticket) => ticket?.status === 'ok',
        fallbackRemovalReason: '',
      });

      await db.ref(changePath).update({
        notificationStatus: resolveDriverTourPackDeliveryStatus({
          recipientCount: pushMessages.length,
          successCount,
          errorCount,
          globalNotificationsEnabled,
          enabledDriverFlags,
        }),
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

module.exports = { sendDriverTourPackChangeNotification };
