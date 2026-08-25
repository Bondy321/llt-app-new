'use strict';

// @ts-check

const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../notifications/notificationPolicy');

/** @type {(...args: any[]) => any} */
const normalizeDriverId = (driverId) => {
  if (typeof driverId !== 'string') return '';
  return driverId.trim().toUpperCase();
};

/** @type {(...args: any[]) => Promise<any>} */
const resolveDriverAssignment = async ({ driverId: _driverId, driverData = {} }) => {
  const assignedTourId = normalizeTourKeyForComparison(driverData.currentTourId);
  const assignedTourCode = resolveTrimmedString(driverData.currentTourCode);

  if (assignedTourId) {
    return {
      assignedTourId,
      assignedTourCode,
      assignmentSource: 'driver_profile',
    };
  }

  return {
    assignedTourId: null,
    assignedTourCode: null,
    assignmentSource: 'unassigned',
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const claimDriverAuthUid = async ({ db, driverId, authUid }) => {
  const claimRef = db.ref(`drivers/${driverId}/authUid`);
  const result = await claimRef.transaction(/** @param {unknown} currentValue */ (currentValue) => {
    const currentAuthUid = resolveTrimmedString(currentValue);
    if (currentAuthUid && currentAuthUid !== authUid) return undefined;
    return authUid;
  }, undefined, false);
  const claimedAuthUid = resolveTrimmedString(result?.snapshot?.val?.());

  return {
    claimed: Boolean(result?.committed && claimedAuthUid === authUid),
    authUid: claimedAuthUid || null,
  };
};

/** @type {(...args: any[]) => any} */
const buildDriverIdentityProfileUpdates = ({
  driverId,
  authUid,
  assignedTourId = null,
  nowMs = Date.now(),
}) => ({
  [`drivers/${driverId}/lastActive`]: new Date(nowMs).toISOString(),
  [`users/${authUid}/driverId`]: driverId,
  [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
  [`users/${authUid}/driverAssignedTourId`]: assignedTourId || null,
  [`users/${authUid}/principalType`]: 'driver',
  [`users/${authUid}/lastUpdated`]: nowMs,
});

/** @type {(...args: any[]) => any} */
const collectDriverAssignmentConflicts = ({ driverId, tourData = {}, manifestData = {} }) => {
  const conflicts = new Set();
  const tourDriverId = normalizeDriverId(tourData.driverId);
  if (tourDriverId && tourDriverId !== driverId) conflicts.add(tourDriverId);

  Object.entries(manifestData.assigned_drivers || {}).forEach(([candidateDriverId, assigned]) => {
    const normalizedCandidate = normalizeDriverId(candidateDriverId);
    if (assigned === true && normalizedCandidate && normalizedCandidate !== driverId) {
      conflicts.add(normalizedCandidate);
    }
  });

  return [...conflicts].sort();
};

/** @type {(...args: any[]) => any} */
const buildDriverSelfAssignmentUpdates = ({
  driverId,
  authUid,
  driverData = {},
  tourId,
  tourData = {},
  previousTourData = {},
  nowMs = Date.now(),
}) => {
  const canonicalTourCode = resolveTrimmedString(tourData.tourCode) || tourId.replace(/_/g, ' ');
  const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
  const assignedAt = new Date(nowMs).toISOString();
  const driverName = resolveTrimmedString(driverData.name) || driverId;
  const driverPhone = resolveTrimmedString(driverData.phone);
  const updates = {
    [`tours/${tourId}/driverId`]: driverId,
    [`tours/${tourId}/driverName`]: driverName,
    [`tours/${tourId}/driverPhone`]: driverPhone || null,
    [`drivers/${driverId}/currentTourId`]: tourId,
    [`drivers/${driverId}/currentTourCode`]: canonicalTourCode,
    [`drivers/${driverId}/assignments/${tourId}`]: true,
    [`drivers/${driverId}/lastActive`]: assignedAt,
    [`users/${authUid}/driverId`]: driverId,
    [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${authUid}/driverAssignedTourId`]: tourId,
    [`users/${authUid}/principalType`]: 'driver',
    [`users/${authUid}/lastUpdated`]: nowMs,
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    [`tour_manifests/${tourId}/assigned_driver_codes/${driverId}`]: {
      driverId,
      tourId,
      tourCode: canonicalTourCode,
      assignedAt,
      assignedBy: authUid,
    },
  };

  if (previousTourId !== tourId) {
    // Never carry coordinates from an earlier assignment (or a previous driver
    // on the target tour) into the newly authorized driver session.
    updates[`tours/${tourId}/driverLocation`] = null;
  }

  if (previousTourId && previousTourId !== tourId) {
    updates[`drivers/${driverId}/assignments/${previousTourId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_drivers/${driverId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_driver_codes/${driverId}`] = null;

    if (normalizeDriverId(previousTourData.driverId) === driverId) {
      updates[`tours/${previousTourId}/driverId`] = null;
      updates[`tours/${previousTourId}/driverName`] = null;
      updates[`tours/${previousTourId}/driverPhone`] = null;
      updates[`tours/${previousTourId}/driverLocation`] = null;
    }
  }

  return { updates, previousTourId, canonicalTourCode };
};


module.exports = {
  buildDriverIdentityProfileUpdates,
  buildDriverSelfAssignmentUpdates,
  claimDriverAuthUid,
  collectDriverAssignmentConflicts,
  normalizeDriverId,
  resolveDriverAssignment,
};
