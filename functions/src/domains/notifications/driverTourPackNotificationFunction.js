'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { enqueueNotificationJob } = require('./notificationJobs');
const { buildDriverTourPackNotificationJob } = require('./notificationProducerJobs');
const { buildTourNotificationRecord } = require('./notificationState');

const { summarizeDriverTourPackChange } = loadLegacyLibrary('driverTourPackOperations');

const resolveEnabledDriverIds = (flags) => Object.entries(flags.drivers || {}).filter(([, enabled]) => enabled === true).map(([driverId]) => driverId).filter(isValidFirebaseKey);
const buildDriverPackChangeState = (change, globalEnabled, enabledDriverIds, notice, nowMs) => ({ ...change, changedSections: Object.fromEntries(change.changedSections.map((section) => [section, true])), notificationStatus: globalEnabled || enabledDriverIds.length ? 'queued' : 'feature_disabled', notificationUpdatedAtMs: nowMs, noticeId: notice.noticeId });
const enqueueDriverPackJob = async ({ departureKey, afterPack, change, notice, globalEnabled, enabledDriverIds, nowMs }) => enqueueNotificationJob({ job: buildDriverTourPackNotificationJob({ departureKey, pack: afterPack, change, noticeId: notice.noticeId, allowedDriverIds: globalEnabled ? null : enabledDriverIds, nowMs }) });

/** @param {any} event */
const enqueueDriverTourPackEvent = async (event) => {
  const departureKey = event.params.departureKey;
  const beforePack = event.data?.before?.val?.() || null;
  const afterPack = event.data?.after?.val?.() || null;
  if (!isValidFirebaseKey(departureKey) || afterPack?.departureKey !== departureKey) return null;
  const nowMs = Date.now();
  const change = summarizeDriverTourPackChange(beforePack, afterPack, { eventId: event.id, createdAtMs: nowMs });
  if (!change) return null;
  const flags = (await admin.database().ref('driver_tour_pack_feature_flags').once('value')).val() || {};
  const globalEnabled = flags.global === true;
  const enabledDriverIds = resolveEnabledDriverIds(flags);
  const changePath = `driver_tour_pack_changes/${departureKey}/latest`;
  const notice = buildTourNotificationRecord({
    type: 'driver_tour_pack',
    tourId: afterPack.tourId,
    sourceId: `${departureKey}:${afterPack.revision}`,
    title: 'Operational information changed',
    body: change.critical
      ? 'A critical operational update requires your acknowledgement in the Driver Command Centre.'
      : 'Open the Driver Command Centre to review the updated sections.',
    screen: 'DriverTourPack',
    createdAtMs: nowMs,
    priority: change.critical ? 'high' : 'normal',
    departureKey,
    revision: afterPack.revision,
    changedSections: change.changedSections,
    critical: change.critical,
    requiresAcknowledgement: change.requiresAcknowledgement,
  });
  await admin.database().ref(changePath).set(buildDriverPackChangeState(change, globalEnabled, enabledDriverIds, notice, nowMs));
  if (!globalEnabled && enabledDriverIds.length === 0) return { status: 'feature_disabled' };
  const result = await enqueueDriverPackJob({ departureKey, afterPack, change, notice, globalEnabled, enabledDriverIds, nowMs });
  await admin.database().ref(changePath).update({ deliveryJobId: result.jobId, notificationStatus: 'queued' });
  log.info('Notification source enqueued Driver Tour Pack job', {
    departureKey, revision: afterPack.revision, jobId: result.jobId, created: result.created,
  });
  return { jobId: result.jobId, created: result.created };
};

const sendDriverTourPackChangeNotification = onValueWritten({
  ref: '/driver_tour_packs/{departureKey}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
}, enqueueDriverTourPackEvent);

module.exports = { enqueueDriverTourPackEvent, sendDriverTourPackChangeNotification };
