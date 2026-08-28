'use strict';

/* eslint-disable complexity -- resumable policy phases deliberately keep every fence explicit */

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
  cleanupExpiredDriverAssignmentRecords,
  processDriverAssignmentTransitions,
} = require('../driver-assignment/public');
const {
  DRIVER_LOGIN_POLICY_PATH,
  beginDriverPolicyTransition,
  normalizeDriverLoginPolicy,
  readDriverLoginPolicy,
  readDriverPolicyTransition,
} = require('./driverDevicePolicy');

const { isValidAppSessionId } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { cleanupAppSession } = loadLegacyLibrary('appSessionCleanup');

const POLICY_CLEANUP_ROOT = 'driver_login_policy_cleanup/v1';
const POLICY_EVENT_ROOT = 'driver_login_policy_events';
const POLICY_TRANSITION_PAGE_SIZE = 100;
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
  transition: normalized.transition?.phase && normalized.transition.phase !== 'stable'
    ? {
      phase: normalized.transition.phase,
      transitionId: normalized.transition.transitionId,
      targetEnforceSingleDevice: normalized.transition.targetEnforceSingleDevice,
      sessionsScanned: normalized.transition.sessionsScanned,
      sessionsQueued: normalized.transition.sessionsQueued,
      driversScanned: normalized.transition.driversScanned,
    }
    : null,
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
        .limitToFirst(POLICY_TRANSITION_PAGE_SIZE).once('value'),
      db.ref('drivers').once('value'),
    ]);
    const sessions = sessionSnapshot.val() || {};
    const entries = Object.entries(sessions);
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
const readBoundedKeyPage = async ({ db, path, cursor = null, limit = POLICY_TRANSITION_PAGE_SIZE }) => {
  let query = db.ref(path).orderByKey();
  if (cursor) query = query.startAt(cursor);
  const snapshot = await query.limitToFirst(limit + (cursor ? 2 : 1)).once('value');
  const entries = Object.entries(snapshot.val() || {})
    .filter(([key]) => key !== cursor)
    .sort(([left], [right]) => left.localeCompare(right));
  const page = entries.slice(0, limit);
  return {
    entries: page,
    hasMore: entries.length > limit,
    cursor: page.length ? page[page.length - 1][0] : cursor,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const advanceDriverPolicyTransition = async ({
  db = admin.database(), nowMs = Date.now(), pageSize = POLICY_TRANSITION_PAGE_SIZE,
} = {}) => {
  const policyRef = db.ref(DRIVER_LOGIN_POLICY_PATH);
  let rawPolicy = (await policyRef.once('value')).val();
  let normalized = normalizeDriverLoginPolicy(rawPolicy);
  if (!normalized.valid) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Driver login policy is malformed'));
    error.code = 'POLICY_CONFIGURATION_INVALID';
    throw error;
  }
  let transition = readDriverPolicyTransition(rawPolicy);
  if (transition.phase === 'stable') return { status: 'stable', progressed: false };

  if (transition.phase === 'draining') {
    let drainOutcome = 'waiting';
    const drainResult = await policyRef.transaction((currentValue) => {
      const current = normalizeDriverLoginPolicy(currentValue);
      const currentTransition = readDriverPolicyTransition(currentValue);
      if (!current.valid || currentTransition.phase !== 'draining'
        || currentTransition.transitionId !== transition.transitionId) return undefined;
      const activeAdmissions = Object.fromEntries(Object.entries(currentValue?.loginAdmissions || {})
        .filter(([, admission]) => /** @type {any} */ (admission)?.durableUntilExplicitRelease === true
          || Number(/** @type {any} */ (admission)?.expiresAtMs || 0) > nowMs));
      if (Object.keys(activeAdmissions).length) {
        drainOutcome = 'waiting';
        return { ...currentValue, loginAdmissions: activeAdmissions };
      }
      drainOutcome = 'barrier_committed';
      return {
        ...currentValue,
        enforceSingleDevice: true,
        generation: current.policy.generation + 1,
        transitionPhase: 'cleanup',
        transitionStage: 'sessions',
        transitionBarrierAtMs: nowMs,
        loginAdmissions: null,
      };
    }, undefined, false);
    if (!drainResult?.committed) return { status: 'contended', progressed: false };
    if (drainOutcome === 'waiting') return { status: 'draining', progressed: true };
    rawPolicy = drainResult.snapshot.val();
    normalized = normalizeDriverLoginPolicy(rawPolicy);
    transition = readDriverPolicyTransition(rawPolicy);
  }

  const stage = rawPolicy?.transitionStage || 'sessions';
  if (stage === 'sessions') {
    const page = await readBoundedKeyPage({
      db, path: 'app_sessions', cursor: transition.sessionCursor, limit: pageSize,
    });
    const updates = {};
    let queued = 0;
    page.entries.forEach(([authUid, sessionValue]) => {
      const session = /** @type {any} */ (sessionValue);
      if (session?.principalType !== 'driver' || !isValidAppSessionId(session?.sessionId)) return;
      const generation = Number.isSafeInteger(session.driverLoginPolicyGeneration)
        ? session.driverLoginPolicyGeneration
        : 0;
      if (generation === normalized.policy.generation) return;
      updates[`${POLICY_CLEANUP_ROOT}/${authUid}`] = {
        schemaVersion: 1,
        authUidHash: hashIdentifier(authUid),
        sessionId: session.sessionId,
        policyGeneration: normalized.policy.generation,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + POLICY_CLEANUP_TTL_MS,
      };
      queued += 1;
    });
    updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionSessionsScanned`] = transition.sessionsScanned + page.entries.length;
    updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionSessionsQueued`] = transition.sessionsQueued + queued;
    updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionSessionCursor`] = page.cursor;
    if (!page.hasMore) {
      updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionStage`] = 'drivers';
      updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionDriverCursor`] = null;
    }
    await db.ref().update(updates);
    return { status: page.hasMore ? 'cleanup_sessions' : 'cleanup_drivers', progressed: true, queued };
  }

  const driverPage = await readBoundedKeyPage({
    db, path: 'drivers', cursor: transition.driverCursor, limit: pageSize,
  });
  const updates = {};
  driverPage.entries.forEach(([driverId, driverValue]) => {
    if (typeof /** @type {any} */ (driverValue)?.authUid === 'string') {
      updates[`drivers/${driverId}/authUid`] = null;
    }
  });
  updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionDriversScanned`] = transition.driversScanned + driverPage.entries.length;
  updates[`${DRIVER_LOGIN_POLICY_PATH}/transitionDriverCursor`] = driverPage.cursor;
  if (!driverPage.hasMore) {
    Object.assign(updates, {
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionPhase`]: 'stable',
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionStage`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionId`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/targetEnforceSingleDevice`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionStartedAtMs`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionBarrierAtMs`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionSessionCursor`]: null,
      [`${DRIVER_LOGIN_POLICY_PATH}/transitionDriverCursor`]: null,
    });
  }
  await db.ref().update(updates);
  return { status: driverPage.hasMore ? 'cleanup_drivers' : 'stable', progressed: true };
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

    try {
      const started = await beginDriverPolicyTransition({
        db: access.db,
        enforceSingleDevice: requested,
        expectedRevision,
        actorHash: hashIdentifier(access.authUid),
        nowMs: Date.now(),
      });
      if (started.reason) {
        const reason = started.reason;
        return res.status(reason === 'POLICY_CONFIGURATION_INVALID' ? 500 : 409)
          .json({ success: false, reason });
      }

      if (started.started) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const progress = await advanceDriverPolicyTransition({ db: access.db, pageSize: 100 });
          if (!progress.progressed || progress.status === 'stable' || progress.status === 'draining') break;
        }
      }
      const current = await readDriverLoginPolicy({ db: access.db });
      const cleanup = requested
        ? await processDriverLoginPolicyCleanupJobs({ db: access.db, limit: 100 })
        : { cleaned: 0 };
      const queued = current.transition?.sessionsQueued || 0;
      const pending = current.transition?.phase && current.transition.phase !== 'stable'
        ? Math.max(0, queued - cleanup.cleaned)
        : 0;
      const eventId = access.db.ref(POLICY_EVENT_ROOT).push().key;
      await access.db.ref(`${POLICY_EVENT_ROOT}/${eventId}`).set({
        schemaVersion: 1,
        eventType: 'driver_login_policy_change_requested',
        enforceSingleDevice: requested,
        policyGeneration: current.policy.generation,
        policyRevision: current.policy.revision,
        actorAuthUidHash: hashIdentifier(access.authUid),
        transitionId: current.transition?.transitionId || null,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + POLICY_AUDIT_TTL_MS,
      });
      return res.status(200).json({
        success: true,
        changed: started.changed === true,
        policy: toAdminPolicy(current),
        cleanup: { queued, cleaned: cleanup.cleaned, pending },
      });
    } catch (error) {
      log.error('Driver login policy change failed', error);
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    }
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
    const assignmentTransitions = await processDriverAssignmentTransitions({ db: admin.database(), limit: 5 });
    const transition = await advanceDriverPolicyTransition({ pageSize: 100 });
    const summary = await processDriverLoginPolicyCleanupJobs({ limit: 100 });
    const retention = await cleanupExpiredDriverPolicyRecords({ limit: 100 });
    const assignmentRetention = await cleanupExpiredDriverAssignmentRecords({
      db: admin.database(), limit: 100,
    });
    if (summary.failed || summary.locked) log.warn('Driver policy cleanup remains pending', summary);
    else log.info('Driver policy cleanup completed', { transition, ...summary, ...retention });
    return { transition, assignmentTransitions, ...summary, ...retention, assignmentRetention };
  },
);

module.exports = {
  buildPolicyTransitionUpdates,
  advanceDriverPolicyTransition,
  cleanupExpiredDriverPolicyRecords,
  cleanupDriverLoginPolicySessions,
  countPolicyCleanupJobs,
  getDriverLoginPolicy,
  processDriverLoginPolicyCleanupJobs,
  setDriverLoginPolicy,
  toAdminPolicy,
};
