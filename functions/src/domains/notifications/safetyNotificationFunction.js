'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { resolveTrimmedString } = require('./notificationPolicy');
const { enqueueNotificationJob } = require('./notificationJobs');
const { buildSafetyNotificationJob } = require('./notificationProducerJobs');

const SAFETY_CATEGORIES = new Set([
  'delay', 'incident', 'medical', 'lost_passenger', 'vehicle_issue',
  'sos', 'harassment', 'weather', 'custom',
]);
const SAFETY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/** @param {any} input */
const isValidSafetyAlert = ({ tourId, eventId, alert }) => (
  isValidFirebaseKey(tourId)
  && isValidFirebaseKey(eventId)
  && resolveTrimmedString(alert.tourId) === tourId
  && resolveTrimmedString(alert.status) === 'pending'
  && SAFETY_CATEGORIES.has(resolveTrimmedString(alert.category).toLowerCase())
  && SAFETY_SEVERITIES.has(resolveTrimmedString(alert.severity).toLowerCase())
  && (alert.schemaVersion !== 2 || resolveTrimmedString(alert.eventId) === eventId)
);

/** @param {any} event */
const enqueueSafetyEvent = async (event) => {
  const tourId = event.params.tourId;
  const eventId = event.params.eventId;
  const alert = event.data?.val?.() || {};
  if (!isValidSafetyAlert({ tourId, eventId, alert })) {
    log.warn('Notification source rejected invalid safety alert', { tourId, eventId });
    return null;
  }
  const db = admin.database();
  const nowMs = Date.now();
  const tourName = (await db.ref(`tours/${tourId}/name`).once('value')).val() || tourId;
  const job = buildSafetyNotificationJob({ tourId, eventId, alert, tourName, nowMs });
  const result = await enqueueNotificationJob({ db, job });
  const deliveryUpdate = {
    notificationDeliveryStatus: 'queued',
    notificationDeliveryJobId: result.jobId,
    notificationUpdatedAtMs: nowMs,
  };
  const updates = Object.fromEntries(Object.entries(deliveryUpdate).flatMap(([key, value]) => [
    [`tours/${tourId}/safetyAlerts/${eventId}/${key}`, value],
    ...((alert.isSOS === true || alert.severity === 'critical')
      ? [[`globalSafetyAlerts/${eventId}/${key}`, value]]
      : []),
  ]));
  await db.ref().update(updates);
  log.info('Notification source enqueued safety job', {
    tourId, eventId, jobId: result.jobId, created: result.created,
  });
  return { jobId: result.jobId, created: result.created };
};

const sendSafetyAlertNotification = onValueCreated({
  ref: '/tours/{tourId}/safetyAlerts/{eventId}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 20,
}, enqueueSafetyEvent);

module.exports = { enqueueSafetyEvent, isValidSafetyAlert, sendSafetyAlertNotification };
