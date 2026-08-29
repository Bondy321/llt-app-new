'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { enforceGroupMediaAppCheck } = require('../../infrastructure/auth/appCheckGate');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { distributedLoginRateLimiter } = require('../passenger-auth/public');
const {
  projectAccountDeletionAcceptedResponse,
  projectAccountDeletionRequest,
  projectAccountDeletionStatusRequest,
  projectAccountDeletionStatusResponse,
  validateAccountDeletionAcceptedResponse,
  validateAccountDeletionRequest,
  validateAccountDeletionRolloutRecord,
  validateAccountDeletionStatusRequest,
  validateAccountDeletionStatusResponse,
} = require('../../contracts/generated/accountDeletion');
const {
  ACCOUNT_DELETION_ACTIVE_ROOT,
  ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT,
  ACCOUNT_DELETION_JOB_ROOT,
  ACCOUNT_DELETION_LOCK_ROOT,
  ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT,
  ACCOUNT_DELETION_QUEUE_ROOT,
  ACCOUNT_DELETION_ROLLOUT_PATH,
  ACCOUNT_DELETION_UID_TOMBSTONE_ROOT,
  emptyAccountDeletionSummary,
} = require('./accountDeletionConstants');
const {
  deriveAccountDeletionId,
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
  normalizeAccountDeletionRollout,
  toPublicAccountDeletionStatus,
} = require('./accountDeletionBoundary');
const { deriveTrustedAccountDeletionScope } = require('./accountDeletionScope');
const {
  acquirePassengerAccountDeletionLock,
  releasePassengerAccountDeletionLock,
} = require('./accountDeletionCoordination');
const {
  cleanupCompletedAccountDeletionJobs,
  processDueAccountDeletionJobs,
  repairAccountDeletionRetryQueues,
} = require('./accountDeletionWorker');

const {
  acquireNotificationDeviceLock,
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  releaseNotificationDeviceLock,
} = loadLegacyLibrary('appSessionCleanup');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { cleanupExpiredOperationsTerminalWarnings } = loadLegacyLibrary('operationsTerminalWarnings');

const REQUEST_LOCK_TTL_MS = 180 * 1000;
const JOB_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const sendBoundedFailure = (res, status, reason) => res.status(status).json({
  success: false,
  reason: String(reason || 'ACCOUNT_DELETION_UNAVAILABLE').slice(0, 80),
});

const projectValidatedAcceptedResponse = (job) => {
  const projected = projectAccountDeletionAcceptedResponse({
    ...toPublicAccountDeletionStatus(job, { accepted: true }),
    status: 'accepted',
  });
  if (!validateAccountDeletionAcceptedResponse(projected).valid) throw new Error('Invalid account deletion accepted response');
  return projected;
};

const projectValidatedStatusResponse = (job) => {
  const projected = projectAccountDeletionStatusResponse(toPublicAccountDeletionStatus(job));
  if (!validateAccountDeletionStatusResponse(projected).valid) throw new Error('Invalid account deletion status response');
  return projected;
};

const readAccountDeletionStatusRecord = async ({ db, deletionId }) => {
  const job = (await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).once('value')).val();
  if (job) return job;
  return (await db.ref(
    `${ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT}/${deletionId}`,
  ).once('value')).val();
};

const readValidatedAccountDeletionRollout = async (db) => {
  const value = (await db.ref(ACCOUNT_DELETION_ROLLOUT_PATH).once('value')).val();
  if (value !== null && value !== undefined && !validateAccountDeletionRolloutRecord(value).valid) {
    return { valid: false, isDefault: false, phase: 'compatibility' };
  }
  return normalizeAccountDeletionRollout(value);
};

const acquireAccountDeletionReservationLock = async ({ db, deletionId, owner, nowMs }) => {
  const ref = db.ref(`${ACCOUNT_DELETION_LOCK_ROOT}/${deletionId}`);
  const result = await ref.transaction((current) => {
    if (current && current.owner !== owner && Number(current.expiresAtMs || 0) > nowMs) return undefined;
    return { schemaVersion: 1, owner, createdAtMs: nowMs, expiresAtMs: nowMs + REQUEST_LOCK_TTL_MS };
  }, undefined, false);
  return { acquired: Boolean(result?.committed && result.snapshot.val()?.owner === owner), ref };
};

const releaseAccountDeletionReservationLock = async ({ ref, owner }) => {
  if (!ref) return false;
  let released = false;
  const result = await ref.transaction((current) => {
    if (current?.owner !== owner) return undefined;
    released = true;
    return null;
  }, undefined, false);
  return Boolean(released && result?.committed);
};

const waitForIdempotentAccountDeletionReservation = async ({
  db, deletionId, authUid, attempts = 10, delayMs = 20,
}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const job = (await db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).once('value')).val();
    if (job && (job.status === 'completed' || job.privateScope?.authUid === authUid)) return job;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
};

const enforceAccountDeletionRateLimit = async ({ deletionId, authUid, kind }) => {
  const [receiptAllowed, authAllowed] = await Promise.all([
    distributedLoginRateLimiter(
      `account_deletion_${kind}_receipt_${hashRateLimitDimension(deletionId)}`,
      kind === 'request' ? 12 : 60,
      60_000,
    ),
    distributedLoginRateLimiter(
      `account_deletion_${kind}_auth_${hashRateLimitDimension(authUid)}`,
      kind === 'request' ? 12 : 120,
      60_000,
    ),
  ]);
  return receiptAllowed && authAllowed;
};

const buildInitialAccountDeletionJob = ({ deletionId, privateScope, nowMs }) => ({
  schemaVersion: 1,
  deletionId,
  status: 'pending',
  retryable: true,
  phase: 'reserved',
  substage: null,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
  destructiveStartedAtMs: nowMs,
  expiresAtMs: nowMs + JOB_EXPIRY_MS,
  availableAtMs: nowMs,
  attemptCount: 0,
  consecutiveFailureCount: 0,
  firstAttemptAtMs: null,
  lastAttemptAtMs: null,
  lastFailureReason: null,
  terminalWarningId: null,
  leaseRevision: 0,
  lease: null,
  privateScope,
  cursors: {
    groupMediaAfterPhotoId: null,
    privateMediaAfterPhotoId: null,
    chatAfterMessageId: null,
  },
  summary: emptyAccountDeletionSummary(),
});

// eslint-disable-next-line complexity -- reservation deliberately keeps the lock/commit failure paths together
const reserveAccountDeletion = async ({ db, authUid, input, deletionId, nowMs = Date.now() }) => {
  const owner = randomUUID();
  let reservationLock = null;
  let sessionLock = null;
  let notificationLock = null;
  let passengerDeletionLock = null;
  try {
    reservationLock = await acquireAccountDeletionReservationLock({ db, deletionId, owner, nowMs });
    if (!reservationLock.acquired) {
      const replay = await waitForIdempotentAccountDeletionReservation({ db, deletionId, authUid });
      return replay
        ? { status: 202, job: replay, replay: true }
        : { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
    }
    sessionLock = await acquireAppSessionLock({
      db, authUid, operation: 'revoke', owner, nowMs, ttlMs: REQUEST_LOCK_TTL_MS,
    });
    if (!sessionLock.acquired) {
      return {
        status: 409,
        reason: sessionLock.lock?.operation === 'revoke'
          ? 'ACCOUNT_DELETION_IN_PROGRESS'
          : 'SESSION_IN_PROGRESS',
      };
    }
    notificationLock = await acquireNotificationDeviceLock({
      db, authUid, owner, nowMs, ttlMs: REQUEST_LOCK_TTL_MS,
    });
    if (!notificationLock.acquired) return { status: 409, reason: 'DEVICE_UPDATE_IN_PROGRESS' };

    const [jobSnapshot, barrierSnapshot] = await Promise.all([
      db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`).once('value'),
      db.ref(`${ACCOUNT_DELETION_ACTIVE_ROOT}/${authUid}`).once('value'),
    ]);
    const existingJob = jobSnapshot.val();
    const active = barrierSnapshot.val();
    if (existingJob) {
      if (existingJob.status === 'completed' || existingJob.privateScope?.authUid === authUid) {
        return { status: 202, job: existingJob, replay: true };
      }
      return { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
    }
    // Any extant barrier is authoritative, including legacy or malformed false/zero
    // values. Never overwrite an ambiguous barrier during a new reservation.
    if (active !== null && active !== undefined) {
      return { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
    }

    const scope = await deriveTrustedAccountDeletionScope({
      db, authUid, expectedSessionId: input.expectedSessionId, nowMs,
    });
    if (!scope.valid) {
      return {
        status: scope.reason === 'SESSION_CHANGED' ? 409 : 422,
        reason: scope.reason || 'ACCOUNT_DELETION_SCOPE_INCOMPLETE',
      };
    }
    const uidTombstoneKey = deriveUidAccountDeletionTombstoneKey(authUid);
    const uidTombstoneSnapshot = await db.ref(
      `${ACCOUNT_DELETION_UID_TOMBSTONE_ROOT}/${uidTombstoneKey}`,
    ).once('value');
    if (uidTombstoneSnapshot.exists()) {
      return { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
    }
    let passengerBarrierKey = null;
    if (scope.privateScope.principalType === 'passenger') {
      passengerDeletionLock = await acquirePassengerAccountDeletionLock({
        db,
        bookingRef: scope.privateScope.bookingRef,
        ownerId: owner,
        nowMs,
        ttlMs: REQUEST_LOCK_TTL_MS,
      });
      if (!passengerDeletionLock.acquired) {
        return { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
      }
      passengerBarrierKey = derivePassengerAccountDeletionKey(scope.privateScope.bookingRef);
      const passengerBarrier = await db.ref(
        `${ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT}/${passengerBarrierKey}`,
      ).once('value');
      if (passengerBarrier.exists()) {
        return { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' };
      }
    }
    const job = buildInitialAccountDeletionJob({ deletionId, privateScope: scope.privateScope, nowMs });
    const cleanupUpdates = buildAppSessionCleanupUpdates({
      session: scope.session,
      userProfile: scope.profile,
      notificationDevice: null,
      disableAllNotificationDelivery: true,
      nowMs,
    });
    const tombstone = (await db.ref(`notification_device_tombstones/${authUid}`).once('value')).val() || {};
    const registrationRevision = Math.max(
      Number(scope.notificationDevice?.registrationRevision || 0),
      Number(tombstone.registrationRevision || 0),
    ) + 1;
    Object.assign(cleanupUpdates, {
      [`notification_devices/${authUid}`]: null,
      [`notification_consents/${authUid}`]: null,
      [`notification_device_tombstones/${authUid}`]: {
        schemaVersion: 1,
        permanent: true,
        registrationRevision,
        deletedAtMs: nowMs,
      },
    });
    const eventId = `account_deletion_${randomUUID()}`;
    const event = buildAppSessionEvent({
      session: scope.session,
      eventType: 'account_deletion_requested',
      reason: 'account_deletion',
      actorType: scope.session.principalType,
      nowMs,
    });
    await db.ref().update({
      ...cleanupUpdates,
      [`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`]: job,
      [`${ACCOUNT_DELETION_QUEUE_ROOT}/${deletionId}`]: {
        schemaVersion: 1,
        deletionId,
        dueAtMs: nowMs,
        lease: null,
      },
      [`${ACCOUNT_DELETION_ACTIVE_ROOT}/${authUid}`]: {
        schemaVersion: 1,
        deletionId,
        status: 'pending',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      [`${ACCOUNT_DELETION_UID_TOMBSTONE_ROOT}/${uidTombstoneKey}`]: {
        schemaVersion: 1,
        permanent: true,
        createdAtMs: nowMs,
      },
      ...(passengerBarrierKey ? {
        [`${ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT}/${passengerBarrierKey}`]: {
          schemaVersion: 1,
          deletionId,
          status: 'pending',
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        },
      } : {}),
      [`app_session_events/${eventId}`]: { ...event, tourId: null, driverId: null },
    });
    return { status: 202, job, replay: false };
  } finally {
    if (passengerDeletionLock?.acquired) {
      await releasePassengerAccountDeletionLock({ lock: passengerDeletionLock });
    }
    if (notificationLock?.acquired) {
      await releaseNotificationDeviceLock({ lockRef: notificationLock.lockRef, owner });
    }
    if (sessionLock?.acquired) await releaseAppSessionLock({ db, authUid, owner });
    if (reservationLock?.acquired) await releaseAccountDeletionReservationLock({ ref: reservationLock.ref, owner });
  }
};

const requireReceiptCapabilityAuth = async ({ req, res }) => {
  const auth = await verifyRequestAuthUid(req);
  if (!auth.success) {
    sendBoundedFailure(res, 401, 'INVALID_CREDENTIALS');
    return null;
  }
  let appCheckValid = false;
  try {
    appCheckValid = await enforceGroupMediaAppCheck(req);
  } catch (_error) {
    sendBoundedFailure(res, 503, 'SERVICE_UNAVAILABLE');
    return null;
  }
  if (!appCheckValid) {
    sendBoundedFailure(res, 401, 'APP_CHECK_REQUIRED');
    return null;
  }
  return auth;
};

/** @type {(...args: any[]) => any} */
const requestAccountDeletion = onRequest({
  region: 'europe-west1', maxInstances: 20, timeoutSeconds: 60, cors: false,
}, async (req, res) => {
  if (req.method !== 'POST') return sendBoundedFailure(res, 405, 'METHOD_NOT_ALLOWED');
  if (!validateAccountDeletionRequest(req.body).valid) return sendBoundedFailure(res, 400, 'INVALID_INPUT');
  const input = projectAccountDeletionRequest(req.body);
  const capabilityAuth = await requireReceiptCapabilityAuth({ req, res });
  if (!capabilityAuth) return null;
  const deletionId = deriveAccountDeletionId(input.deletionReceipt);
  if (!(await enforceAccountDeletionRateLimit({ deletionId, authUid: capabilityAuth.uid, kind: 'request' }))) {
    return sendBoundedFailure(res, 429, 'RATE_LIMITED');
  }
  const db = admin.database();
  const rollout = await readValidatedAccountDeletionRollout(db);
  if (!rollout.valid) return sendBoundedFailure(res, 503, 'ACCOUNT_DELETION_UNAVAILABLE');
  const existingJob = await readAccountDeletionStatusRecord({ db, deletionId });
  if (existingJob) return res.status(202).json(projectValidatedAcceptedResponse(existingJob));
  // Brand-new reservations repeat the normal mobile request gate immediately before
  // exact-session scope derivation. Replays above rely only on the receipt capability.
  const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
  if (!requestAuth) return null;
  const result = await reserveAccountDeletion({ db, authUid: requestAuth.uid, input, deletionId });
  if (!result.job) return sendBoundedFailure(res, result.status, result.reason);
  return res.status(202).json(projectValidatedAcceptedResponse(result.job));
});

/** @type {(...args: any[]) => any} */
const getAccountDeletionStatus = onRequest({
  region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false,
}, async (req, res) => {
  if (req.method !== 'POST') return sendBoundedFailure(res, 405, 'METHOD_NOT_ALLOWED');
  if (!validateAccountDeletionStatusRequest(req.body).valid) return sendBoundedFailure(res, 400, 'INVALID_INPUT');
  const auth = await requireReceiptCapabilityAuth({ req, res });
  if (!auth) return null;
  const input = projectAccountDeletionStatusRequest(req.body);
  const deletionId = deriveAccountDeletionId(input.deletionReceipt);
  if (!(await enforceAccountDeletionRateLimit({ deletionId, authUid: auth.uid, kind: 'status' }))) {
    return sendBoundedFailure(res, 429, 'RATE_LIMITED');
  }
  const job = await readAccountDeletionStatusRecord({ db: admin.database(), deletionId });
  if (!job) return sendBoundedFailure(res, 404, 'ACCOUNT_DELETION_STATUS_UNAVAILABLE');
  return res.status(200).json(projectValidatedStatusResponse(job));
});

const retryAccountDeletionJob = async ({ db, deletionId, nowMs = Date.now() }) => {
  const ref = db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`);
  let outcome = 'unavailable';
  const result = await ref.transaction((current) => {
    if (!current) return undefined;
    if (current.status === 'completed') {
      outcome = 'completed';
      return current;
    }
    if (current.retryable === false) {
      outcome = 'terminal';
      return current;
    }
    if (current.lease && Number(current.lease.expiresAtMs || 0) > nowMs) {
      outcome = 'busy';
      return current;
    }
    outcome = 'queued';
    return {
      ...current,
      status: 'pending',
      consecutiveFailureCount: 0,
      lastFailureReason: null,
      availableAtMs: nowMs,
      updatedAtMs: nowMs,
      retryRequestedAtMs: nowMs,
      lease: null,
    };
  }, undefined, false);
  const job = result?.snapshot?.val?.() || null;
  if (!job) {
    const completion = (await db.ref(
      `${ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT}/${deletionId}`,
    ).once('value')).val();
    if (completion?.status === 'completed') return { outcome: 'completed', job: completion };
  }
  if (outcome === 'queued') {
    await repairAccountDeletionRetryQueues({ db, nowMs, limit: 20 });
    if (job?.privateScope?.authUid) {
      await db.ref(`${ACCOUNT_DELETION_ACTIVE_ROOT}/${job.privateScope.authUid}`).transaction((active) => {
        if (!active || active.deletionId !== deletionId) return undefined;
        return { ...active, status: 'pending', updatedAtMs: nowMs };
      }, undefined, false);
    }
  }
  return { outcome, job };
};

/** @type {(...args: any[]) => any} */
const retryAccountDeletion = onRequest({
  region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false,
}, async (req, res) => {
  if (req.method !== 'POST') return sendBoundedFailure(res, 405, 'METHOD_NOT_ALLOWED');
  if (!validateAccountDeletionStatusRequest(req.body).valid) return sendBoundedFailure(res, 400, 'INVALID_INPUT');
  const auth = await requireReceiptCapabilityAuth({ req, res });
  if (!auth) return null;
  const input = projectAccountDeletionStatusRequest(req.body);
  const deletionId = deriveAccountDeletionId(input.deletionReceipt);
  if (!(await enforceAccountDeletionRateLimit({ deletionId, authUid: auth.uid, kind: 'retry' }))) {
    return sendBoundedFailure(res, 429, 'RATE_LIMITED');
  }
  const result = await retryAccountDeletionJob({ db: admin.database(), deletionId });
  if (!result.job) return sendBoundedFailure(res, 404, 'ACCOUNT_DELETION_STATUS_UNAVAILABLE');
  return res.status(200).json(projectValidatedStatusResponse(result.job));
});

const processAccountDeletionJobs = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west1',
  maxInstances: 1,
  timeoutSeconds: 300,
}, async () => ({
  processed: await processDueAccountDeletionJobs(),
  completedRemoved: await cleanupCompletedAccountDeletionJobs(),
  terminalWarningsRemoved: await cleanupExpiredOperationsTerminalWarnings({ db: admin.database() }),
}));

module.exports = {
  acquireAccountDeletionReservationLock,
  buildInitialAccountDeletionJob,
  enforceAccountDeletionRateLimit,
  getAccountDeletionStatus,
  processAccountDeletionJobs,
  projectValidatedAcceptedResponse,
  projectValidatedStatusResponse,
  readValidatedAccountDeletionRollout,
  readAccountDeletionStatusRecord,
  requestAccountDeletion,
  reserveAccountDeletion,
  retryAccountDeletion,
  retryAccountDeletionJob,
  waitForIdempotentAccountDeletionReservation,
};
