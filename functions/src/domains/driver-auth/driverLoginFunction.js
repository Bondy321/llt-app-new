'use strict';

/* eslint-disable complexity -- login coordinates independent policy, assignment and claim admissions */

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { issueDriverAppSession } = require('../app-sessions/public');
const { ensureNoActiveAccountDeletion } = require('../account-deletion/public');
const {
  acquireDriverAssignmentLoginAdmission,
  buildDriverIdentityProfileUpdates,
  normalizeDriverId,
  releaseDriverAssignmentLoginAdmission,
  resolveDriverAssignment,
} = require('../driver-assignment/public');
const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { authorizeDriverLoginSecurity } = require('./driverLoginSecurity');
const {
  acquireDriverLoginAdmission,
  completeDriverLoginAdmission,
  driverBindingAllowedByPolicy,
  ensureDriverLoginPolicy,
  readDriverLoginPolicy,
  hashPolicyIdentifier,
  releaseDriverLoginAdmission,
  releaseDriverLoginClaim,
  reserveDriverLoginClaim,
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
    log.warn('Driver login rejected: driver not found', {
      driverId, authUidHash: hashPolicyIdentifier(authUid),
    });
    return { allowed: false, status: 200, reason: 'DRIVER_NOT_FOUND' };
  }
  const driverData = driverSnapshot.val() || {};
  const claimedAuthUid = resolveTrimmedString(driverData.authUid);
  if (!driverBindingAllowedByPolicy({ policy, authUid, claimedAuthUid })) {
    log.warn('Driver login rejected: driver code already linked to another auth uid', {
      driverId, authUidHash: hashPolicyIdentifier(authUid),
    });
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
    let admission = null;
    let claimReservation = null;
    let admissionCompleted = false;
    let assignmentLoginAdmission = null;

    try {
      await ensureNoActiveAccountDeletion({ db, authUid: requestAuth.uid });
      assignmentLoginAdmission = await acquireDriverAssignmentLoginAdmission({
        db,
        driverId,
        admissionId: `driver_login_${randomUUID()}`,
        authUidHash: hashPolicyIdentifier(requestAuth.uid),
      });
      if (!assignmentLoginAdmission.acquired) {
        return res.status(409).json({ valid: false, reason: 'ASSIGNMENT_IN_PROGRESS' });
      }
      let policyContext = await readDriverLoginPolicy({ db });
      if (policyContext.isDefault) policyContext = await ensureDriverLoginPolicy({ db });
      admission = await acquireDriverLoginAdmission({
        db,
        authUid: requestAuth.uid,
        driverId,
      });
      if (!admission.acquired) {
        const reason = admission.reason === 'POLICY_CONFIGURATION_INVALID'
          ? 'SERVICE_UNAVAILABLE'
          : 'DRIVER_POLICY_CHANGE_IN_PROGRESS';
        return res.status(503).json({ valid: false, reason });
      }
      const policy = admission.policy;
      const driverAccess = await loadAuthorizedDriver({
        db, driverId, authUid: requestAuth.uid, policy,
      });
      if (!driverAccess.allowed) {
        return res.status(driverAccess.status).json({ valid: false, reason: driverAccess.reason });
      }
      const { driverData } = driverAccess;

      if (policy.enforceSingleDevice) {
        claimReservation = await reserveDriverLoginClaim({
          db,
          driverId,
          admissionId: admission.admissionId,
        });
        if (!claimReservation.acquired) {
          return res.status(409).json({ valid: false, reason: 'DRIVER_LOGIN_IN_PROGRESS' });
        }
        const latestDriver = (await db.ref(`drivers/${driverId}`).once('value')).val() || {};
        const currentClaim = resolveTrimmedString(latestDriver.authUid);
        if (currentClaim && currentClaim !== requestAuth.uid) {
          return res.status(403).json({ valid: false, reason: 'DRIVER_ALREADY_LINKED' });
        }
      }

      const assignment = await resolveDriverAssignment({ driverId, driverData, db });
      const assignedTourCode = assignment.assignedTourCode;
      const resolvedTour = await resolveDriverLoginTour({ db, assignment });

      const nowMs = Date.now();
      const driverProfileUpdates = buildDriverIdentityProfileUpdates({
        driverId,
        authUid: requestAuth.uid,
        assignedTourId: assignment.assignedTourId,
        nowMs,
      });
      if (policy.enforceSingleDevice) {
        driverProfileUpdates[`drivers/${driverId}/authUid`] = requestAuth.uid;
        driverProfileUpdates[claimReservation.path] = null;
      }
      const appSession = await issueDriverAppSession({
        db,
        authUid: requestAuth.uid,
        driverId,
        tourId: assignment.assignedTourId,
        driverLoginPolicyGeneration: policy.generation,
        profileUpdates: driverProfileUpdates,
        nowMs,
      });
      admissionCompleted = await completeDriverLoginAdmission({
        db, admissionId: admission.admissionId, policy,
      });
      if (!admissionCompleted) {
        // Issuance has already committed atomically. Never hide that new
        // session behind a non-success response; policy-generation checks
        // still fail closed if a barrier somehow advanced after admission.
        log.warn('Driver login admission completion lost its policy fence', {
          driverId,
          authUidHash: hashPolicyIdentifier(requestAuth.uid),
        });
      }

      log.info('Driver login reference validated', {
        driverId,
        authUidHash: hashPolicyIdentifier(requestAuth.uid),
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
        identityClaimed: policy.enforceSingleDevice,
        session: toClientSession(appSession),
      });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === 'ACCOUNT_DELETION_IN_PROGRESS') {
        return res.status(409).json({ valid: false, reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
      }
      log.error('Driver login verification failed', error, {
        driverId,
        authUidHash: hashPolicyIdentifier(requestAuth.uid),
      });
      const reason = code === 'POLICY_CONFIGURATION_INVALID'
        ? 'SERVICE_UNAVAILABLE'
        : (code === 'SESSION_IN_PROGRESS' ? 'SESSION_IN_PROGRESS' : 'INTERNAL_ERROR');
      const status = reason === 'INTERNAL_ERROR' ? 500 : 503;
      return res.status(status).json({ valid: false, reason });
    } finally {
      if (claimReservation?.acquired && !admissionCompleted) {
        await releaseDriverLoginClaim({ db, driverId, admissionId: admission?.admissionId });
      }
      if (admission?.acquired && !admissionCompleted) {
        await releaseDriverLoginAdmission({ db, admissionId: admission.admissionId });
      }
      if (assignmentLoginAdmission?.acquired) {
        await releaseDriverAssignmentLoginAdmission({
          db, driverId, admissionId: assignmentLoginAdmission.admissionId,
        });
      }
    }
  }
);

module.exports = { verifyDriverLogin };
