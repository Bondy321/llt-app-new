'use strict';

// @ts-check

const buildDelivery = (job, nowMs) => {
  const counts = job.counts || {};
  const providerAccepted = Number(counts.receiptAccepted || 0);
  const rejected = Number(counts.receiptRejected || 0) + Number(counts.ticketRejected || 0) + Number(counts.submissionUnknown || 0);
  const delivery = {
    deliveryStatus: job.status,
    deliveryJobId: job.jobId,
    deliveryUpdatedAtMs: nowMs,
    recipientCount: Number(counts.eligible || 0),
    ticketAcceptedCount: Number(counts.ticketAccepted || 0),
    receiptPendingCount: Number(counts.receiptPending || 0),
    providerAcceptedCount: providerAccepted,
    successCount: providerAccepted,
    rejectedCount: rejected,
    errorCount: rejected,
    skipReasons: job.skipReasons || {},
  };
  if (['provider_accepted', 'provider_rejected', 'partial', 'expired', 'no_recipients'].includes(job.status)) {
    delivery.deliveryCompletedAtMs = nowMs;
  }
  return delivery;
};
const guardedDeliveryMerge = (ref, jobId, patch) => ref.transaction((current) => {
  if (!current) return current;
  if (current.deliveryJobId && current.deliveryJobId !== jobId) return current;
  if (current.notificationDeliveryJobId && current.notificationDeliveryJobId !== jobId) return current;
  return { ...current, ...patch };
});
const syncBroadcastStatus = (db, job, delivery, _nowMs) => guardedDeliveryMerge(db.ref(`broadcasts/${job.tourId}/${job.navigation.messageId}`), job.jobId, delivery);
const syncMarketingStatus = (db, job, delivery, nowMs) => Promise.all([guardedDeliveryMerge(db.ref(`category_broadcasts/${job.categoryKey}/${job.navigation.broadcastId}`), job.jobId, delivery), guardedDeliveryMerge(db.ref(`marketing_notification_details/${job.navigation.broadcastId}`), job.jobId, { deliveryStatus: job.status, updatedAtMs: nowMs })]);
const syncPackStatus = (db, job, delivery, nowMs) => guardedDeliveryMerge(db.ref(`driver_tour_pack_changes/${job.departureKey}/latest`), job.jobId, {
      notificationStatus: job.status,
      notificationRecipientCount: delivery.recipientCount,
      notificationTicketAcceptedCount: delivery.ticketAcceptedCount,
      notificationReceiptPendingCount: delivery.receiptPendingCount,
      notificationProviderAcceptedCount: delivery.providerAcceptedCount,
      notificationSuccessCount: delivery.successCount,
      notificationRejectedCount: delivery.rejectedCount,
      notificationErrorCount: delivery.errorCount,
      notificationSkipReasons: delivery.skipReasons,
      notificationUpdatedAtMs: nowMs,
      deliveryJobId: job.jobId,
    });
const buildSafetyDeliveryUpdate = (job, delivery, nowMs) => ({
      notificationDeliveryStatus: job.status,
      notificationDeliveryJobId: job.jobId,
      notificationRecipientCount: delivery.recipientCount,
      notificationTicketAcceptedCount: delivery.ticketAcceptedCount,
      notificationReceiptPendingCount: delivery.receiptPendingCount,
      notificationProviderAcceptedCount: delivery.providerAcceptedCount,
      notificationSuccessCount: delivery.successCount,
      notificationRejectedCount: delivery.rejectedCount,
      notificationErrorCount: delivery.errorCount,
      notificationSkipReasons: delivery.skipReasons,
      notificationUpdatedAtMs: nowMs,
    });
const syncSafetyStatus = async (db, job, delivery, nowMs) => {
  const update = buildSafetyDeliveryUpdate(job, delivery, nowMs);
  await Promise.all([
    guardedDeliveryMerge(db.ref(`tours/${job.tourId}/safetyAlerts/${job.eventId}`), job.jobId, update),
    ...(job.sourceType === 'critical_safety_event'
      ? [guardedDeliveryMerge(db.ref(`globalSafetyAlerts/${job.eventId}`), job.jobId, update)]
      : []),
    ...(job.senderAuthUid
      ? [guardedDeliveryMerge(db.ref(`logs/${job.senderAuthUid}/safety/${job.eventId}`), job.jobId, update)]
      : []),
  ]);
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
