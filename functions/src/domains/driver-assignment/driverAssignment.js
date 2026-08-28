'use strict';

/* eslint-disable complexity -- canonical multi-path reconciliation enumerates guarded branches */

// @ts-check

const { createHash } = require('node:crypto');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');

const DRIVER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UNASSIGNED_DRIVER_SESSION_TTL_MS = 60 * 60 * 1000;
const POLICY_CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {any} current @param {number} nowMs */
const buildDriverLocationTombstone = (current, nowMs) => ({
  schemaVersion: 1,
  isSharing: false,
  timestamp: nowMs,
  projectionRevision: readAssignmentRevision(current?.projectionRevision) + 1,
});

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
    updates[`tours/${tourId}/driverLocation`] = buildDriverLocationTombstone(tourData.driverLocation, nowMs);
  }

  if (previousTourId && previousTourId !== tourId) {
    updates[`drivers/${driverId}/assignments/${previousTourId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_drivers/${driverId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_driver_codes/${driverId}`] = null;

    if (normalizeDriverId(previousTourData.driverId) === driverId) {
      updates[`tours/${previousTourId}/driverId`] = null;
      updates[`tours/${previousTourId}/driverName`] = null;
      updates[`tours/${previousTourId}/driverPhone`] = null;
      updates[`tours/${previousTourId}/driverLocation`] = buildDriverLocationTombstone(
        previousTourData.driverLocation, nowMs,
      );
    }
  }

  return { updates, previousTourId, canonicalTourCode };
};

/** @param {unknown} value */
const readAssignmentRevision = (value) => (
  Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0
);

/** @type {(...args: any[]) => void} */
const appendAssignmentPickupClear = ({ updates, pickups, tourId, driverIds, assignmentRevision }) => {
  const pickup = pickups?.[tourId];
  if (!pickup || pickup.schemaVersion !== 1 || pickup.isSharing !== true
    || pickup.source !== 'manual' || pickup.mode !== 'pickup'
    || pickup.tourId !== tourId || !driverIds.has(pickup.driverId)
    || !Number.isSafeInteger(pickup.assignmentRevision)
    || pickup.assignmentRevision !== assignmentRevision) return;
  updates[`driver_location_pickups/${tourId}`] = null;
};

/** @type {(...args: any[]) => any} */
const buildCurrentAssignmentProfileProjection = ({
  isAdmin,
  operation,
  driverId,
  tourId,
  expectedDriverRevision,
  expectedTourRevision,
  driverProfileUpdates,
  driverData = {},
  tourData = {},
  manifestData = {},
}) => {
  const normalizedDriverId = normalizeDriverId(driverId);
  const normalizedTourId = normalizeTourKeyForComparison(tourId);
  const name = resolveTrimmedString(driverProfileUpdates?.name);
  const phone = typeof driverProfileUpdates?.phone === 'string'
    ? driverProfileUpdates.phone.trim()
    : null;
  if (!isAdmin || operation !== 'assign' || !normalizedDriverId || !normalizedTourId
    || (!name && phone === null)) return { status: 'not_applicable' };
  if (readAssignmentRevision(driverData.assignmentRevision) !== expectedDriverRevision
    || readAssignmentRevision(tourData.driverAssignmentRevision) !== expectedTourRevision) {
    return { status: 'stale' };
  }
  const exactCurrentAssignment = normalizeTourKeyForComparison(driverData.currentTourId) === normalizedTourId
    && driverData.assignments?.[normalizedTourId] === true
    && normalizeDriverId(tourData.driverId) === normalizedDriverId
    && manifestData.assigned_drivers?.[normalizedDriverId] === true
    && collectDriverAssignmentConflicts({
      driverId: normalizedDriverId, tourData, manifestData,
    }).length === 0;
  if (!exactCurrentAssignment) return { status: 'assignment_changed' };

  const updates = {};
  if (name) {
    updates[`drivers/${normalizedDriverId}/name`] = name;
    updates[`tours/${normalizedTourId}/driverName`] = name;
  }
  if (phone !== null) {
    updates[`drivers/${normalizedDriverId}/phone`] = phone;
    updates[`tours/${normalizedTourId}/driverPhone`] = phone;
  }
  return {
    status: 'ready',
    updates,
    result: {
      success: true,
      operation: 'assign',
      driverId: normalizedDriverId,
      tourId: normalizedTourId,
      tourCode: resolveTrimmedString(tourData.tourCode) || normalizedTourId.replace(/_/g, ' '),
      previousTourId: normalizedTourId,
      driverRevision: expectedDriverRevision,
      tourRevision: expectedTourRevision,
    },
  };
};

/** @param {Record<string, any>} input */
const createAssignmentRequestHash = (input) => createHash('sha256').update(JSON.stringify({
  operation: resolveTrimmedString(input.operation),
  driverId: normalizeDriverId(input.driverId),
  tourId: normalizeTourKeyForComparison(input.tourId),
  expectedDriverRevision: readAssignmentRevision(input.expectedDriverRevision),
  expectedTourRevision: readAssignmentRevision(input.expectedTourRevision),
  driverProfileUpdates: input.driverProfileUpdates ? {
    name: resolveTrimmedString(input.driverProfileUpdates.name),
    phone: typeof input.driverProfileUpdates.phone === 'string'
      ? input.driverProfileUpdates.phone.trim()
      : null,
  } : null,
})).digest('hex');

/** @param {{ actorHash: string, idempotencyId: string }} input */
const createAssignmentTransitionId = ({ actorHash, idempotencyId }) => createHash('sha256')
  .update(`${actorHash}:${idempotencyId}`)
  .digest('hex')
  .slice(0, 40);

/** @param {any} session @param {any} policy @param {string} driverId @param {number} nowMs */
const isCurrentDriverSession = (session, policy, driverId, nowMs) => {
  if (!session || typeof session !== 'object' || session.principalType !== 'driver'
    || session.driverId !== driverId || session.status !== 'active'
    || !Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= nowMs
    || !Number.isSafeInteger(session.sessionRevision) || session.sessionRevision < 1) return false;
  const sessionGeneration = Number.isSafeInteger(session.driverLoginPolicyGeneration)
    ? session.driverLoginPolicyGeneration
    : 0;
  return sessionGeneration === policy.generation;
};

/** @param {any} profile @param {string} driverId */
const isCurrentDriverProfile = (profile, driverId) => (
  profile
  && typeof profile === 'object'
  && profile.principalType === 'driver'
  && normalizeDriverId(profile.driverId) === driverId
);

/** @param {any} value */
const hashAuthorityIdentifier = (value) => createHash('sha256')
  .update(String(value || ''))
  .digest('hex')
  .slice(0, 24);

/**
 * Builds assignment-owned handset authority updates without replacing a notification-device
 * record. Marketing consent, token and permission fields are therefore preserved verbatim.
 *
 * @type {(...args: any[]) => any}
 */
const buildDriverAssignmentReconciliationUpdates = ({
  driverId,
  targetTourId = null,
  sessions = {},
  profiles = {},
  devices = {},
  policy,
  driverData = {},
  nowMs = Date.now(),
}) => {
  const normalizedDriverId = normalizeDriverId(driverId);
  const normalizedTourId = targetTourId ? normalizeTourKeyForComparison(targetTourId) : null;
  const claimedAuthUid = resolveTrimmedString(driverData.authUid);
  const updates = {};
  const reconciledAuthUids = [];
  const obsoleteAuthUids = [];

  Object.entries(sessions || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([authUid, sessionValue]) => {
      const session = /** @type {any} */ (sessionValue);
      if (!isCurrentDriverSession(session, policy, normalizedDriverId, nowMs)) return;
      if (!isCurrentDriverProfile(profiles?.[authUid], normalizedDriverId)) return;
      if (policy.enforceSingleDevice === true && authUid !== claimedAuthUid) {
        obsoleteAuthUids.push(authUid);
        updates[`driver_login_policy_cleanup/v1/${authUid}`] = {
          schemaVersion: 1,
          authUidHash: hashAuthorityIdentifier(authUid),
          sessionId: session.sessionId,
          policyGeneration: policy.generation,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + POLICY_CLEANUP_TTL_MS,
        };
        return;
      }

      const nextRevision = session.sessionRevision + 1;
      const nextSession = {
        ...session,
        tourId: normalizedTourId,
        lastAuthenticatedAtMs: nowMs,
        expiresAtMs: nowMs + (normalizedTourId ? DRIVER_SESSION_TTL_MS : UNASSIGNED_DRIVER_SESSION_TTL_MS),
        sessionRevision: nextRevision,
      };
      reconciledAuthUids.push(authUid);
      updates[`app_sessions/${authUid}`] = nextSession;
      updates[`users/${authUid}/driverId`] = normalizedDriverId;
      updates[`users/${authUid}/driverPrincipalId`] = `driver:${normalizedDriverId}`;
      updates[`users/${authUid}/driverAssignedTourId`] = normalizedTourId;
      updates[`users/${authUid}/principalType`] = 'driver';
      updates[`users/${authUid}/lastUpdated`] = nowMs;

      const device = devices?.[authUid];
      if (!device || typeof device !== 'object') return;
      const exactOperationalBinding = device.operationalEligible === true
        && device.operationalSessionId === session.sessionId
        && Number(device.operationalSessionRevision) === session.sessionRevision;
      const devicePath = `notification_devices/${authUid}`;
      updates[`${devicePath}/operationalEligible`] = Boolean(normalizedTourId && exactOperationalBinding);
      updates[`${devicePath}/operationalTourId`] = normalizedTourId && exactOperationalBinding
        ? normalizedTourId
        : null;
      updates[`${devicePath}/operationalSessionId`] = normalizedTourId && exactOperationalBinding
        ? session.sessionId
        : null;
      updates[`${devicePath}/operationalSessionRevision`] = normalizedTourId && exactOperationalBinding
        ? nextRevision
        : null;
      updates[`${devicePath}/registrationRevision`] = readAssignmentRevision(device.registrationRevision) + 1;
      updates[`${devicePath}/lastMutationAction`] = 'assignment_reconcile';
      updates[`${devicePath}/lastMutationSessionId`] = session.sessionId;
      updates[`${devicePath}/authorityUpdatedAtMs`] = nowMs;
      updates[`${devicePath}/updatedAtMs`] = nowMs;
    });

  return { updates, reconciledAuthUids, obsoleteAuthUids };
};

/** @type {(...args: any[]) => any} */
const buildCanonicalDriverAssignmentUpdates = ({
  operation,
  driverId,
  driverData = {},
  tourId,
  tourData = {},
  previousTourData = {},
  incumbentDriverId = null,
  incumbentDriverData = {},
  incumbentDriversData = {},
  pickups = {},
  actorId,
  nowMs = Date.now(),
}) => {
  const assigned = operation === 'assign';
  const normalizedDriverId = normalizeDriverId(driverId);
  const normalizedTourId = normalizeTourKeyForComparison(tourId);
  const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
  const canonicalTourCode = resolveTrimmedString(tourData.tourCode) || normalizedTourId.replace(/_/g, ' ');
  const assignedAt = new Date(nowMs).toISOString();
  const updates = {
    [`tours/${normalizedTourId}/driverId`]: assigned ? normalizedDriverId : null,
    [`tours/${normalizedTourId}/driverName`]: assigned
      ? (resolveTrimmedString(driverData.name) || normalizedDriverId)
      : 'TBA',
    [`tours/${normalizedTourId}/driverPhone`]: assigned
      ? (resolveTrimmedString(driverData.phone) || null)
      : '',
    [`tours/${normalizedTourId}/driverLocation`]: buildDriverLocationTombstone(
      tourData.driverLocation, nowMs,
    ),
    [`tours/${normalizedTourId}/driverAssignmentRevision`]: readAssignmentRevision(tourData.driverAssignmentRevision) + 1,
    [`drivers/${normalizedDriverId}/currentTourId`]: assigned ? normalizedTourId : null,
    [`drivers/${normalizedDriverId}/currentTourCode`]: assigned ? canonicalTourCode : null,
    [`drivers/${normalizedDriverId}/assignments/${normalizedTourId}`]: assigned ? true : null,
    [`drivers/${normalizedDriverId}/assignmentRevision`]: readAssignmentRevision(driverData.assignmentRevision) + 1,
    [`tour_manifests/${normalizedTourId}/assigned_drivers/${normalizedDriverId}`]: assigned ? true : null,
    [`tour_manifests/${normalizedTourId}/assigned_driver_codes/${normalizedDriverId}`]: assigned ? {
      driverId: normalizedDriverId,
      tourId: normalizedTourId,
      tourCode: canonicalTourCode,
      assignedAt,
      assignedBy: actorId,
    } : null,
  };

  if (previousTourId && previousTourId !== normalizedTourId) {
    updates[`drivers/${normalizedDriverId}/assignments/${previousTourId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_drivers/${normalizedDriverId}`] = null;
    updates[`tour_manifests/${previousTourId}/assigned_driver_codes/${normalizedDriverId}`] = null;
    if (normalizeDriverId(previousTourData.driverId) === normalizedDriverId) {
      updates[`tours/${previousTourId}/driverId`] = null;
      updates[`tours/${previousTourId}/driverName`] = 'TBA';
      updates[`tours/${previousTourId}/driverPhone`] = '';
      updates[`tours/${previousTourId}/driverLocation`] = buildDriverLocationTombstone(
        previousTourData.driverLocation, nowMs,
      );
      updates[`tours/${previousTourId}/driverAssignmentRevision`] = readAssignmentRevision(
        previousTourData.driverAssignmentRevision,
      ) + 1;
    }
  }

  const displacedDrivers = new Map(Object.entries(incumbentDriversData || {})
    .map(([candidateDriverId, candidateData]) => [normalizeDriverId(candidateDriverId), candidateData || {}])
    .filter(([candidateDriverId]) => candidateDriverId && candidateDriverId !== normalizedDriverId));
  const normalizedIncumbent = normalizeDriverId(incumbentDriverId);
  if (normalizedIncumbent && normalizedIncumbent !== normalizedDriverId
    && !displacedDrivers.has(normalizedIncumbent)) {
    displacedDrivers.set(normalizedIncumbent, incumbentDriverData || {});
  }
  if (assigned) {
    for (const [displacedDriverId, displacedDriverData] of displacedDrivers) {
      updates[`drivers/${displacedDriverId}/assignments/${normalizedTourId}`] = null;
      updates[`tour_manifests/${normalizedTourId}/assigned_drivers/${displacedDriverId}`] = null;
      updates[`tour_manifests/${normalizedTourId}/assigned_driver_codes/${displacedDriverId}`] = null;
      if (normalizeTourKeyForComparison(displacedDriverData.currentTourId) === normalizedTourId) {
        updates[`drivers/${displacedDriverId}/currentTourId`] = null;
        updates[`drivers/${displacedDriverId}/currentTourCode`] = null;
      }
      updates[`drivers/${displacedDriverId}/assignmentRevision`] = readAssignmentRevision(
        displacedDriverData.assignmentRevision,
      ) + 1;
    }
  }

  const targetOutgoingDriverIds = new Set([
    normalizeDriverId(tourData.driverId),
    ...displacedDrivers.keys(),
    ...(!assigned ? [normalizedDriverId] : []),
  ].filter(Boolean));
  appendAssignmentPickupClear({
    updates,
    pickups,
    tourId: normalizedTourId,
    driverIds: targetOutgoingDriverIds,
    assignmentRevision: readAssignmentRevision(tourData.driverAssignmentRevision),
  });
  if (previousTourId && previousTourId !== normalizedTourId
    && normalizeDriverId(previousTourData.driverId) === normalizedDriverId) {
    appendAssignmentPickupClear({
      updates,
      pickups,
      tourId: previousTourId,
      driverIds: new Set([normalizedDriverId]),
      assignmentRevision: readAssignmentRevision(previousTourData.driverAssignmentRevision),
    });
  }

  return { updates, previousTourId, canonicalTourCode };
};


module.exports = {
  buildCurrentAssignmentProfileProjection,
  buildDriverIdentityProfileUpdates,
  buildDriverLocationTombstone,
  buildDriverAssignmentReconciliationUpdates,
  buildCanonicalDriverAssignmentUpdates,
  buildDriverSelfAssignmentUpdates,
  claimDriverAuthUid,
  collectDriverAssignmentConflicts,
  createAssignmentRequestHash,
  createAssignmentTransitionId,
  hashAuthorityIdentifier,
  normalizeDriverId,
  readAssignmentRevision,
  resolveDriverAssignment,
};
