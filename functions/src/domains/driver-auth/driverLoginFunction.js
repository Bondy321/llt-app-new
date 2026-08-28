'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { issueDriverAppSession } = require('../app-sessions/public');
const { buildDriverIdentityProfileUpdates, claimDriverAuthUid, normalizeDriverId, resolveDriverAssignment } = require('../driver-assignment/public');
const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { authorizeDriverLoginSecurity } = require('./driverLoginSecurity');
const {
  acquireDriverLoginPolicyLock,
  driverBindingAllowedByPolicy,
  ensureDriverLoginPolicy,
  readDriverLoginPolicy,
  releaseDriverLoginPolicyLock,
} = require('./driverDevicePolicy');
const { toClientSession } = loadLegacyLibrary('appSession');

const onRequestWithResult = /** @type {any} */ (onRequest);

/** @param {string | null} assignedTourId @param {any} resolvedTour */
const resolveAssignmentStatus = (assignedTourId, resolvedTour) => {
  if (!assignedTourId) return 'UNASSIGNED';
  return resolvedTour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND';
};

/** @type {(...args: any[]) => Promise<any>} */
const loadAuthorizedDriver = async ({ db, driverId, authUid, policy }) => {
  const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
  if (!driverSnapshot.exists()) {
    log.warn('Driver login rejected: driver not found', { driverId, authUid });
    return { allowed: false, status: 200, reason: 'DRIVER_NOT_FOUND' };
  }
  const driverData = driverSnapshot.val() || {};
  const claimedAuthUid = resolveTrimmedString(driverData.authUid);
  if (!driverBindingAllowedByPolicy({ policy, authUid, claimedAuthUid })) {
    log.warn('Driver login rejected: driver code already linked to another auth uid', { driverId, authUid });
    return { allowed: false, status: 403, reason: 'DRIVER_ALREADY_LINKED' };
  }
  if (!policy.enforceSingleDevice) return { allowed: true, driverData };
  const claimResult = await claimDriverAuthUid({ db, driverId, authUid });
  if (!claimResult.claimed) {
    log.warn('Driver login rejected: driver claim lost to another auth uid', { driverId, authUid });
    return { allowed: false, status: 403, reason: 'DRIVER_ALREADY_LINKED' };
  }
  return { allowed: true, driverData };
};

/** @type {(...args: any[]) => Promise<any>} */
const resolveDriverLoginTour = async ({ db, assignment }) => {
  if (!assignment.assignedTourId) return null;
  const tourSnapshot = await db.ref(`tours/${assignment.assignedTourId}`).once('value');
  return tourSnapshot.exists() ? { id: assignment.assignedTourId, ...(tourSnapshot.val() || {}) } : null;
};

const verifyDriverLogin = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
    }

    const driverId = normalizeDriverId(req.body?.driverId);
    if (!driverId || !isValidFirebaseKey(driverId)) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    const security = await authorizeDriverLoginSecurity({ req, authUid: requestAuth.uid, driverId });
    if (!security.allowed) return res.status(security.status).json({ valid: false, reason: security.reason });

    const db = admin.database();
    const policyLock = await acquireDriverLoginPolicyLock({ db });
    if (!policyLock.acquired) {
      return res.status(503).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
    }

    try {
      let policyContext = await readDriverLoginPolicy({ db });
      if (policyContext.isDefault) policyContext = await ensureDriverLoginPolicy({ db });
      const policy = policyContext.policy;
      const driverAccess = await loadAuthorizedDriver({
        db, driverId, authUid: requestAuth.uid, policy,
      });
      if (!driverAccess.allowed) {
        return res.status(driverAccess.status).json({ valid: false, reason: driverAccess.reason });
      }
      const { driverData } = driverAccess;

      const assignment = await resolveDriverAssignment({ driverId, driverData, db });
      const assignedTourCode = assignment.assignedTourCode;
      const resolvedTour = await resolveDriverLoginTour({ db, assignment });

      const nowMs = Date.now();
      const currentPolicy = (await readDriverLoginPolicy({ db })).policy;
      if (currentPolicy.revision !== policy.revision
        || currentPolicy.generation !== policy.generation
        || currentPolicy.enforceSingleDevice !== policy.enforceSingleDevice) {
        return res.status(503).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
      }
      const driverProfileUpdates = buildDriverIdentityProfileUpdates({
        driverId,
        authUid: requestAuth.uid,
        assignedTourId: assignment.assignedTourId,
        nowMs,
      });
      const appSession = await issueDriverAppSession({
        db,
        authUid: requestAuth.uid,
        driverId,
        tourId: assignment.assignedTourId,
        driverLoginPolicyGeneration: currentPolicy.generation,
        profileUpdates: driverProfileUpdates,
        nowMs,
      });

      log.info('Driver login reference validated', {
        driverId,
        authUid: requestAuth.uid,
        assignedTourId: assignment.assignedTourId,
        assignmentSource: assignment.assignmentSource,
        hasResolvedTour: Boolean(resolvedTour),
      });

      return res.status(200).json({
        valid: true,
        type: 'driver',
        driver: {
          id: driverId,
          name: driverData.name || null,
          assignedTourId: assignment.assignedTourId,
          assignedTourCode,
          hasAssignedTour: Boolean(assignment.assignedTourId),
        },
        tour: resolvedTour,
        assignmentStatus: resolveAssignmentStatus(assignment.assignedTourId, resolvedTour),
        identityClaimed: currentPolicy.enforceSingleDevice,
        session: toClientSession(appSession),
      });
    } catch (error) {
      log.error('Driver login verification failed', error, {
        driverId,
        authUid: requestAuth.uid,
      });
      const reason = /** @type {{ code?: string }} */ (error)?.code === 'POLICY_CONFIGURATION_INVALID'
        ? 'SERVICE_UNAVAILABLE'
        : 'INTERNAL_ERROR';
      return res.status(reason === 'SERVICE_UNAVAILABLE' ? 503 : 500).json({ valid: false, reason });
    } finally {
      await releaseDriverLoginPolicyLock({ db, owner: policyLock.owner });
    }
  }
);

module.exports = { verifyDriverLogin };
