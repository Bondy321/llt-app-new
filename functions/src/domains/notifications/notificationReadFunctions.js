'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  processLegacyNotificationReadStateCleanup, processNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest: processMigrationRequest,
} = require('./notificationState');

const onScheduleWithResult = /** @type {any} */ (onSchedule);

const processNotificationReadMigrationRequest = onValueCreated(
  {
    ref: '/notification_read_migration_requests/{tourId}/{authUid}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
    retry: true,
  },
  async (event) => {
    const { tourId, authUid } = event.params;
    try {
      const result = await processMigrationRequest({
        db: admin.database(),
        tourId,
        authUid,
        request: event.data?.val(),
      });
      log.info('Notification read-state migration request completed', {
        tourId,
        legacyRemoved: result.legacyRemoved,
        invalid: result.invalid,
      });
      return result;
    } catch (error) {
      log.error('Notification read-state migration request failed', error, { tourId, authUid });
      throw error;
    }
  },
);

/**
 * Continues exact notice read-state cleanup in bounded user pages. Eviction
 * only enqueues a small durable job; notification delivery never downloads a
 * tour-wide read-state fanout.
 */
const cleanupNotificationReadState = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const database = admin.database();
    const results = await processNotificationReadCleanupJobs({ db: database });
    let legacyResult = null;
    try {
      legacyResult = await processLegacyNotificationReadStateCleanup({ db: database });
    } catch (error) {
      log.warn('Legacy notification read-state cleanup deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log.info('Notification read-state cleanup pass completed', {
      jobCount: results.length,
      completedCount: results.filter((/** @type {any} */ result) => result.completed).length,
      deferredCount: results.filter((/** @type {any} */ result) => result.error).length,
      legacyProcessedCount: legacyResult?.processedCount || 0,
      legacyDeletedCount: legacyResult?.deletedCount || 0,
      legacyCompleted: legacyResult?.completed === true,
    });
    return { jobs: results, legacy: legacyResult };
  },
);

module.exports = { processNotificationReadMigrationRequest, cleanupNotificationReadState };
