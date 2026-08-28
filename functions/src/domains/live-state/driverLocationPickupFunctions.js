'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { readDriverLoginPolicy } = require('../driver-auth/public');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');

const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const {
  buildAssignmentOwnedDriverLocationPickup,
  isLiveStateClientSupported,
  readLiveStateRollout,
  removeDriverLocationPickupIfAssignmentMatches,
} = loadLegacyLibrary('driverLocationProjection');

const onRequestWithResult = /** @type {any} */ (onRequest);
const PICKUP_MUTATION_LOCK_TTL_MS = 60 * 1000;

const isValidCoordinates = ({ latitude, longitude, accuracy }) => {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return false;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return false;
  return accuracy === undefined || (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 10_000);
};

const normalizeOperation = (value) => {
  if (value === 'publish' || value === 'withdraw') return value;
  return '';
};

const parseCoordinates = (value) => {
  const location = {
    latitude: Number(value?.latitude),
    longitude: Number(value?.longitude),
    accuracy: value?.accuracy === undefined ? undefined : Number(value.accuracy),
  };
  return isValidCoordinates(location) ? location : null;
};

const hasMissingRequired = (...values) => values.some((value) => !value);

const parseInput = (body) => {
  const operation = normalizeOperation(body?.operation);
  const expectedSessionId = resolveTrimmedString(body?.expectedSessionId);
  const clientVersion = resolveTrimmedString(body?.clientVersion);
  const tourId = normalizeTourKeyForComparison(body?.tourId);
  if (hasMissingRequired(operation, expectedSessionId, clientVersion, tourId)) return null;
  const location = operation === 'publish' ? parseCoordinates(body?.location) : null;
  if (operation === 'publish' && !location) return null;
  const input = {
    operation,
    expectedSessionId,
    clientVersion,
    tourId,
    address: (resolveTrimmedString(body?.address) || '').slice(0, 500),
  };
  if (location) {
    input.location = { latitude: location.latitude, longitude: location.longitude };
    if (location.accuracy !== undefined) input.location.accuracy = location.accuracy;
  } else input.location = null;
  return input;
};

const response = (status, payload) => ({ status, payload });

const verifyPickupAssignment = async ({ db, access, input }) => {
  const [policyContext, driverSnapshot, tourSnapshot, assignedSnapshot, transitionSnapshot] = await Promise.all([
    readDriverLoginPolicy({ db }),
    db.ref(`drivers/${access.driverId}`).once('value'),
    db.ref(`tours/${input.tourId}`).once('value'),
    db.ref(`tour_manifests/${input.tourId}/assigned_drivers/${access.driverId}`).once('value'),
    db.ref(`driver_assignment_active/v1/${access.driverId}/transitionId`).once('value'),
  ]);
  if (policyContext.isDefault || policyContext.transition?.phase !== 'stable') {
    return { error: response(503, { success: false, reason: 'POLICY_CONFIGURATION_INVALID' }) };
  }
  const driver = driverSnapshot.val() || {};
  const tour = tourSnapshot.val() || {};
  const assignmentRevision = Number(tour.driverAssignmentRevision || 0);
  const valid = !transitionSnapshot.exists()
    && driver.currentTourId === input.tourId
    && tour.driverId === access.driverId
    && assignedSnapshot.val() === true
    && Number.isSafeInteger(assignmentRevision)
    && assignmentRevision >= 0;
  return valid
    ? { driver, tour, assignmentRevision }
    : { error: response(409, { success: false, reason: 'ASSIGNMENT_CHANGED' }) };
};

const publishPickup = async ({ db, access, input, assignment }) => {
  const nowMs = Date.now();
  const pickup = buildAssignmentOwnedDriverLocationPickup({
    driverId: access.driverId,
    tourId: input.tourId,
    assignmentRevision: assignment.assignmentRevision,
    location: input.location,
    address: input.address,
    updatedBy: resolveTrimmedString(assignment.driver.name) || access.driverId,
    nowMs,
    tourEndAtMs: Number.isSafeInteger(assignment.tour.endDateEpochMs)
      ? assignment.tour.endDateEpochMs : null,
  });
  await db.ref(`driver_location_pickups/${input.tourId}`).set(pickup);
  return response(200, {
    success: true,
    operation: 'publish',
    pickup: {
      schemaVersion: pickup.schemaVersion,
      isSharing: pickup.isSharing,
      source: pickup.source,
      mode: pickup.mode,
      latitude: pickup.latitude,
      longitude: pickup.longitude,
      ...(pickup.accuracy === undefined ? {} : { accuracy: pickup.accuracy }),
      ...(pickup.address ? { address: pickup.address } : {}),
      ...(pickup.updatedBy ? { updatedBy: pickup.updatedBy } : {}),
      timestamp: pickup.timestamp,
      expiresAtMs: pickup.expiresAtMs,
    },
  });
};

const performPickupMutation = async ({ db, input, requestAuth }) => {
  const sessionLock = await acquireAppSessionLock({ db, authUid: requestAuth.uid, operation: 'driver_location_pickup' });
  if (!sessionLock.acquired) return response(409, { success: false, reason: 'SESSION_IN_PROGRESS' });
  const owner = randomUUID();
  const acquired = [];
  try {
    const access = await verifyActiveAppSession({
      db, authUid: requestAuth.uid, expectedRole: 'driver',
      expectedSessionId: input.expectedSessionId, expectedTourId: input.tourId,
    });
    if (!access.allowed) return response(409, { success: false, reason: access.reason || 'SESSION_CHANGED' });
    const locksOk = await acquirePickupLocks({
      db, owner, acquired,
      paths: [`driver_assignment_locks/drivers/${access.driverId}`, `driver_assignment_locks/tours/${input.tourId}`],
    });
    if (!locksOk) return response(409, { success: false, reason: 'ASSIGNMENT_IN_PROGRESS' });
    const currentAccess = await verifyActiveAppSession({
      db, authUid: requestAuth.uid, expectedRole: 'driver',
      expectedSessionId: input.expectedSessionId, expectedTourId: input.tourId,
    });
    if (!currentAccess.allowed || currentAccess.driverId !== access.driverId) {
      return response(409, { success: false, reason: currentAccess.reason || 'SESSION_CHANGED' });
    }
    const assignment = await verifyPickupAssignment({ db, access, input });
    if (assignment.error) return assignment.error;
    if (input.operation === 'publish') return publishPickup({ db, access, input, assignment });
    const result = await removeDriverLocationPickupIfAssignmentMatches({
      database: db,
      tourId: input.tourId,
      driverId: access.driverId,
      assignmentRevision: assignment.assignmentRevision,
    });
    return response(200, { success: true, operation: 'withdraw', removed: result.removed });
  } catch (error) {
    const reason = error?.code === 'POLICY_CONFIGURATION_INVALID'
      ? 'POLICY_CONFIGURATION_INVALID' : 'INTERNAL_ERROR';
    return response(reason === 'POLICY_CONFIGURATION_INVALID' ? 503 : 500, { success: false, reason });
  } finally {
    await Promise.all(acquired.map((path) => releaseManualBookingLock({ db, path, owner })));
    await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: sessionLock.owner });
  }
};

const acquirePickupLocks = async ({ db, paths, owner, acquired }) => {
  for (const path of [...paths].sort()) {
    const ok = await acquireManualBookingLock({ db, path, owner, nowMs: Date.now(), ttlMs: PICKUP_MUTATION_LOCK_TTL_MS });
    if (!ok) return false;
    acquired.push(path);
  }
  return true;
};

const updateDriverLocationPickup = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const input = parseInput(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const db = admin.database();
    let rollout;
    try {
      rollout = (await readLiveStateRollout({ database: db })).rollout;
    } catch {
      return res.status(503).json({ success: false, reason: 'LIVE_STATE_ROLLOUT_INVALID' });
    }
    if (!isLiveStateClientSupported({ rollout, clientVersion: input.clientVersion })) {
      return res.status(426).json({ success: false, reason: 'UPDATE_REQUIRED', minimumSupportedVersion: '1.0.5' });
    }
    const result = await performPickupMutation({ db, input, requestAuth });
    return res.status(result.status).json(result.payload);
  },
);

module.exports = { parseInput, performPickupMutation, updateDriverLocationPickup };
