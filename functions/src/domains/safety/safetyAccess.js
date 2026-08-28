'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { isDriverProfileAssignedToTour } = require('../notifications/public');
const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

/** @type {(...args: any[]) => Promise<any>} */
const resolveSafetyReporterAccess = async ({ db, authUid, tourId, requestedRole }) => {
  const [participantSnapshot, userSnapshot, manifestSnapshot] = await Promise.all([
    db.ref(`tours/${tourId}/participants/${authUid}`).once('value'),
    db.ref(`users/${authUid}`).once('value'),
    db.ref(`tour_manifests/${tourId}`).once('value'),
  ]);
  const userData = userSnapshot.val() || {};
  const manifestData = manifestSnapshot.val() || {};
  const driverId = resolveTrimmedString(userData.driverId);
  let isAssignedDriver = false;
  if (driverId && isValidFirebaseKey(driverId) && manifestData?.assigned_drivers?.[driverId] === true) {
    const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
    const driverData = driverSnapshot.val() || {};
    const sessionAccess = await verifyActiveAppSession({
      db, authUid, expectedTourId: tourId, expectedRole: 'driver',
    });
    isAssignedDriver = sessionAccess.allowed
      && sessionAccess.driverId === driverId
      && isDriverProfileAssignedToTour(driverData, tourId);
  }

  if (requestedRole === 'driver' && isAssignedDriver) {
    return { allowed: true, role: 'driver', principalId: `driver:${driverId}` };
  }
  if (requestedRole === 'passenger' && participantSnapshot.exists()) {
    const principalId = resolveTrimmedString(userData.stablePassengerId)
      || resolveTrimmedString(userData.privatePhotoOwnerId)
      || authUid;
    return { allowed: true, role: 'passenger', principalId };
  }
  return { allowed: false, role: requestedRole, principalId: null };
};


module.exports = { resolveSafetyReporterAccess };
