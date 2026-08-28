'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { log } = require('../../infrastructure/logging/safeLogger');

const {
  reconcileDriverLocationSourceChange,
} = loadLegacyLibrary('driverLocationProjection');
const {
  cleanupExpiredChatStatusSessions: cleanupExpiredChatStatusRecords,
  reconcileChatStatusSourceChange,
} = loadLegacyLibrary('chatPresenceProjection');

const onValueWrittenWithResult = /** @type {any} */ (onValueWritten);
const onScheduleWithResult = /** @type {any} */ (onSchedule);

/** @param {any} event */
const reconcileDriverLocationEvent = (event) => reconcileDriverLocationSourceChange({
  database: admin.database(),
  before: event.data.before.val(),
  after: event.data.after.val(),
});

/** @param {any} event */
const reconcileChatStatusEvent = (event) => reconcileChatStatusSourceChange({
  database: admin.database(),
  before: event.data.before.val(),
  after: event.data.after.val(),
});

const liveStateTriggerOptions = Object.freeze({
  region: 'europe-west1',
  retry: true,
  maxInstances: 20,
});

const projectDriverLocationSession = onValueWrittenWithResult(
  { ...liveStateTriggerOptions, ref: 'driver_location_sessions/{sourceKey}' },
  reconcileDriverLocationEvent,
);

const projectDriverLocationPickup = onValueWrittenWithResult(
  { ...liveStateTriggerOptions, ref: 'driver_location_pickups/{tourId}' },
  reconcileDriverLocationEvent,
);

const projectChatPresenceSession = onValueWrittenWithResult(
  { ...liveStateTriggerOptions, ref: 'chat_presence_sessions/{scope}/{appSessionId}' },
  reconcileChatStatusEvent,
);

const projectChatTypingSession = onValueWrittenWithResult(
  { ...liveStateTriggerOptions, ref: 'chat_typing_sessions/{scope}/{appSessionId}' },
  reconcileChatStatusEvent,
);

const cleanupExpiredChatStatusSessions = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const result = await cleanupExpiredChatStatusRecords({
      database: admin.database(),
    });
    if (result.hasMore) log.warn('Expired chat status cleanup reached its bounded ceiling', result);
    else log.info('Expired chat status cleanup completed', result);
    return result;
  },
);

module.exports = {
  cleanupExpiredChatStatusSessions,
  projectChatPresenceSession,
  projectChatTypingSession,
  projectDriverLocationPickup,
  projectDriverLocationSession,
};
