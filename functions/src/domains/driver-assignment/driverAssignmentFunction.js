'use strict';

/* eslint-disable complexity, max-lines-per-function -- one HTTP orchestration keeps every fenced phase visible */

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit, getRequestClientKey, hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { verifyOperationsAdminAccess } = require('../administration/public');
const {
  acquireDriverLoginAdmission,
  ensureDriverLoginPolicy,
  readDriverLoginPolicy,
  releaseDriverLoginAdmission,
} = require('../driver-auth/public');
const {
  abandonDriverAssignmentReservation,
  advanceDriverAssignmentTransition,
  acquireDriverAssignmentBarrier,
  buildCurrentAssignmentProfileProjection,
  collectDriverAssignmentConflicts,
  createAssignmentRequestHash,
  createAssignmentTransitionId,
  hashAuthorityIdentifier,
  normalizeDriverId,
  readAssignmentRevision,
  reserveDriverAssignmentTransition,
  releaseDriverAssignmentBarrier,
} = require('./public');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidAppSessionId, toClientSession } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

// Longer than the HTTP timeout so an owner cannot outlive its assignment fence.
const DRIVER_ASSIGNMENT_LOCK_TTL_MS = 180 * 1000;
const ASSIGNMENT_TRANSITION_ROOT = 'driver_assignment_transitions/v1';
const ASSIGNMENT_TRANSITION_QUEUE_ROOT = 'driver_assignment_transition_queue/v1';
const onRequestWithResult = /** @type {any} */ (onRequest);

/** @param {unknown} value */
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

/** @param {any} body @param {boolean} isAdmin */
const parseDriverAssignmentInput = (body, isAdmin) => {
  const operation = isAdmin && body?.operation === 'unassign' ? 'unassign' : 'assign';
  const driverId = normalizeDriverId(body?.driverId);
  const requestedTour = resolveTrimmedString(body?.tourCode || body?.tourId);
  const tourId = normalizeTourKeyForComparison(requestedTour);
  const expectedSessionId = resolveTrimmedString(body?.expectedSessionId);
  const idempotencyKey = resolveTrimmedString(body?.idempotencyKey)
    || (!isAdmin && expectedSessionId
      ? `mobile:${expectedSessionId}:${readAssignmentRevision(body?.expectedSessionRevision)}:${tourId}`
      : '');
  const expectedDriverRevision = body?.expectedDriverRevision;
  const expectedTourRevision = body?.expectedTourRevision;
  const driverProfileUpdates = isAdmin && body?.driverProfileUpdates && typeof body.driverProfileUpdates === 'object'
    ? {
      name: resolveTrimmedString(body.driverProfileUpdates.name),
      phone: typeof body.driverProfileUpdates.phone === 'string' ? body.driverProfileUpdates.phone.trim() : null,
    }
    : null;
  const valid = driverId && isValidFirebaseKey(driverId)
    && tourId && isValidFirebaseKey(tourId)
    && idempotencyKey.length >= 8 && idempotencyKey.length <= 240
    && (isAdmin
      ? isNonNegativeInteger(expectedDriverRevision) && isNonNegativeInteger(expectedTourRevision)
      : isValidAppSessionId(expectedSessionId));
  return valid ? {
    operation,
    driverId,
    expectedSessionId: expectedSessionId || null,
    expectedDriverRevision: isAdmin ? expectedDriverRevision : null,
    expectedTourRevision: isAdmin ? expectedTourRevision : null,
    driverProfileUpdates,
    idempotencyKey,
    requestedTour,
    tourId,
  } : null;
};

/** @type {(...args: any[]) => Promise<any>} */
const authorizeDriverAssignmentSession = async ({ db, authUid, driverId, expectedSessionId }) => {
  const appSessionLock = await acquireAppSessionLock({ db, authUid, operation: 'assign' });
  if (!appSessionLock.acquired) {
    return { allowed: false, appSessionLock, status: 409, reason: 'SESSION_IN_PROGRESS' };
  }
  const access = await verifyActiveAppSession({
    db,
    authUid,
    expectedRole: 'driver',
    expectedSessionId,
    allowUnassignedDriver: true,
  });
  if (!access.allowed || access.session.driverId !== driverId) {
    return {
      allowed: false,
      appSessionLock,
      status: access.reason === 'SESSION_CHANGED' ? 409 : 403,
      reason: access.reason || 'NOT_AUTHORIZED',
    };
  }
  return { allowed: true, appSessionLock, access };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const acquireDriverAssignmentLocks = async ({ db, lockPaths, owner, acquiredLocks }) => {
  for (const lockPath of lockPaths) {
    const acquired = await acquireManualBookingLock({
      db, path: lockPath, owner, nowMs: Date.now(), ttlMs: DRIVER_ASSIGNMENT_LOCK_TTL_MS,
    });
    if (!acquired) return false;
    acquiredLocks.push(lockPath);
  }
  return true;
};

/** @param {any} res @param {number} status @param {string} reason */
const reject = (res, status, reason, details = {}) => res.status(status).json({
  success: false, reason, ...details,
});

/** @param {any} res @param {any} progress */
const inProgress = (res, progress = {}) => reject(res, 409, 'ASSIGNMENT_IN_PROGRESS', {
  continuation: {
    status: progress.status || 'queued',
    retryable: true,
  },
});

const assignDriverToTour = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 10, timeoutSeconds: 120 },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (!applyAuthenticatedCors(req, res)) return reject(res, 403, 'ORIGIN_NOT_ALLOWED');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return reject(res, 405, 'METHOD_NOT_ALLOWED');

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) return reject(res, 401, 'INVALID_CREDENTIALS');

    const db = admin.database();
    const isAdmin = await verifyOperationsAdminAccess({ authUid: String(requestAuth.uid), db });
    const input = parseDriverAssignmentInput(req.body, isAdmin);
    if (!input) return reject(res, 400, 'INVALID_INPUT');
    if (!isAdmin && input.operation !== 'assign') return reject(res, 403, 'NOT_AUTHORIZED');

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`assign_driver_${requestAuth.uid}_${hashRateLimitDimension(clientKey)}`, isAdmin ? 60 : 12, 60000)) {
      return reject(res, 429, 'TRY_AGAIN_LATER');
    }

    const actorHash = hashAuthorityIdentifier(requestAuth.uid);
    const idempotencyId = hashAuthorityIdentifier(input.idempotencyKey);
    const idempotencyPath = `driver_assignment_idempotency/v1/${actorHash}/${idempotencyId}`;
    const requestHash = createAssignmentRequestHash(input);
    const transitionId = createAssignmentTransitionId({ actorHash, idempotencyId });
    const existingIdempotency = (await db.ref(idempotencyPath).once('value')).val();
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) return reject(res, 409, 'IDEMPOTENCY_CONFLICT');
      if (existingIdempotency.status === 'completed' && existingIdempotency.result) {
        if (isAdmin) return res.status(200).json(existingIdempotency.result);
        const replaySession = (await db.ref(`app_sessions/${requestAuth.uid}`).once('value')).val();
        if (!replaySession || replaySession.sessionId !== input.expectedSessionId
          || replaySession.tourId !== existingIdempotency.result.tourId) {
          return reject(res, 409, 'SESSION_CHANGED');
        }
        return res.status(200).json({
          ...existingIdempotency.result,
          session: toClientSession(replaySession),
        });
      }
      return inProgress(res, { status: existingIdempotency.status || 'queued' });
    }
    const existingTransitionSnapshot = await db.ref(`${ASSIGNMENT_TRANSITION_ROOT}/${transitionId}`).once('value');
    if (existingTransitionSnapshot.exists()) {
      const existingTransition = existingTransitionSnapshot.val() || {};
      if (existingTransition.actorHash !== actorHash || existingTransition.requestHash !== requestHash
        || existingTransition.idempotencyPath !== idempotencyPath) {
        return reject(res, 409, 'IDEMPOTENCY_CONFLICT');
      }
      if (existingTransition.status === 'reserving') {
        return inProgress(res, { status: 'reserving' });
      }
      if (existingTransition.status !== 'aborted') {
        const progress = await advanceDriverAssignmentTransition({ db, transitionId });
        if (progress.status === 'failed') return reject(res, 409, progress.reason || 'ASSIGNMENT_ALREADY_CHANGED');
        if (progress.completed) {
          if (isAdmin) return res.status(200).json(progress.result);
          const replaySession = (await db.ref(`app_sessions/${requestAuth.uid}`).once('value')).val();
          if (!replaySession || replaySession.sessionId !== input.expectedSessionId
            || replaySession.tourId !== progress.result.tourId) return reject(res, 409, 'SESSION_CHANGED');
          return res.status(200).json({ ...progress.result, session: toClientSession(replaySession) });
        }
        return inProgress(res, progress);
      }
    }

    const lockOwner = randomUUID();
    const acquiredAssignmentLocks = [];
    let callerSessionLock = null;
    let assignmentAdmission = null;
    let admissionHandedOff = false;
    const acquiredBarriers = [];
    let barriersHandedOff = false;
    let reservationOwned = false;
    let transitionHandedOff = false;

    try {
      if (!isAdmin) {
        const authorization = await authorizeDriverAssignmentSession({
          db,
          authUid: requestAuth.uid,
          driverId: input.driverId,
          expectedSessionId: input.expectedSessionId,
        });
        callerSessionLock = authorization.appSessionLock;
        if (!authorization.allowed) return reject(res, authorization.status, authorization.reason);
      }

      let policy;
      try {
        let policyRead = await readDriverLoginPolicy({ db });
        if (policyRead.isDefault) policyRead = await ensureDriverLoginPolicy({ db });
        policy = policyRead.policy;
      } catch (error) {
        log.error('Driver assignment blocked by invalid driver policy', error, { driverId: input.driverId });
        return reject(res, 503, 'POLICY_CONFIGURATION_INVALID');
      }

      const [initialDriverSnapshot, initialTourSnapshot, initialManifestSnapshot] = await Promise.all([
        db.ref(`drivers/${input.driverId}`).once('value'),
        db.ref(`tours/${input.tourId}`).once('value'),
        db.ref(`tour_manifests/${input.tourId}`).once('value'),
      ]);
      if (!initialDriverSnapshot.exists()) return reject(res, 404, 'DRIVER_NOT_FOUND');
      if (!initialTourSnapshot.exists()) return reject(res, 404, 'TOUR_NOT_FOUND');
      const initialDriver = initialDriverSnapshot.val() || {};
      const initialTour = initialTourSnapshot.val() || {};
      const initialPreviousTourId = normalizeTourKeyForComparison(initialDriver.currentTourId);
      const initialIncumbentDriverId = normalizeDriverId(initialTour.driverId);
      const initialDisplacedDriverIds = collectDriverAssignmentConflicts({
        driverId: input.driverId,
        tourData: initialTour,
        manifestData: initialManifestSnapshot.val() || {},
      });
      if (initialTour.isActive === false && input.operation === 'assign') {
        return reject(res, 409, 'TOUR_INACTIVE');
      }
      if (input.operation === 'unassign' && ((initialIncumbentDriverId
        && initialIncumbentDriverId !== input.driverId) || initialDisplacedDriverIds.length)) {
        return reject(res, 409, 'ASSIGNMENT_ALREADY_CHANGED');
      }
      if (!isAdmin && initialDisplacedDriverIds.length) {
        return reject(res, 409, 'TOUR_ALREADY_ASSIGNED');
      }
      if (isAdmin && (readAssignmentRevision(initialDriver.assignmentRevision) !== input.expectedDriverRevision
        || readAssignmentRevision(initialTour.driverAssignmentRevision) !== input.expectedTourRevision)) {
        return reject(res, 409, 'ASSIGNMENT_STALE');
      }

      const initialProfileProjection = buildCurrentAssignmentProfileProjection({
        isAdmin,
        operation: input.operation,
        driverId: input.driverId,
        tourId: input.tourId,
        expectedDriverRevision: input.expectedDriverRevision,
        expectedTourRevision: input.expectedTourRevision,
        driverProfileUpdates: input.driverProfileUpdates,
        driverData: initialDriver,
        tourData: initialTour,
        manifestData: initialManifestSnapshot.val() || {},
      });
      if (initialProfileProjection.status === 'ready') {
        const profileLockPaths = [
          `driver_assignment_locks/drivers/${input.driverId}`,
          `driver_assignment_locks/tours/${input.tourId}`,
        ].sort();
        const locksAcquired = await acquireDriverAssignmentLocks({
          db,
          lockPaths: profileLockPaths,
          owner: lockOwner,
          acquiredLocks: acquiredAssignmentLocks,
        });
        if (!locksAcquired) return inProgress(res, { status: 'lock_wait' });
        const [lockedDriverSnapshot, lockedTourSnapshot, lockedManifestSnapshot] = await Promise.all([
          db.ref(`drivers/${input.driverId}`).once('value'),
          db.ref(`tours/${input.tourId}`).once('value'),
          db.ref(`tour_manifests/${input.tourId}`).once('value'),
        ]);
        const lockedProjection = buildCurrentAssignmentProfileProjection({
          isAdmin,
          operation: input.operation,
          driverId: input.driverId,
          tourId: input.tourId,
          expectedDriverRevision: input.expectedDriverRevision,
          expectedTourRevision: input.expectedTourRevision,
          driverProfileUpdates: input.driverProfileUpdates,
          driverData: lockedDriverSnapshot.val() || {},
          tourData: lockedTourSnapshot.val() || {},
          manifestData: lockedManifestSnapshot.val() || {},
        });
        if (lockedProjection.status === 'stale') return reject(res, 409, 'ASSIGNMENT_STALE');
        if (lockedProjection.status !== 'ready') return reject(res, 409, 'ASSIGNMENT_ALREADY_CHANGED');
        await db.ref().update(lockedProjection.updates);
        return res.status(200).json(lockedProjection.result);
      }

      const admissionId = `assignment_${transitionId}`;
      const barrierDriverIds = [...new Set([
        input.driverId,
        ...initialDisplacedDriverIds,
      ])].sort();
      const transitionReservation = {
        requestHash,
        actorHash,
        actorType: isAdmin ? 'admin' : 'driver',
        operation: input.operation,
        driverId: input.driverId,
        tourId: input.tourId,
        incumbentDriverId: initialIncumbentDriverId || null,
        displacedDriverIds: initialDisplacedDriverIds.length ? initialDisplacedDriverIds : null,
        barrierDriverIds,
        expectedDriverRevision: readAssignmentRevision(initialDriver.assignmentRevision),
        expectedTourRevision: readAssignmentRevision(initialTour.driverAssignmentRevision),
        idempotencyPath,
        driverProfileUpdates: input.driverProfileUpdates,
        admissionId,
        policy,
        reservationOwner: lockOwner,
      };
      await db.ref().update({ [`${ASSIGNMENT_TRANSITION_QUEUE_ROOT}/${transitionId}`]: true });
      const reservation = await reserveDriverAssignmentTransition({
        db, transitionId, reservation: transitionReservation,
      });
      if (!reservation.reserved) {
        const incumbent = reservation.transition || {};
        if (incumbent.actorHash !== actorHash || incumbent.requestHash !== requestHash
          || incumbent.idempotencyPath !== idempotencyPath) {
          return reject(res, 409, 'IDEMPOTENCY_CONFLICT');
        }
        return inProgress(res, { status: incumbent.status || 'reserving' });
      }
      reservationOwned = true;

      assignmentAdmission = await acquireDriverLoginAdmission({
        db,
        authUid: requestAuth.uid,
        driverId: input.driverId,
        admissionId,
        durable: true,
      });
      if (!assignmentAdmission.acquired) {
        return reject(res, 409, assignmentAdmission.reason || 'DRIVER_POLICY_CHANGE_IN_PROGRESS');
      }
      policy = assignmentAdmission.policy;

      const lockPaths = new Set([
        `driver_assignment_locks/drivers/${input.driverId}`,
        `driver_assignment_locks/tours/${input.tourId}`,
      ]);
      if (initialPreviousTourId) lockPaths.add(`driver_assignment_locks/tours/${initialPreviousTourId}`);
      initialDisplacedDriverIds.forEach((driverId) => {
        lockPaths.add(`driver_assignment_locks/drivers/${driverId}`);
      });
      const locksAcquired = await acquireDriverAssignmentLocks({
        db,
        lockPaths: [...lockPaths].sort(),
        owner: lockOwner,
        acquiredLocks: acquiredAssignmentLocks,
      });
      if (!locksAcquired) return inProgress(res, { status: 'lock_wait' });

      const [driverSnapshot, tourSnapshot, manifestSnapshot] = await Promise.all([
        db.ref(`drivers/${input.driverId}`).once('value'),
        db.ref(`tours/${input.tourId}`).once('value'),
        db.ref(`tour_manifests/${input.tourId}`).once('value'),
      ]);
      if (!driverSnapshot.exists()) return reject(res, 404, 'DRIVER_NOT_FOUND');
      if (!tourSnapshot.exists()) return reject(res, 404, 'TOUR_NOT_FOUND');
      const driverData = driverSnapshot.val() || {};
      const tourData = tourSnapshot.val() || {};
      const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
      const incumbentDriverId = normalizeDriverId(tourData.driverId);
      const displacedDriverIds = collectDriverAssignmentConflicts({
        driverId: input.driverId,
        tourData: tourData,
        manifestData: manifestSnapshot.val() || {},
      });
      if (previousTourId !== initialPreviousTourId || incumbentDriverId !== initialIncumbentDriverId
        || JSON.stringify(displacedDriverIds) !== JSON.stringify(initialDisplacedDriverIds)) {
        return reject(res, 409, 'ASSIGNMENT_ALREADY_CHANGED');
      }
      if (tourData.isActive === false && input.operation === 'assign') return reject(res, 409, 'TOUR_INACTIVE');
      if (input.operation === 'unassign' && incumbentDriverId && incumbentDriverId !== input.driverId) {
        return reject(res, 409, 'ASSIGNMENT_ALREADY_CHANGED');
      }
      if (!isAdmin) {
        const currentAccess = await verifyActiveAppSession({
          db,
          authUid: requestAuth.uid,
          expectedRole: 'driver',
          expectedSessionId: input.expectedSessionId,
          allowUnassignedDriver: true,
        });
        if (!currentAccess.allowed || currentAccess.session.driverId !== input.driverId) {
          return reject(res, 409, currentAccess.reason || 'SESSION_CHANGED');
        }
        const conflicts = collectDriverAssignmentConflicts({
          driverId: input.driverId,
          tourData,
          manifestData: manifestSnapshot.val() || {},
        });
        if (conflicts.length > 0) return reject(res, 409, 'TOUR_ALREADY_ASSIGNED');
      } else if (readAssignmentRevision(driverData.assignmentRevision) !== input.expectedDriverRevision
        || readAssignmentRevision(tourData.driverAssignmentRevision) !== input.expectedTourRevision) {
        return reject(res, 409, 'ASSIGNMENT_STALE');
      }
      for (const barrierDriverId of barrierDriverIds) {
        const barrier = await acquireDriverAssignmentBarrier({
          db, driverId: barrierDriverId, transitionId,
        });
        if (!barrier.acquired) return inProgress(res, { status: 'login_drain' });
        acquiredBarriers.push(barrierDriverId);
      }

      const nowMs = Date.now();
      const queuedResult = await db.ref(`${ASSIGNMENT_TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
        if (!current || current.status !== 'reserving' || current.reservationOwner !== lockOwner) {
          return undefined;
        }
        return {
          ...current,
          status: 'queued',
          policy,
          updatedAtMs: nowMs,
          reservationExpiresAtMs: null,
        };
      }, undefined, false);
      if (!queuedResult?.committed) return inProgress(res, { status: 'reserving' });
      transitionHandedOff = true;
      admissionHandedOff = true;
      barriersHandedOff = true;

      await Promise.all(acquiredAssignmentLocks.map((path) => releaseManualBookingLock({
        db, path, owner: lockOwner,
      })));
      acquiredAssignmentLocks.length = 0;
      if (callerSessionLock?.acquired) {
        await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: callerSessionLock.owner });
        callerSessionLock = null;
      }

      let progress = { status: 'queued', progressed: true };
      for (let step = 0; step < 6 && progress.progressed && !progress.completed; step += 1) {
        try {
          progress = await advanceDriverAssignmentTransition({ db, transitionId });
        } catch (error) {
          log.warn('Driver assignment cleanup remains retryable', {
            driverId: input.driverId,
            tourId: input.tourId,
            errorCode: error?.code || 'CLEANUP_RETRY',
          });
          return inProgress(res, { status: 'cleanup_retry' });
        }
      }
      if (progress.status === 'failed') {
        return reject(res, 409, progress.reason || 'ASSIGNMENT_ALREADY_CHANGED');
      }
      if (!progress.completed) return inProgress(res, progress);
      if (isAdmin) return res.status(200).json(progress.result);
      const completedSession = (await db.ref(`app_sessions/${requestAuth.uid}`).once('value')).val();
      if (!completedSession || completedSession.sessionId !== input.expectedSessionId
        || completedSession.tourId !== progress.result.tourId) {
        return reject(res, 409, 'SESSION_CHANGED');
      };
      return res.status(200).json({ ...progress.result, session: toClientSession(completedSession) });
    } catch (error) {
      log.error('Canonical driver assignment failed', error, {
        driverId: input.driverId,
        tourId: input.tourId,
        operation: input.operation,
      });
      return reject(res, 500, 'INTERNAL_ERROR');
    } finally {
      await Promise.all(acquiredAssignmentLocks.map((path) => releaseManualBookingLock({
        db, path, owner: lockOwner,
      })));
      if (reservationOwned && !transitionHandedOff) {
        await abandonDriverAssignmentReservation({
          db, transitionId, reservationOwner: lockOwner,
        });
      }
      if (callerSessionLock?.acquired) {
        await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: callerSessionLock.owner });
      }
      if (assignmentAdmission?.acquired && !admissionHandedOff) {
        await releaseDriverLoginAdmission({ db, admissionId: assignmentAdmission.admissionId });
      }
      if (!barriersHandedOff) {
        await Promise.all(acquiredBarriers.map((driverId) => releaseDriverAssignmentBarrier({
          db, driverId, transitionId,
        })));
      }
    }
  },
);

module.exports = { assignDriverToTour };
