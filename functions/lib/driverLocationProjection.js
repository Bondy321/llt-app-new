'use strict';
const { retryProjection } = require('./projectionRetry');
const { TOUR_FENCE_FIELD, TOUR_EPOCH_FIELD, claimProjectionFence, refreshProjectionFence,
  publishProjectionFence, releaseProjectionFence } = require('./driverLocationProjectionFence');
const { hasActiveTrackingIntent } = require('../src/domains/live-state/driverTrackingSessions');

const {
  buildAssignmentOwnedDriverLocationPickup,
  hasCurrentPickupAssignmentAuthority,
  isValidAssignmentOwnedDriverLocationPickup,
  removeDriverLocationPickupIfAssignmentMatches,
} = require('./driverLocationPickup');
const {
  LIVE_STATE_CUTOVER_PHASE,
  isLiveStateClientSupported,
  normalizeLiveStateRollout,
  readLiveStateRollout,
  transitionLiveStateRollout,
} = require('./liveStateRollout');

const DRIVER_LOCATION_SOURCE_SCHEMA_VERSION = 2;
const PUBLIC_DRIVER_LOCATION_SCHEMA_VERSION = 1;
const PROJECTION_LEASE_MS = 30_000;

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isSafeTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;

function normalizeCoordinates(record) {
  const latitude = Number(record?.latitude);
  const longitude = Number(record?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function normalizeBoundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isNonEmptyBoundedText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength;
}

function isValidLiveSource(record, nowMs) {
  return Boolean(
    isObject(record)
    && record.schemaVersion === DRIVER_LOCATION_SOURCE_SCHEMA_VERSION
    && record.source === 'auto'
    && record.mode === 'live'
    && normalizeCoordinates(record)
    && Number.isFinite(record.accuracy)
    && record.accuracy >= 0
    && record.accuracy <= 10_000
    && isSafeTimestamp(record.timestamp)
    && isSafeTimestamp(record.cleanupAtMs)
    && record.cleanupAtMs > nowMs
    && isNonEmptyBoundedText(record.authUid, 128)
    && isNonEmptyBoundedText(record.appSessionId, 100)
    && isNonEmptyBoundedText(record.liveSharingSessionId, 80)
    && isNonEmptyBoundedText(record.driverId, 100)
    && isNonEmptyBoundedText(record.tourId, 100)
  );
}

function isValidManualSource(record, nowMs = Date.now()) {
  return isValidAssignmentOwnedDriverLocationPickup(record, nowMs);
}

function sourceTieBreak(record) {
  return `${normalizeBoundedText(record?.appSessionId, 100)}|${normalizeBoundedText(record?.liveSharingSessionId, 80)}`;
}

function compareLiveSources(left, right) {
  const timestampDelta = Number(right.timestamp) - Number(left.timestamp);
  if (timestampDelta) return timestampDelta;
  return sourceTieBreak(right).localeCompare(sourceTieBreak(left));
}

function toPublicProjection(record) {
  if (!record) return null;
  const coordinates = normalizeCoordinates(record);
  const projection = {
    schemaVersion: PUBLIC_DRIVER_LOCATION_SCHEMA_VERSION,
    isSharing: true,
    mode: record.mode,
    source: record.source,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp: record.timestamp,
  };
  const accuracy = Number(record.accuracy);
  if (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 10_000) projection.accuracy = accuracy;
  const address = normalizeBoundedText(record.address, 500);
  if (address) projection.address = address;
  const updatedBy = normalizeBoundedText(record.updatedBy, 100);
  if (updatedBy) projection.updatedBy = updatedBy;
  return projection;
}

function buildDriverLocationProjection({ liveRecords = [], manualRecord = null, nowMs = Date.now() } = {}) {
  if (!isSafeTimestamp(nowMs)) throw new Error('nowMs must be a non-negative safe integer');
  const selectedLive = liveRecords
    .filter((record) => isValidLiveSource(record, nowMs))
    .sort(compareLiveSources)[0] || null;
  if (selectedLive) return toPublicProjection(selectedLive);
  return isValidManualSource(manualRecord, nowMs) ? toPublicProjection(manualRecord) : null;
}

function snapshotValue(snapshot) {
  return typeof snapshot?.val === 'function' ? snapshot.val() : null;
}

async function readValue(ref) {
  // Use the listener-backed read consistently with session authority checks.
  // Mixing concurrent get() and once() for the same cold Admin SDK path can
  // corrupt its listener bookkeeping (duplicate-listen assertion).
  const snapshot = typeof ref?.once === 'function' ? await ref.once('value') : await ref.get();
  return snapshotValue(snapshot);
}

async function readLiveSources(database, tourId) {
  let query = database.ref('driver_location_sessions').orderByChild('tourId');
  if (typeof query.equalTo === 'function') query = query.equalTo(tourId);
  const value = await readValue(query);
  return Object.entries(isObject(value) ? value : {})
    .filter(([, record]) => record?.tourId === tourId)
    .map(([sourceKey, record]) => ({ sourceKey, record }));
}

async function hasCurrentDriverAuthority(database, record, nowMs) {
  const [session, user, policy, driver, assigned, activeTrackingIntent, assignmentTransition, staffPolicy] = await Promise.all([
    readValue(database.ref(`app_sessions/${record.authUid}`)),
    readValue(database.ref(`users/${record.authUid}`)),
    readValue(database.ref('driver_login_policy/v1')),
    readValue(database.ref(`drivers/${record.driverId}`)),
    readValue(database.ref(`tour_manifests/${record.tourId}/assigned_drivers/${record.driverId}`)),
    hasActiveTrackingIntent(database, record, nowMs),
    readValue(database.ref(`driver_assignment_active/v1/${record.driverId}`)),
    readValue(database.ref(`driver_staff_policy/${record.driverId}`)),
  ]);
  const validPolicy = Boolean(
    isObject(policy)
    && policy.schemaVersion === 1
    && typeof policy.enforceSingleDevice === 'boolean'
    && Number.isSafeInteger(policy.generation)
    && policy.generation >= 0
    && Number.isSafeInteger(policy.revision) && policy.revision > 0
    && Number.isSafeInteger(policy.updatedAtMs) && policy.updatedAtMs > 0
    && (policy.transitionPhase === undefined || policy.transitionPhase === 'stable')
  );
  const sessionGeneration = Number.isSafeInteger(session?.driverLoginPolicyGeneration)
    ? session.driverLoginPolicyGeneration
    : -1;
  const { verifyStaffSessionAuthority } = require('../src/domains/driver-auth/staffEnrolment');
  const staffAuthorized = session && await verifyStaffSessionAuthority({ db: database, authUid: record.authUid, session });
  return Boolean(
    staffAuthorized && validPolicy
    && activeTrackingIntent
    && session
    && session.schemaVersion === 1
    && session.sessionId === record.appSessionId
    && session.authUid === record.authUid
    && session.status === 'active'
    && session.principalType === 'driver'
    && session.principalId === `driver:${record.driverId}`
    && session.driverId === record.driverId
    && session.tourId === record.tourId
    && Number(session.expiresAtMs) > nowMs
    && user?.principalType === 'driver'
    && user?.driverId === record.driverId
    && user?.driverPrincipalId === session.principalId
    && user?.driverAssignedTourId === record.tourId
    && driver?.currentTourId === record.tourId
    && assignmentTransition == null
    && assigned === true
    && sessionGeneration === policy.generation
    && (policy.enforceSingleDevice !== true || (driver?.authUid === record.authUid
      && driver?.authUidStaffGeneration === staffPolicy?.generation))
  );
}

async function acquireDriverLocationProjectionInvalidation({
  database,
  tourId,
  nowMs = Date.now(),
  leaseOwner = `driver_location_invalidation_${nowMs}_${Math.random().toString(36).slice(2, 10)}`,
  clock = Date.now,
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedTourId = normalizeBoundedText(tourId, 100);
  if (!normalizedTourId) throw new Error('A tour ID is required');
  if (!isSafeTimestamp(nowMs)) throw new Error('nowMs must be a non-negative safe integer');

  const context = await claimProjectionFence({ database, tourId: normalizedTourId, leaseOwner, clock });
  if (!context) throw Object.assign(new Error('Tour is missing'), { code: 'DRIVER_LOCATION_TOUR_MISSING' });
  let rolloutContext;
  try { rolloutContext = await readLiveStateRollout({ database }); }
  catch (error) { await releaseProjectionFence(context).catch(() => {}); throw error; }
  const cutover = rolloutContext.rollout.phase === LIVE_STATE_CUTOVER_PHASE;
  const state = context.lease;
  return {
    tourId: normalizedTourId,
    leaseOwner,
    leaseRevision: state.leaseRevision,
    leaseToken: state.leaseToken,
    revision: state.revision,
    publicPath: `tours/${normalizedTourId}/driverLocation`,
    fencePath: `tours/${normalizedTourId}/${TOUR_FENCE_FIELD}`,
    fenceEpochPath: `tours/${normalizedTourId}/${TOUR_EPOCH_FIELD}`,
    tombstone: {
      schemaVersion: PUBLIC_DRIVER_LOCATION_SCHEMA_VERSION,
      isSharing: false,
      timestamp: nowMs,
      ...(cutover ? { projectionRevision: state.revision } : {}),
    },
  };
}

async function releaseDriverLocationProjectionInvalidation({ database, invalidation } = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const tourId = normalizeBoundedText(invalidation?.tourId, 100);
  if (!tourId || !normalizeBoundedText(invalidation?.leaseOwner, 200)) {
    throw new Error('A valid driver location projection invalidation is required');
  }
  await releaseProjectionFence({
    stateRef: database.ref(`driver_location_projection_state/${tourId}`), lease: invalidation,
  });
}

async function reconcileDriverLocationProjectionOnce({
  database,
  tourId,
  nowMs = Date.now(),
  leaseOwner = `driver_location_${nowMs}_${Math.random().toString(36).slice(2, 10)}`,
  validateLiveRecord = hasCurrentDriverAuthority,
  readRollout = readLiveStateRollout,
  clock = Date.now,
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedTourId = normalizeBoundedText(tourId, 100);
  if (!normalizedTourId) throw new Error('A tour ID is required');
  if (!isSafeTimestamp(nowMs)) throw new Error('nowMs must be a non-negative safe integer');
  const startedAt = clock();
  const sourceTime = () => nowMs + Math.max(0, clock() - startedAt);
  const context = await claimProjectionFence({ database, tourId: normalizedTourId, leaseOwner, clock });
  if (!context) return { ok: true, tourId: normalizedTourId, revision: null,
    projection: null, published: false, reason: 'TOUR_MISSING' };
  const revision = context.lease.revision;
  let fingerprint;
  let published = false;
  try {
    const [liveEntries, manualRecord, rolloutContext] = await Promise.all([
      readLiveSources(database, normalizedTourId),
      readValue(database.ref(`driver_location_pickups/${normalizedTourId}`)),
      readRollout({ database }),
    ]);
    const authority = await Promise.all(liveEntries.map(async ({ sourceKey, record }) => ({
      sourceKey,
      record,
      valid: isValidLiveSource(record, sourceTime())
        && await validateLiveRecord(database, record, sourceTime(), sourceKey),
    })));
    const validManualRecord = isValidManualSource(manualRecord, sourceTime())
      && await hasCurrentPickupAssignmentAuthority(database, manualRecord, sourceTime());
    const projection = buildDriverLocationProjection({
      liveRecords: authority.filter(({ valid }) => valid).map(({ record }) => record),
      manualRecord: validManualRecord ? manualRecord : null,
      nowMs: sourceTime(),
    });
    fingerprint = JSON.stringify(projection);
    const latestRolloutContext = await readRollout({ database });
    const rolloutChanged = latestRolloutContext.isDefault !== rolloutContext.isDefault
      || latestRolloutContext.rollout.phase !== rolloutContext.rollout.phase
      || latestRolloutContext.rollout.projectionRevision !== rolloutContext.rollout.projectionRevision
      || latestRolloutContext.rollout.updatedAtMs !== rolloutContext.rollout.updatedAtMs;
    if (rolloutChanged) {
      const error = new Error('Live-state rollout changed before projection publication');
      error.code = 'LIVE_STATE_ROLLOUT_CHANGED';
      throw error;
    }
    const cutover = rolloutContext.rollout.phase === LIVE_STATE_CUTOVER_PHASE;
    const publicProjection = projection
      ? { ...projection, ...(cutover ? { projectionRevision: revision } : {}) }
      : {
          schemaVersion: PUBLIC_DRIVER_LOCATION_SCHEMA_VERSION,
          isSharing: false,
          timestamp: nowMs,
          ...(cutover ? { projectionRevision: revision } : {}),
        };
    const lease = await refreshProjectionFence({ ...context, clock });
    const publication = await publishProjectionFence({ ...context, lease, publicProjection, clock });
    if (!publication.published) return { ok: true, tourId: normalizedTourId, revision,
      projection: null, ...publication };
    published = true;
    return {
      ok: true,
      tourId: normalizedTourId,
      revision,
      projection,
      published: true,
    };
  } finally {
    await releaseProjectionFence({ ...context, fingerprint: published ? fingerprint : undefined,
      projectedAtMs: sourceTime() });
  }
}

const reconcileDriverLocationProjection = (options = {}) => {
  const clock = options.clock || Date.now;
  const startedAt = clock();
  const initialNow = options.nowMs ?? startedAt;
  return retryProjection(() => reconcileDriverLocationProjectionOnce({ ...options, clock,
    nowMs: initialNow + Math.max(0, clock() - startedAt) }), 'DRIVER_LOCATION_PROJECTION_BUSY');
};

function collectChangedTours(before, after) {
  return [...new Set([before?.tourId, after?.tourId].map((value) => normalizeBoundedText(value, 100)).filter(Boolean))].sort();
}

async function reconcileDriverLocationSourceChange({ database, before, after, nowMs = Date.now() } = {}) {
  const tours = collectChangedTours(before, after);
  const results = [];
  for (const tourId of tours) {
    results.push(await reconcileDriverLocationProjection({ database, tourId, nowMs }));
  }
  return { ok: true, tours, results };
}

async function cleanupDriverLocationsForAppSession({
  database,
  appSessionId,
  expectedTourId = null,
  nowMs = Date.now(),
  clock = Date.now,
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedSessionId = normalizeBoundedText(appSessionId, 100);
  if (!normalizedSessionId) throw new Error('An app session ID is required');
  let liveQuery = database.ref('driver_location_sessions').orderByChild('appSessionId');
  if (typeof liveQuery.equalTo === 'function') liveQuery = liveQuery.equalTo(normalizedSessionId);
  const records = await readValue(liveQuery);
  const matches = Object.entries(isObject(records) ? records : {})
    .filter(([, record]) => record?.appSessionId === normalizedSessionId);
  const tours = new Set();
  let removed = 0;
  for (const [sourceKey, candidate] of matches) {
    const result = await database.ref(`driver_location_sessions/${sourceKey}`).transaction((current) => {
      if (current === null) return current;
      if (!current || current.appSessionId !== normalizedSessionId) return undefined;
      return null;
    }, undefined, false);
    if (result?.committed) {
      removed += 1;
      if (candidate?.tourId) tours.add(candidate.tourId);
    }
  }
  const normalizedExpectedTourId = normalizeBoundedText(expectedTourId, 100);
  if (normalizedExpectedTourId && !tours.has(normalizedExpectedTourId)) {
    const publicLocation = await readValue(database.ref(`tours/${normalizedExpectedTourId}/driverLocation`));
    if (isObject(publicLocation) && publicLocation.isSharing !== false) {
      tours.add(normalizedExpectedTourId);
    }
  }
  const reconciledTours = [...tours].sort();
  for (const tourId of reconciledTours) {
    await reconcileDriverLocationProjection({ database, tourId, nowMs, clock });
  }
  return { ok: true, appSessionId: normalizedSessionId, removed, reconciledTours };
}

module.exports = {
  DRIVER_LOCATION_SOURCE_SCHEMA_VERSION,
  PROJECTION_LEASE_MS,
  acquireDriverLocationProjectionInvalidation,
  buildAssignmentOwnedDriverLocationPickup,
  buildDriverLocationProjection,
  cleanupDriverLocationsForAppSession,
  collectChangedTours,
  compareLiveSources,
  isValidLiveSource,
  isValidManualSource,
  hasCurrentDriverAuthority,
  hasCurrentPickupAssignmentAuthority,
  isLiveStateClientSupported,
  normalizeLiveStateRollout,
  readLiveStateRollout,
  removeDriverLocationPickupIfAssignmentMatches,
  releaseDriverLocationProjectionInvalidation,
  reconcileDriverLocationProjection,
  reconcileDriverLocationSourceChange,
  transitionLiveStateRollout,
  toPublicProjection,
};
