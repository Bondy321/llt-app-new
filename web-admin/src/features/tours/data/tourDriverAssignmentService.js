import {
  ref,
  update,
  get,
  db,
  nowAsISOString,
  trimTourCode,
  normalizeAssignmentTourId,
  resolveAssignmentTourId,
  getDriverSnapshotValue,
} from './tourServiceContext';

export const assignDriver = async (tourId, driverId, driverInfo) => {
  await applyDriverAssignmentMutation({
    tourId,
    driverId,
    driverCode: driverId,
    driverInfo,
    isAssigned: true,
  });

  return { tourId, driverId, assigned: true };
};

/**
 * Unassign driver from a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID (optional)
 */
export const unassignDriver = async (tourId, driverId = null) => {
  await applyDriverAssignmentMutation({
    tourId,
    driverId,
    driverCode: driverId,
    driverInfo: { name: 'TBA', phone: '' },
    isAssigned: false,
  });

  return { tourId, unassigned: true };
};

const getDriverAssignmentContext = async (tourId, explicitDriverId = null) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  const [tourSnapshot, manifestSnapshot] = await Promise.all([
    get(ref(db, `tours/${normalizedTourId}`)),
    get(ref(db, `tour_manifests/${normalizedTourId}`)),
  ]);

  const tour = tourSnapshot.val() || {};
  const manifest = manifestSnapshot.val() || {};
  const manifestDrivers = manifest.assigned_drivers || {};
  const manifestDriverIds = Object.keys(manifestDrivers);
  const resolvedDriverId = explicitDriverId || manifestDriverIds[0] || null;

  const driver = await getDriverSnapshotValue(resolvedDriverId);
  const currentTourId = resolveAssignmentTourId(driver.currentTourId);
  const assignments = driver.assignments || {};
  const tourCode = trimTourCode(tour?.tourCode);
  if (!tourCode) {
    throw new Error('Tour code is required for driver assignment');
  }

  const knownTourIds = new Set([
    ...Object.keys(assignments).map(normalizeAssignmentTourId).filter(Boolean),
    ...(currentTourId ? [currentTourId] : []),
  ]);

  const staleManifestDriverProfiles = {};
  await Promise.all(
    manifestDriverIds
      .filter((manifestDriverId) => manifestDriverId !== resolvedDriverId)
      .map(async (manifestDriverId) => {
        staleManifestDriverProfiles[manifestDriverId] = await getDriverSnapshotValue(manifestDriverId);
      })
  );

  return {
    tourId: normalizedTourId,
    tourCode,
    driverId: resolvedDriverId,
    existingTourDriverId: typeof tour.driverId === 'string' ? tour.driverId.trim() : null,
    driverCode: resolvedDriverId,
    driverAuthUid: driver.authUid || null,
    manifestDriverIds,
    staleManifestDriverProfiles,
    currentTourId,
    assignments,
    knownTourIds,
  };
};

const buildTourDriverFields = (tourId, driverId, driverInfo, isAssigned) => ({
  [`tours/${tourId}/driverName`]: isAssigned ? driverInfo.name : 'TBA',
  [`tours/${tourId}/driverPhone`]: isAssigned ? (driverInfo.phone || '') : '',
  [`tours/${tourId}/driverId`]: isAssigned ? (driverId || null) : null,
});

const appendDriverIdentityUpdates = (updates, { driverId, driverInfo, isAssigned, tourId }) => {
  const driverAuthUid = typeof driverInfo?.authUid === 'string' ? driverInfo.authUid.trim() : '';
  if (!driverAuthUid) return;
  Object.assign(updates, {
    [`users/${driverAuthUid}/driverId`]: driverId,
    [`users/${driverAuthUid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${driverAuthUid}/driverAssignedTourId`]: isAssigned ? tourId : null,
    [`users/${driverAuthUid}/principalType`]: 'driver',
    [`users/${driverAuthUid}/lastUpdated`]: Date.now(),
  });
};

const appendManifestAssignmentUpdates = (updates, {
  actorId, assignedAt, driverId, isAssigned, tourCode, tourId,
}) => {
  updates[`tour_manifests/${tourId}/assigned_drivers/${driverId}`] = isAssigned ? true : null;
  updates[`tour_manifests/${tourId}/assigned_driver_codes/${driverId}`] = isAssigned
    ? { driverId, tourId, tourCode, assignedAt, assignedBy: actorId }
    : null;
};

/**
 * Build canonical multi-path updates for driver assignment mutations.
 * Mirrors mobile assignDriverToTour() contract for cross-platform consistency.
 */
export const buildDriverAssignmentUpdates = ({
  tourId,
  driverId,
  driverCode: _driverCode,
  tourCode,
  driverInfo,
  isAssigned,
  actorId = 'web-admin',
  assignedAt = nowAsISOString(),
}) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) {
    throw new Error('Tour ID is required for driver assignment');
  }
  const normalizedTourCode = trimTourCode(tourCode);
  if (isAssigned && !normalizedTourCode) {
    throw new Error('Tour code is required for driver assignment');
  }

  const updates = buildTourDriverFields(normalizedTourId, driverId, driverInfo, isAssigned);

  if (!driverId) {
    return updates;
  }

  updates[`drivers/${driverId}/currentTourId`] = isAssigned ? normalizedTourId : null;
  updates[`drivers/${driverId}/currentTourCode`] = isAssigned ? normalizedTourCode : null;
  updates[`drivers/${driverId}/assignments/${normalizedTourId}`] = isAssigned ? true : null;

  appendDriverIdentityUpdates(updates, {
    driverId, driverInfo, isAssigned, tourId: normalizedTourId,
  });
  appendManifestAssignmentUpdates(updates, {
    actorId,
    assignedAt,
    driverId,
    isAssigned,
    tourCode: normalizedTourCode,
    tourId: normalizedTourId,
  });

  return updates;
};

const appendDriverProfileUpdates = (updates, driverId, driverProfileUpdates) => {
  const nextName = typeof driverProfileUpdates?.name === 'string'
    ? driverProfileUpdates.name.trim()
    : '';
  const nextPhone = typeof driverProfileUpdates?.phone === 'string'
    ? driverProfileUpdates.phone.trim()
    : null;
  if (nextName) updates[`drivers/${driverId}/name`] = nextName;
  if (nextPhone !== null) updates[`drivers/${driverId}/phone`] = nextPhone;
};

const appendPreviousTourCleanup = (updates, assignment, driverId, targetTourId) => {
  const cleanupTourIds = new Set(assignment.knownTourIds || []);
  cleanupTourIds.delete(targetTourId);
  for (const oldTourId of cleanupTourIds) {
    Object.assign(updates, {
      [`drivers/${driverId}/assignments/${oldTourId}`]: null,
      [`tour_manifests/${oldTourId}/assigned_drivers/${driverId}`]: null,
      [`tour_manifests/${oldTourId}/assigned_driver_codes/${driverId}`]: null,
      [`tours/${oldTourId}/driverName`]: 'TBA',
      [`tours/${oldTourId}/driverPhone`]: '',
      [`tours/${oldTourId}/driverId`]: null,
      [`tours/${oldTourId}/driverLocation`]: null,
    });
  }
};

const appendStaleDriverCleanup = (updates, assignment, resolvedDriverId, targetTourId) => {
  for (const existingDriverId of assignment.manifestDriverIds || []) {
    if (existingDriverId === resolvedDriverId) continue;
    const staleProfile = assignment.staleManifestDriverProfiles?.[existingDriverId] || {};
    const staleCurrentTourId = resolveAssignmentTourId(staleProfile.currentTourId);
    updates[`drivers/${existingDriverId}/assignments/${targetTourId}`] = null;
    updates[`tour_manifests/${targetTourId}/assigned_drivers/${existingDriverId}`] = null;
    updates[`tour_manifests/${targetTourId}/assigned_driver_codes/${existingDriverId}`] = null;
    if (!staleCurrentTourId || staleCurrentTourId === targetTourId) {
      updates[`drivers/${existingDriverId}/currentTourId`] = null;
      updates[`drivers/${existingDriverId}/currentTourCode`] = null;
    }
    const staleAuthUid = typeof staleProfile.authUid === 'string' ? staleProfile.authUid.trim() : '';
    if (staleAuthUid) {
      updates[`users/${staleAuthUid}/driverAssignedTourId`] = null;
      updates[`users/${staleAuthUid}/lastUpdated`] = Date.now();
    }
  }
};

export const applyDriverAssignmentMutation = async ({
  tourId,
  driverId,
  driverCode,
  driverInfo,
  isAssigned,
  actorId,
  driverProfileUpdates,
}) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) {
    throw new Error('Tour ID is required for driver assignment');
  }

  const assignment = await getDriverAssignmentContext(normalizedTourId, driverId);
  const resolvedDriverId = driverId || assignment.driverId;
  const resolvedDriverCode = driverCode || assignment.driverCode;

  const updates = buildTourDriverFields(normalizedTourId, resolvedDriverId, driverInfo, isAssigned);

  if (!resolvedDriverId) {
    await update(ref(db), updates);
    return;
  }

  appendDriverProfileUpdates(updates, resolvedDriverId, driverProfileUpdates);
  appendPreviousTourCleanup(updates, assignment, resolvedDriverId, normalizedTourId);
  appendStaleDriverCleanup(updates, assignment, resolvedDriverId, normalizedTourId);

  Object.assign(
    updates,
    buildDriverAssignmentUpdates({
      tourId: normalizedTourId,
      driverId: resolvedDriverId,
      driverCode: resolvedDriverCode,
      tourCode: assignment.tourCode,
      driverInfo: {
        ...driverInfo,
        authUid: driverInfo?.authUid || assignment.driverAuthUid || null,
      },
      isAssigned,
      actorId,
    }),
  );

  if (!isAssigned || assignment.existingTourDriverId !== resolvedDriverId) {
    updates[`tours/${normalizedTourId}/driverLocation`] = null;
  }

  await update(ref(db), updates);
};

/**
 * Update tour active status
 * @param {string} tourId - Tour ID
 * @param {boolean} isActive - Active status
 */
