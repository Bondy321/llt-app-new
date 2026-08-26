'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit, getRequestClientKey, hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { buildSafeAppSessionEvent } = require('../app-sessions/public');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const {
  buildDriverSelfAssignmentUpdates, collectDriverAssignmentConflicts, normalizeDriverId,
} = require('./driverAssignment');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { calculateSessionExpiry, isValidAppSessionId, toClientSession } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');
const { cleanupDriverLocationForSession } = loadLegacyLibrary('appSessionCleanup');

const DRIVER_ASSIGNMENT_LOCK_TTL_MS = 30 * 1000;

const onRequestWithResult = /** @type {any} */ (onRequest);

/** @param {any} body */
const parseDriverAssignmentInput = (body) => {
  const driverId = normalizeDriverId(body?.driverId);
  const requestedTour = resolveTrimmedString(body?.tourCode || body?.tourId);
  const tourId = normalizeTourKeyForComparison(requestedTour);
  const expectedSessionId = resolveTrimmedString(body?.expectedSessionId);
  const valid = driverId && isValidFirebaseKey(driverId)
    && tourId && isValidFirebaseKey(tourId)
    && isValidAppSessionId(expectedSessionId);
  return valid ? { driverId, expectedSessionId, requestedTour, tourId } : null;
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

/** @type {(...args: any[]) => Promise<any>} */
const loadAssignableDriverTour = async ({ db, driverId, authUid, tourId }) => {
  const [driverSnapshot, tourSnapshot, manifestSnapshot] = await Promise.all([
    db.ref(`drivers/${driverId}`).once('value'),
    db.ref(`tours/${tourId}`).once('value'),
    db.ref(`tour_manifests/${tourId}`).once('value'),
  ]);
  if (!driverSnapshot.exists()) return { valid: false, status: 404, reason: 'DRIVER_NOT_FOUND' };
  const driverData = driverSnapshot.val() || {};
  if (resolveTrimmedString(driverData.authUid) !== authUid) {
    return { valid: false, status: 403, reason: 'NOT_AUTHORIZED' };
  }
  if (!tourSnapshot.exists()) return { valid: false, status: 404, reason: 'TOUR_NOT_FOUND' };
  const tourData = tourSnapshot.val() || {};
  if (tourData.isActive === false) return { valid: false, status: 409, reason: 'TOUR_INACTIVE' };
  const conflicts = collectDriverAssignmentConflicts({
    driverId, tourData, manifestData: manifestSnapshot.val() || {},
  });
  if (conflicts.length > 0) {
    log.warn('Driver self-assignment rejected because tour already has another driver', {
      driverId, authUid, tourId, conflictCount: conflicts.length,
    });
    return { valid: false, status: 409, reason: 'TOUR_ALREADY_ASSIGNED' };
  }
  return { valid: true, driverData, tourData };
};

const assignDriverToTour = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }

    const input = parseDriverAssignmentInput(req.body);
    if (!input) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const { driverId, expectedSessionId, tourId } = input;

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`assign_driver_${requestAuth.uid}_${hashRateLimitDimension(clientKey)}`, 12, 60000)) {
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    const db = admin.database();
    const lockOwner = randomUUID();
    let appSessionLock = null;
    const lockPaths = [
      `driver_assignment_locks/drivers/${driverId}`,
      `driver_assignment_locks/tours/${tourId}`,
    ].sort();
    /** @type {string[]} */
    const acquiredLocks = [];

    try {
      const sessionAuthorization = await authorizeDriverAssignmentSession({
        db, authUid: requestAuth.uid, driverId, expectedSessionId,
      });
      appSessionLock = sessionAuthorization.appSessionLock;
      if (!sessionAuthorization.allowed) {
        return res.status(sessionAuthorization.status).json({
          success: false, reason: sessionAuthorization.reason,
        });
      }
      const activeAccess = sessionAuthorization.access;

      const locksAcquired = await acquireDriverAssignmentLocks({
        db, lockPaths, owner: lockOwner, acquiredLocks,
      });
      if (!locksAcquired) {
        return res.status(409).json({ success: false, reason: 'ASSIGNMENT_IN_PROGRESS' });
      }

      const context = await loadAssignableDriverTour({
        db, driverId, authUid: requestAuth.uid, tourId,
      });
      if (!context.valid) {
        return res.status(context.status).json({ success: false, reason: context.reason });
      }
      const { driverData, tourData } = context;

      const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
      const previousTourSnapshot = previousTourId && previousTourId !== tourId
        ? await db.ref(`tours/${previousTourId}`).once('value')
        : null;
      const assignment = buildDriverSelfAssignmentUpdates({
        driverId,
        authUid: requestAuth.uid,
        driverData,
        tourId,
        tourData,
        previousTourData: previousTourSnapshot?.val?.() || {},
      });
      const nowMs = Date.now();
      const updatedSession = {
        ...activeAccess.session,
        tourId,
        lastAuthenticatedAtMs: nowMs,
        expiresAtMs: calculateSessionExpiry({ principalType: 'driver', tourId, nowMs }),
        sessionRevision: activeAccess.session.sessionRevision + 1,
      };
      assignment.updates[`app_sessions/${requestAuth.uid}`] = updatedSession;
      assignment.updates[`app_session_events/${db.ref('app_session_events').push().key}`] = buildSafeAppSessionEvent({
        session: updatedSession,
        eventType: 'assignment_changed',
        reason: 'driver_self_assignment',
        actorType: 'driver',
        nowMs,
      });
      await db.ref().update(assignment.updates);
      if (assignment.previousTourId && assignment.previousTourId !== tourId) {
        await cleanupDriverLocationForSession({
          db,
          session: { ...activeAccess.session, tourId: assignment.previousTourId },
        });
      }
      log.info('Driver self-assignment completed', {
        driverId,
        authUid: requestAuth.uid,
        tourId,
        previousTourId: assignment.previousTourId,
        updatePathCount: Object.keys(assignment.updates).length,
      });
      return res.status(200).json({
        success: true,
        tourId,
        tourCode: assignment.canonicalTourCode,
        previousTourId: assignment.previousTourId,
        session: toClientSession(updatedSession),
      });
    } catch (error) {
      log.error('Driver self-assignment failed', error, {
        driverId,
        authUid: requestAuth.uid,
        tourId,
      });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await Promise.all(acquiredLocks.map((path) => releaseManualBookingLock({
        db,
        path,
        owner: lockOwner,
      })));
      if (appSessionLock?.acquired) {
        await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: appSessionLock.owner });
      }
    }
  }
);

module.exports = { assignDriverToTour };
