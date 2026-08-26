'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { enqueueNotificationJob } = require('./notificationJobs');
const { buildItineraryNotificationJob } = require('./notificationProducerJobs');
const {
  buildTourNotificationRecord,
  persistTourNotification,
  summarizeItineraryChange,
} = require('./notificationState');

/** @param {any} event */
const enqueueItineraryEvent = async (event) => {
  const tourId = event.params.tourId;
  if (!isValidFirebaseKey(tourId)) return null;
  const change = summarizeItineraryChange(
    event.data?.before?.val?.() || {},
    event.data?.after?.val?.() || {},
  );
  if (!change.hasMeaningfulChange) return null;
  const active = await admin.database().ref(`tours/${tourId}/isActive`).once('value');
  if (active.val() === false) return null;
  const nowMs = Date.now();
  const sourceId = String(event.id || `${tourId}:${nowMs}`).slice(0, 500);
  const notice = buildTourNotificationRecord({
    type: 'itinerary',
    tourId,
    sourceId,
    title: change.title,
    body: change.body,
    screen: 'Itinerary',
    createdAtMs: nowMs,
    priority: 'high',
  });
  await persistTourNotification({ record: notice });
  const job = buildItineraryNotificationJob({ tourId, sourceId, change, noticeId: notice.noticeId, nowMs });
  const result = await enqueueNotificationJob({ job });
  log.info('Notification source enqueued itinerary job', { tourId, jobId: result.jobId, created: result.created });
  return { jobId: result.jobId, created: result.created };
};

const sendItineraryNotification = onValueWritten({
  ref: '/tours/{tourId}/itinerary',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
}, enqueueItineraryEvent);

module.exports = { enqueueItineraryEvent, sendItineraryNotification };
