'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { issueDriverAppSession } = require('../app-sessions/sessionIssuance');
const { buildDriverIdentityProfileUpdates, claimDriverAuthUid, normalizeDriverId, resolveDriverAssignment } = require('../driver-assignment/driverAssignment');
const { resolveTrimmedString } = require('../notifications/notificationPolicy');
const { authorizeDriverLoginSecurity } = require('./driverLoginSecurity');
const { toClientSession } = loadLegacyLibrary('appSession');

const onRequestWithResult = /** @type {any} */ (onRequest);

/** @param {string | null} assignedTourId @param {any} resolvedTour */
const resolveAssignmentStatus = (assignedTourId, resolvedTour) => {
  if (!assignedTourId) return 'UNASSIGNED';
  return resolvedTour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND';
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

    try {
      const db = admin.database();
      const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
      if (!driverSnapshot.exists()) {
        log.warn('Driver login rejected: driver not found', { driverId, authUid: requestAuth.uid });
        return res.status(200).json({ valid: false, reason: 'DRIVER_NOT_FOUND' });
      }

      const driverData = driverSnapshot.val() || {};
      const claimedAuthUid = resolveTrimmedString(driverData.authUid);
      if (claimedAuthUid && claimedAuthUid !== requestAuth.uid) {
        log.warn('Driver login rejected: driver code already linked to another auth uid', {
          driverId,
          authUid: requestAuth.uid,
        });
        return res.status(403).json({ valid: false, reason: 'DRIVER_ALREADY_LINKED' });
      }

      const claimResult = await claimDriverAuthUid({
        db,
        driverId,
        authUid: requestAuth.uid,
      });
      if (!claimResult.claimed) {
        log.warn('Driver login rejected: driver claim lost to another auth uid', {
          driverId,
          authUid: requestAuth.uid,
        });
        return res.status(403).json({ valid: false, reason: 'DRIVER_ALREADY_LINKED' });
      }

      const assignment = await resolveDriverAssignment({ driverId, driverData, db });
      let assignedTourCode = assignment.assignedTourCode;
      let resolvedTour = null;

      if (assignment.assignedTourId) {
        const tourSnapshot = await db.ref(`tours/${assignment.assignedTourId}`).once('value');
        if (tourSnapshot.exists()) {
          const tourData = tourSnapshot.val() || {};
          resolvedTour = {
            id: assignment.assignedTourId,
            ...tourData,
          };
        }
      }

      const nowMs = Date.now();
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
        identityClaimed: true,
        session: toClientSession(appSession),
      });
    } catch (error) {
      log.error('Driver login verification failed', error, {
        driverId,
        authUid: requestAuth.uid,
      });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);

module.exports = { verifyDriverLogin };
