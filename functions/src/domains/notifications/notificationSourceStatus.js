'use strict';

// @ts-check

const buildDelivery = (job, nowMs) => {
  const counts = job.counts || {};
  const delivery = {
    deliveryStatus: job.status,
    deliveryJobId: job.jobId,
    deliveryUpdatedAtMs: nowMs,
    recipientCount: Number(counts.eligible || 0),
    successCount: Number(counts.receiptAccepted || counts.ticketAccepted || 0),
    errorCount: Number(counts.receiptRejected || counts.ticketRejected || 0),
    skipReasons: job.skipReasons || {},
  };
  if (['provider_accepted', 'provider_rejected', 'partial', 'expired', 'no_recipients'].includes(job.status)) {
    delivery.deliveryCompletedAtMs = nowMs;
  }
  return delivery;
};
const syncBroadcastStatus = (db, job, delivery, _nowMs) => db.ref(`broadcasts/${job.tourId}/${job.navigation.messageId}`).update(delivery);
const syncMarketingStatus = (db, job, delivery, nowMs) => Promise.all([db.ref(`category_broadcasts/${job.categoryKey}/${job.navigation.broadcastId}`).update(delivery), db.ref(`marketing_notification_details/${job.navigation.broadcastId}`).update({ deliveryStatus: job.status, updatedAtMs: nowMs })]);
const syncPackStatus = (db, job, delivery, nowMs) => db.ref(`driver_tour_pack_changes/${job.departureKey}/latest`).update({
      notificationStatus: job.status,
      notificationRecipientCount: delivery.recipientCount,
      notificationSuccessCount: delivery.successCount,
      notificationErrorCount: delivery.errorCount,
      notificationSkipReasons: delivery.skipReasons,
      notificationUpdatedAtMs: nowMs,
      deliveryJobId: job.jobId,
    });
const buildSafetyDeliveryUpdate = (job, delivery, nowMs) => ({
      notificationDeliveryStatus: job.status,
      notificationDeliveryJobId: job.jobId,
      notificationRecipientCount: delivery.recipientCount,
      notificationSuccessCount: delivery.successCount,
      notificationErrorCount: delivery.errorCount,
      notificationSkipReasons: delivery.skipReasons,
      notificationUpdatedAtMs: nowMs,
    });
const buildSafetyDeliveryPaths = (job, update) => Object.fromEntries(Object.entries(update).flatMap(([key, value]) => [
      [`tours/${job.tourId}/safetyAlerts/${job.eventId}/${key}`, value],
      ...(job.sourceType === 'critical_safety_event'
        ? [[`globalSafetyAlerts/${job.eventId}/${key}`, value]]
        : []),
    ]));
const syncSafetyStatus = async (db, job, delivery, nowMs) => {
  const update = buildSafetyDeliveryUpdate(job, delivery, nowMs);
  const paths = buildSafetyDeliveryPaths(job, update);
  await db.ref().update(paths);
};
const syncers = {
  tour_announcement: (db, job, delivery, nowMs) => (job.tourId && job.navigation?.messageId ? syncBroadcastStatus(db, job, delivery, nowMs) : null),
  future_tour_category_broadcast: (db, job, delivery, nowMs) => (job.categoryKey && job.navigation?.broadcastId ? syncMarketingStatus(db, job, delivery, nowMs) : null),
  driver_tour_pack_revision: (db, job, delivery, nowMs) => (job.departureKey ? syncPackStatus(db, job, delivery, nowMs) : null),
  safety_event: (db, job, delivery, nowMs) => (job.tourId && job.eventId ? syncSafetyStatus(db, job, delivery, nowMs) : null),
  critical_safety_event: (db, job, delivery, nowMs) => (job.tourId && job.eventId ? syncSafetyStatus(db, job, delivery, nowMs) : null),
};
/** @param {any} db @param {any} job @param {number} nowMs */
const syncNotificationSourceStatus = async (db, job, nowMs = Date.now()) => {
  if (!job?.jobId || !job?.status) return;
  const delivery = buildDelivery(job, nowMs);
  const sync = syncers[job.sourceType];
  if (sync) return sync(db, job, delivery, nowMs);
};

module.exports = { syncNotificationSourceStatus };
