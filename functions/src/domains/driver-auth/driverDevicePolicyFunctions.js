'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { verifyOperationsAdminAccess } = require('../administration/public');
const {
  DRIVER_LOGIN_POLICY_PATH,
  acquireDriverLoginPolicyLock,
  readDriverLoginPolicy,
  releaseDriverLoginPolicyLock,
} = require('./driverDevicePolicy');

const { isValidAppSessionId } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { cleanupAppSession } = loadLegacyLibrary('appSessionCleanup');

const POLICY_CLEANUP_ROOT = 'driver_login_policy_cleanup/v1';
const POLICY_EVENT_ROOT = 'driver_login_policy_events';
const MAX_DRIVER_SESSIONS_PER_TRANSITION = 500;
const POLICY_CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POLICY_AUDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const onRequestWithResult = /** @type {any} */ (onRequest);
const onScheduleWithResult = /** @type {any} */ (onSchedule);

/** @param {string} value */
const hashIdentifier = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** @type {(...args: any[]) => Promise<any>} */
const authorizePolicyAdminRequest = async ({ req, res, rateLimitKey }) => {
  const corsAllowed = applyAuthenticatedCors(req, res);
  if (req.method === 'OPTIONS') {
    return { allowed: false, response: corsAllowed
      ? res.status(204).send('')
      : res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' }) };
  }
  if (!corsAllowed) {
    return { allowed: false, response: res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' }) };
  }
  if (req.method !== 'POST') {
    return { allowed: false, response: res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' }) };
  }
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    return { allowed: false, response: res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' }) };
  }
  const db = admin.database();
  if (!(await verifyOperationsAdminAccess({ authUid: String(requestAuth.uid), db }))) {
    return { allowed: false, response: res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' }) };
  }
  if (!checkRateLimit(`${rateLimitKey}_${hashIdentifier(String(requestAuth.uid))}`, 20, 60 * 1000)) {
    return { allowed: false, response: res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' }) };
  }
  return { allowed: true, authUid: String(requestAuth.uid), db };
};

/** @param {any} normalized */
const toAdminPolicy = (normalized) => ({
  enforceSingleDevice: normalized.policy.enforceSingleDevice,
  generation: normalized.policy.generation,
  revision: normalized.policy.revision,
  updatedAtMs: normalized.policy.updatedAtMs,
  isDefault: normalized.isDefault,
});

/** @param {unknown} jobs @param {number} policyGeneration */
const countPolicyCleanupJobs = (jobs, policyGeneration) => Object.values(
  jobs && typeof jobs === 'object' ? jobs : {},
).filter((job) => Number.isSafeInteger(/** @type {any} */ (job)?.policyGeneration)
  && /** @type {any} */ (job).policyGeneration === policyGeneration).length;

/** @type {(...args: any[]) => Promise<any>} */
const cleanupExpiredDriverPolicyRecords = async ({
  db = admin.database(), nowMs = Date.now(), limit = 100,
} = {}) => {
  const [cleanupSnapshot, eventSnapshot] = await Promise.all([
    db.ref(POLICY_CLEANUP_ROOT).orderByChild('expiresAtMs').endAt(nowMs).limitToFirst(limit).once('value'),
    db.ref(POLICY_EVENT_ROOT).orderByChild('expiresAtMs').endAt(nowMs).limitToFirst(limit).once('value'),
  ]);
  const expiredCleanupJobs = cleanupSnapshot.val() || {};
  const expiredEvents = eventSnapshot.val() || {};
  const cleanupResults = await Promise.all(Object.entries(expiredCleanupJobs).map(
    ([authUid, observedValue]) => db.ref(`${POLICY_CLEANUP_ROOT}/${authUid}`).transaction((current) => {
      const observed = /** @type {any} */ (observedValue);
      if (!current || current.sessionId !== observed?.sessionId
        || !Number.isSafeInteger(current.expiresAtMs) || current.expiresAtMs > nowMs) return undefined;
      return null;
    }, undefined, false),
  ));
  const updates = {};
  Object.keys(expiredEvents).forEach((eventId) => {
    updates[`${POLICY_EVENT_ROOT}/${eventId}`] = null;
  });
  if (Object.keys(updates).length) await db.ref().update(updates);
  return {
    expiredCleanupJobsDeleted: cleanupResults.filter((result) => result.committed).length,
    expiredAuditEventsDeleted: Object.keys(expiredEvents).length,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const buildPolicyTransitionUpdates = async ({ db, current, enforceSingleDevice, authUid, nowMs }) => {
  const nextGeneration = enforceSingleDevice && !current.policy.enforceSingleDevice
    ? current.policy.generation + 1
    : current.policy.generation;
  const nextPolicy = {
    schemaVersion: 1,
    enforceSingleDevice,
    generation: nextGeneration,
    revision: current.policy.revision + 1,
    updatedAtMs: nowMs,
    updatedByHash: hashIdentifier(authUid),
  };
  const updates = { [DRIVER_LOGIN_POLICY_PATH]: nextPolicy };
  let queuedSessionCount = 0;
  let clearedClaimCount = 0;

  if (enforceSingleDevice && !current.policy.enforceSingleDevice) {
    const [sessionSnapshot, driversSnapshot] = await Promise.all([
      db.ref('app_sessions').orderByChild('principalType').equalTo('driver')
        .limitToFirst(MAX_DRIVER_SESSIONS_PER_TRANSITION + 1).once('value'),
      db.ref('drivers').once('value'),
    ]);
    const sessions = sessionSnapshot.val() || {};
    const entries = Object.entries(sessions);
    if (entries.length > MAX_DRIVER_SESSIONS_PER_TRANSITION) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Too many active driver sessions'));
      error.code = 'TOO_MANY_DRIVER_SESSIONS';
      throw error;
    }
    entries.forEach(([sessionAuthUid, sessionValue]) => {
      const session = /** @type {any} */ (sessionValue);
      if (!isValidAppSessionId(session?.sessionId)) return;
      updates[`${POLICY_CLEANUP_ROOT}/${sessionAuthUid}`] = {
        schemaVersion: 1,
        authUidHash: hashIdentifier(sessionAuthUid),
        sessionId: session.sessionId,
        policyGeneration: nextGeneration,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + POLICY_CLEANUP_TTL_MS,
      };
      queuedSessionCount += 1;
    });
    Object.entries(driversSnapshot.val() || {}).forEach(([driverId, driverValue]) => {
      if (typeof /** @type {any} */ (driverValue)?.authUid !== 'string') return;
      updates[`drivers/${driverId}/authUid`] = null;
      clearedClaimCount += 1;
    });
  }

  const eventId = db.ref(POLICY_EVENT_ROOT).push().key;
  updates[`${POLICY_EVENT_ROOT}/${eventId}`] = {
    schemaVersion: 1,
    eventType: 'driver_login_policy_changed',
    previousEnforceSingleDevice: current.policy.enforceSingleDevice,
    enforceSingleDevice,
    policyGeneration: nextGeneration,
    policyRevision: nextPolicy.revision,
    actorAuthUidHash: hashIdentifier(authUid),
    queuedSessionCount,
    clearedClaimCount,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + POLICY_AUDIT_TTL_MS,
  };
  return { updates, nextPolicy, queuedSessionCount, clearedClaimCount };
};

/** @type {(...args: any[]) => Promise<any>} */
const processDriverLoginPolicyCleanupJobs = async ({ db = admin.database(), nowMs = Date.now(), limit = 50 } = {}) => {
  const snapshot = await db.ref(POLICY_CLEANUP_ROOT).orderByChild('createdAtMs').limitToFirst(limit).once('value');
  const jobs = snapshot.val() || {};
  const summary = { scanned: 0, cleaned: 0, obsolete: 0, locked: 0, failed: 0 };
  for (const [authUid, jobValue] of Object.entries(jobs)) {
    const job = /** @type {any} */ (jobValue);
    summary.scanned += 1;
    const lock = await acquireAppSessionLock({ db, authUid, operation: 'policy_cleanup', nowMs });
    if (!lock.acquired) {
      summary.locked += 1;
      continue;
    }
    try {
      const sessionSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
      const session = sessionSnapshot.val();
      if (!session || session.sessionId !== job.sessionId) {
        await db.ref(`${POLICY_CLEANUP_ROOT}/${authUid}`).remove();
        summary.obsolete += 1;
        continue;
      }
      await cleanupAppSession({
        db,
        session,
        expectedSessionId: job.sessionId,
        eventType: 'ended_by_admin',
        reason: 'driver_single_device_policy_enabled',
        actorType: 'operations_admin',
        nowMs,
        disableAllNotificationDelivery: true,
        createEventId: () => db.ref('app_session_events').push().key,
      });
      await db.ref(`${POLICY_CLEANUP_ROOT}/${authUid}`).remove();
      summary.cleaned += 1;
    } catch (error) {
      summary.failed += 1;
      log.error('Driver policy session cleanup failed', error, { authUidHash: hashIdentifier(authUid) });
    } finally {
      await releaseAppSessionLock({ db, authUid, owner: lock.owner });
    }
  }
  return summary;
};

const getDriverLoginPolicy = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorizePolicyAdminRequest({ req, res, rateLimitKey: 'get_driver_login_policy' });
    if (!access.allowed) return access.response;
    try {
      const normalized = await readDriverLoginPolicy({ db: access.db });
      return res.status(200).json({ success: true, policy: toAdminPolicy(normalized) });
    } catch (error) {
      log.error('Driver login policy read failed', error);
      return res.status(500).json({ success: false, reason: 'POLICY_CONFIGURATION_INVALID' });
    }
  },
);

const setDriverLoginPolicy = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 1, timeoutSeconds: 120, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorizePolicyAdminRequest({ req, res, rateLimitKey: 'set_driver_login_policy' });
    if (!access.allowed) return access.response;
    const requested = req.body?.enforceSingleDevice;
    const expectedRevision = req.body?.expectedRevision;
    if (typeof requested !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }

    const lock = await acquireDriverLoginPolicyLock({ db: access.db });
    if (!lock.acquired) {
      return res.status(409).json({ success: false, reason: 'POLICY_CHANGE_IN_PROGRESS' });
    }
    let transition = null;
    try {
      const current = await readDriverLoginPolicy({ db: access.db });
      if (current.policy.revision !== expectedRevision) {
        return res.status(409).json({ success: false, reason: 'POLICY_CHANGED' });
      }
      if (current.policy.enforceSingleDevice === requested) {
        return res.status(200).json({
          success: true, policy: toAdminPolicy(current), changed: false,
          cleanup: { queued: 0, cleaned: 0, pending: 0 },
        });
      }
      transition = await buildPolicyTransitionUpdates({
        db: access.db,
        current,
        enforceSingleDevice: requested,
        authUid: access.authUid,
        nowMs: Date.now(),
      });
      await access.db.ref().update(transition.updates);
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      log.error('Driver login policy change failed', error);
      const reason = code === 'TOO_MANY_DRIVER_SESSIONS' ? code : 'INTERNAL_ERROR';
      return res.status(reason === 'TOO_MANY_DRIVER_SESSIONS' ? 409 : 500).json({ success: false, reason });
    } finally {
      await releaseDriverLoginPolicyLock({ db: access.db, owner: lock.owner });
    }

    let cleanup = { scanned: 0, cleaned: 0, obsolete: 0, locked: 0, failed: 0 };
    let pending = requested ? transition.queuedSessionCount : 0;
    try {
      if (requested) {
        cleanup = await processDriverLoginPolicyCleanupJobs({ db: access.db, limit: 100 });
        const pendingSnapshot = await access.db.ref(POLICY_CLEANUP_ROOT).once('value');
        pending = countPolicyCleanupJobs(pendingSnapshot.val(), transition.nextPolicy.generation);
      }
    } catch (error) {
      log.error('Immediate driver policy cleanup pass failed; scheduled retry retained', error, {
        queuedSessionCount: transition.queuedSessionCount,
      });
    }
    log.info('Driver login policy changed', {
      enforceSingleDevice: requested,
      policyRevision: transition.nextPolicy.revision,
      policyGeneration: transition.nextPolicy.generation,
      queuedSessionCount: transition.queuedSessionCount,
      cleanupPendingCount: pending,
    });
    return res.status(200).json({
      success: true,
      changed: true,
      policy: toAdminPolicy({ policy: transition.nextPolicy, isDefault: false }),
      cleanup: { queued: transition.queuedSessionCount, cleaned: cleanup.cleaned, pending },
    });
  },
);

const cleanupDriverLoginPolicySessions = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const summary = await processDriverLoginPolicyCleanupJobs({ limit: 100 });
    const retention = await cleanupExpiredDriverPolicyRecords({ limit: 100 });
    if (summary.failed || summary.locked) log.warn('Driver policy cleanup remains pending', summary);
    else log.info('Driver policy cleanup completed', { ...summary, ...retention });
    return { ...summary, ...retention };
  },
);

module.exports = {
  buildPolicyTransitionUpdates,
  cleanupExpiredDriverPolicyRecords,
  cleanupDriverLoginPolicySessions,
  countPolicyCleanupJobs,
  getDriverLoginPolicy,
  processDriverLoginPolicyCleanupJobs,
  setDriverLoginPolicy,
  toAdminPolicy,
};
