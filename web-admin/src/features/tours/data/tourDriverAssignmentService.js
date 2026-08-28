import {
  db,
  get,
  normalizeAssignmentTourId,
  nowAsISOString,
  postAdminAction,
  ref,
  trimTourCode,
} from './tourServiceContext';

/* eslint-disable complexity -- compatibility projection helper enumerates canonical paths */

const ASSIGNMENT_REASON_MESSAGES = {
  ASSIGNMENT_ALREADY_CHANGED: 'The assignment changed while this request was being processed. Refresh and try again.',
  ASSIGNMENT_IN_PROGRESS: 'Another assignment change is still in progress. Wait a moment and try again.',
  ASSIGNMENT_STALE: 'This tour or driver changed after you opened it. Refresh before trying again.',
  DRIVER_POLICY_CHANGE_IN_PROGRESS: 'Driver sign-in settings are being updated. Please try again.',
  IDEMPOTENCY_CONFLICT: 'This assignment request no longer matches the original action. Refresh and try again.',
  POLICY_CONFIGURATION_INVALID: 'Driver sign-in settings need administrator attention before assignments can change.',
  TOUR_INACTIVE: 'This tour is inactive and cannot be assigned.',
  TOUR_NOT_FOUND: 'The tour no longer exists. Refresh the tour list.',
  DRIVER_NOT_FOUND: 'The driver no longer exists. Refresh the driver list.',
};

const readRevision = (value) => (
  Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0
);

const createIdempotencyKey = (operation, tourId, driverId) => {
  const nonce = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `admin-assignment:${operation}:${tourId}:${driverId}:${nonce}`;
};

// A 409 continuation is not a failed assignment attempt. Keep the exact key
// and optimistic revisions until that transition completes so a UI retry
// resumes the same durable server transition instead of creating a contender.
const pendingAssignmentAttempts = new Map();

const runAssignmentAttempt = async ({ operation, context, options, driverProfileUpdates }) => {
  const attemptPath = `${operation}:${context.tourId}:${context.driverId}`;
  const explicitKey = options.idempotencyKey || null;
  const existing = explicitKey ? null : pendingAssignmentAttempts.get(attemptPath);
  const attempt = existing || {
    idempotencyKey: explicitKey || createIdempotencyKey(operation, context.tourId, context.driverId),
    expectedDriverRevision: options.expectedDriverRevision
      ?? readRevision(context.driver.assignmentRevision),
    expectedTourRevision: options.expectedTourRevision
      ?? readRevision(context.tour.driverAssignmentRevision),
    driverProfileUpdates,
  };
  if (!explicitKey && !existing) pendingAssignmentAttempts.set(attemptPath, attempt);
  try {
    const result = await postAssignment({
      operation,
      tourId: context.tourId,
      driverId: context.driverId,
      ...attempt,
    });
    if (!explicitKey && pendingAssignmentAttempts.get(attemptPath) === attempt) {
      pendingAssignmentAttempts.delete(attemptPath);
    }
    return result;
  } catch (error) {
    if (error?.code !== 'ASSIGNMENT_IN_PROGRESS'
      && !explicitKey && pendingAssignmentAttempts.get(attemptPath) === attempt) {
      pendingAssignmentAttempts.delete(attemptPath);
    }
    throw error;
  }
};

const loadAssignmentContext = async (tourId, explicitDriverId = null) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) throw new Error('Tour ID is required for driver assignment');
  const [tourSnapshot, manifestSnapshot] = await Promise.all([
    get(ref(db, `tours/${normalizedTourId}`)),
    get(ref(db, `tour_manifests/${normalizedTourId}`)),
  ]);
  if (!tourSnapshot.exists()) throw new Error('The tour no longer exists. Refresh the tour list.');
  const tour = tourSnapshot.val() || {};
  const manifestDrivers = Object.keys(manifestSnapshot.val()?.assigned_drivers || {});
  const driverId = explicitDriverId || tour.driverId || manifestDrivers[0] || null;
  if (!driverId) throw new Error('No assigned driver was found. Refresh the tour list.');
  const driverSnapshot = await get(ref(db, `drivers/${driverId}`));
  if (!driverSnapshot.exists()) throw new Error('The driver no longer exists. Refresh the driver list.');
  return {
    tourId: normalizedTourId,
    driverId,
    tour: tour,
    driver: driverSnapshot.val() || {},
  };
};

const postAssignment = async ({
  operation,
  tourId,
  driverId,
  driverProfileUpdates = null,
  expectedDriverRevision,
  expectedTourRevision,
  idempotencyKey,
}) => postAdminAction('assignDriverToTour', {
  operation,
  tourId,
  driverId,
  expectedDriverRevision,
  expectedTourRevision,
  idempotencyKey,
  ...(driverProfileUpdates ? { driverProfileUpdates } : {}),
}, {
  configurationError: 'Driver assignment is not configured for this deployment.',
  fallbackError: 'The driver assignment could not be completed safely.',
  reasonMessages: ASSIGNMENT_REASON_MESSAGES,
});

export const assignDriver = async (tourId, driverId, _driverInfo = {}, options = {}) => {
  const context = await loadAssignmentContext(tourId, driverId);
  return runAssignmentAttempt({
    operation: 'assign',
    context,
    options,
    driverProfileUpdates: options.driverProfileUpdates || null,
  });
};

export const unassignDriver = async (tourId, driverId = null, options = {}) => {
  const context = await loadAssignmentContext(tourId, driverId);
  return runAssignmentAttempt({
    operation: 'unassign',
    context,
    options,
    driverProfileUpdates: options.driverProfileUpdates || null,
  });
};

/**
 * Retained as a pure compatibility helper for import/export tooling. Production
 * assignment mutations use the authenticated server action above.
 */
export const buildDriverAssignmentUpdates = ({
  tourId,
  driverId,
  tourCode,
  driverInfo = {},
  isAssigned,
  actorId = 'web-admin',
  assignedAt = nowAsISOString(),
}) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  const normalizedTourCode = trimTourCode(tourCode);
  if (!normalizedTourId) throw new Error('Tour ID is required for driver assignment');
  if (isAssigned && !normalizedTourCode) throw new Error('Tour code is required for driver assignment');
  const updates = {
    [`tours/${normalizedTourId}/driverName`]: isAssigned ? driverInfo.name : 'TBA',
    [`tours/${normalizedTourId}/driverPhone`]: isAssigned ? (driverInfo.phone || '') : '',
    [`tours/${normalizedTourId}/driverId`]: isAssigned ? (driverId || null) : null,
  };
  if (!driverId) return updates;
  Object.assign(updates, {
    [`drivers/${driverId}/currentTourId`]: isAssigned ? normalizedTourId : null,
    [`drivers/${driverId}/currentTourCode`]: isAssigned ? normalizedTourCode : null,
    [`drivers/${driverId}/assignments/${normalizedTourId}`]: isAssigned ? true : null,
    [`tour_manifests/${normalizedTourId}/assigned_drivers/${driverId}`]: isAssigned ? true : null,
    [`tour_manifests/${normalizedTourId}/assigned_driver_codes/${driverId}`]: isAssigned ? {
      driverId,
      tourId: normalizedTourId,
      tourCode: normalizedTourCode,
      assignedAt,
      assignedBy: actorId,
    } : null,
  });
  const authUid = typeof driverInfo.authUid === 'string' ? driverInfo.authUid.trim() : '';
  if (authUid) Object.assign(updates, {
    [`users/${authUid}/driverId`]: driverId,
    [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${authUid}/driverAssignedTourId`]: isAssigned ? normalizedTourId : null,
    [`users/${authUid}/principalType`]: 'driver',
    [`users/${authUid}/lastUpdated`]: Date.now(),
  });
  return updates;
};

export const applyDriverAssignmentMutation = async ({
  tourId,
  driverId,
  driverInfo = {},
  isAssigned,
  driverProfileUpdates,
  expectedDriverRevision,
  expectedTourRevision,
  idempotencyKey,
}) => (isAssigned
  ? assignDriver(tourId, driverId, driverInfo, {
    driverProfileUpdates,
    expectedDriverRevision,
    expectedTourRevision,
    idempotencyKey,
  })
  : unassignDriver(tourId, driverId, {
    driverProfileUpdates,
    expectedDriverRevision,
    expectedTourRevision,
    idempotencyKey,
  }));
