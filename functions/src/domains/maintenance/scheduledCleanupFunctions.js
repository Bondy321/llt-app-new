'use strict';

// @ts-check

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { log } = require('../../infrastructure/logging/safeLogger');

const { cleanupExpiredDriverTourPacks: cleanupExpiredTourPacks } = loadLegacyLibrary('driverTourPackExpiryCleanup');
const { cleanupExpiredDriverLocations: cleanupExpiredLocations } = loadLegacyLibrary('driverLocationExpiryCleanup');
const { cleanupExpiredLoginRateLimits: cleanupExpiredRateLimits } = loadLegacyLibrary('loginRateLimiter');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { cleanupAppSession } = loadLegacyLibrary('appSessionCleanup');

const SAFETY_RATE_LIMIT_ROOT = 'safety_rate_limits/v1';
const onScheduleWithResult = /** @type {any} */ (onSchedule);

const cleanupExpiredDriverTourPacks = onScheduleWithResult(
  {
    schedule: 'every 6 hours',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const result = await cleanupExpiredTourPacks({ database: admin.database() });
    log.info('Driver Tour Pack expiry cleanup completed', result);
    return result;
  },
);

const cleanupExpiredDriverLocations = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
  },
  async () => {
    const result = await cleanupExpiredLocations({ database: admin.database() });
    if (result.hasMore) log.warn('Expired driver-location cleanup reached its bounded ceiling', result);
    else log.info('Expired driver-location cleanup completed', result);
    return result;
  },
);

const cleanupExpiredLoginRateLimits = onScheduleWithResult(
  {
    schedule: 'every 1 hours',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
  },
  async () => {
    const database = admin.database();
    const [loginResult, safetyResult] = await Promise.all([
      cleanupExpiredRateLimits({ database }),
      cleanupExpiredRateLimits({ database, rootPath: SAFETY_RATE_LIMIT_ROOT }),
    ]);
    if (loginResult.hasMore) log.warn('Expired login rate-limit cleanup reached its bounded ceiling', loginResult);
    else log.info('Expired login rate-limit cleanup completed', loginResult);
    if (safetyResult.hasMore) log.warn('Expired safety rate-limit cleanup reached its bounded ceiling', safetyResult);
    else log.info('Expired safety rate-limit cleanup completed', safetyResult);
    return { login: loginResult, safety: safetyResult };
  },
);

const cleanupExpiredAppSessions = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const db = admin.database();
    const nowMs = Date.now();
    const snapshot = await db.ref('app_sessions')
      .orderByChild('expiresAtMs')
      .endAt(nowMs)
      .limitToFirst(50)
      .once('value');
    const candidates = snapshot.val() || {};
    const summary = { scanned: 0, expired: 0, alreadyEnded: 0, locked: 0, failed: 0, eventsRemoved: 0 };
    for (const [authUid, candidateValue] of Object.entries(candidates)) {
      const candidate = /** @type {any} */ (candidateValue);
      summary.scanned += 1;
      const lock = await acquireAppSessionLock({ db, authUid, operation: 'cleanup', nowMs });
      if (!lock.acquired) {
        summary.locked += 1;
        continue;
      }
      try {
        const currentSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
        const current = currentSnapshot.val();
        if (!current || current.sessionId !== candidate.sessionId) {
          summary.alreadyEnded += 1;
          continue;
        }
        if (Number(current.expiresAtMs) > nowMs) continue;
        await cleanupAppSession({
          db,
          session: current,
          expectedSessionId: current.sessionId,
          eventType: 'expired',
          reason: 'session_expired',
          actorType: 'system',
          nowMs,
          createEventId: () => db.ref('app_session_events').push().key,
        });
        summary.expired += 1;
      } catch (error) {
        summary.failed += 1;
        log.error('Expired app session cleanup failed', error, { authUid });
      } finally {
        await releaseAppSessionLock({ db, authUid, owner: lock.owner });
      }
    }

    const eventsSnapshot = await db.ref('app_session_events')
      .orderByChild('expiresAtMs')
      .endAt(nowMs)
      .limitToFirst(100)
      .once('value');
    /** @type {Record<string, null>} */
    const eventUpdates = {};
    eventsSnapshot.forEach(/** @param {any} child */ (child) => { eventUpdates[child.key] = null; });
    if (Object.keys(eventUpdates).length) {
      await db.ref('app_session_events').update(eventUpdates);
      summary.eventsRemoved = Object.keys(eventUpdates).length;
    }
    log.info('Expired app session cleanup completed', summary);
    return summary;
  },
);

module.exports = {
  cleanupExpiredAppSessions,
  cleanupExpiredDriverLocations,
  cleanupExpiredDriverTourPacks,
  cleanupExpiredLoginRateLimits,
};
