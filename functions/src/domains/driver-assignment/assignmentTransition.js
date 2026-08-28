'use strict';

/* eslint-disable complexity -- durable transition phases are intentionally explicit */

// @ts-check

const { randomUUID } = require('node:crypto');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { normalizeTourKeyForComparison } = require('../../infrastructure/validation/stringNormalization');
const { buildSafeAppSessionEvent } = require('../app-sessions/public');
const { renewDriverLoginAdmission } = require('../driver-auth/public');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const {
  buildCanonicalDriverAssignmentUpdates,
  buildDriverAssignmentReconciliationUpdates,
  normalizeDriverId,
  readAssignmentRevision,
} = require('./driverAssignment');

const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const {
  acquireNotificationDeviceLock,
  cleanupLiveStateForSession,
  releaseNotificationDeviceLock,
} = loadLegacyLibrary('appSessionCleanup');
const {
  ACTIVE_ASSIGNMENT_ROOT,
  acquireDriverAssignmentBarrier,
  acquireDriverAssignmentLoginAdmission,
  readDriverSessionPage,
  releaseDriverAssignmentBarrier,
  releaseDriverAssignmentLoginAdmission,
} = require('./assignmentCoordination');
const {
  acquireAssignmentLocationInvalidations,
  releaseDriverLocationProjectionInvalidation,
} = require('./assignmentLocationInvalidation');

const TRANSITION_ROOT = 'driver_assignment_transitions/v1';
const TRANSITION_QUEUE_ROOT = 'driver_assignment_transition_queue/v1';
const ASSIGNMENT_RETENTION_ROOT = 'driver_assignment_retention/v1';
const ASSIGNMENT_LOCK_TTL_MS = 180 * 1000;
const TRANSITION_RESERVATION_TTL_MS = 180 * 1000;
const TRANSITION_WORKER_TTL_MS = 180 * 1000;
const TRANSITION_PAGE_SIZE = 25;
const COMPLETED_TRANSITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** @param {any} transition */
const readDisplacedDriverIds = (transition) => [...new Set([
  ...(Array.isArray(transition?.displacedDriverIds) ? transition.displacedDriverIds : []),
  transition?.incumbentDriverId,
].map(normalizeDriverId).filter((driverId) => driverId && driverId !== transition?.driverId))].sort();

/** @param {any} manifestData @param {string} subjectDriverId @param {string | null} tourDriverId */
const collectDisplacedDriverIds = (manifestData, subjectDriverId, tourDriverId = null) => [...new Set([
  normalizeDriverId(tourDriverId),
  ...Object.entries(manifestData?.assigned_drivers || {})
    .filter(([, assigned]) => assigned === true)
    .map(([driverId]) => normalizeDriverId(driverId)),
].filter((driverId) => driverId && driverId !== normalizeDriverId(subjectDriverId)))].sort();

/** @type {(...args: any[]) => Promise<any>} */
const reserveDriverAssignmentTransition = async ({
  db, transitionId, reservation, nowMs = Date.now(),
}) => {
  const result = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    const retryingOwnedSemanticReservation = current?.status === 'aborted'
      && current.actorHash === reservation.actorHash
      && current.requestHash === reservation.requestHash
      && current.idempotencyPath === reservation.idempotencyPath;
    if (current && !retryingOwnedSemanticReservation) return undefined;
    return {
      ...reservation,
      schemaVersion: 1,
      status: 'reserving',
      transitionId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      reservationExpiresAtMs: nowMs + TRANSITION_RESERVATION_TTL_MS,
    };
  }, undefined, false);
  return {
    reserved: Boolean(result?.committed),
    transition: result?.snapshot?.val?.() || null,
  };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const abandonDriverAssignmentReservation = async ({
  db, transitionId, reservationOwner, reason = 'ASSIGNMENT_RESERVATION_ABORTED', nowMs = Date.now(),
}) => {
  const result = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    if (!current || current.status !== 'reserving' || current.reservationOwner !== reservationOwner) {
      return undefined;
    }
    return {
      ...current,
      status: 'aborted',
      reason,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + COMPLETED_TRANSITION_TTL_MS,
      reservationExpiresAtMs: null,
    };
  }, undefined, false);
  if (!result?.committed) return false;
  const transition = result.snapshot.val() || {};
  const updates = { [`${TRANSITION_QUEUE_ROOT}/${transitionId}`]: null };
  if (transition.admissionId) {
    updates[`driver_login_policy/v1/loginAdmissions/${transition.admissionId}`] = null;
  }
  await db.ref().update(updates);
  await releaseTransitionBarriers({ db, transitionId, transition });
  return true;
};

/** @type {(...args: any[]) => Promise<any>} */
const acquireSortedAssignmentLocks = async ({ db, paths, owner, acquired }) => {
  for (const path of [...new Set(paths)].sort()) {
    const locked = await acquireManualBookingLock({
      db, path, owner, nowMs: Date.now(), ttlMs: ASSIGNMENT_LOCK_TTL_MS,
    });
    if (!locked) return false;
    acquired.push(path);
  }
  return true;
};

/** @param {any} db @param {string[]} authUids */
const loadDevices = async (db, authUids) => Object.fromEntries(await Promise.all(authUids.map(async (authUid) => {
  const snapshot = await db.ref(`notification_devices/${authUid}`).once('value');
  return [authUid, snapshot.val() || null];
})));

/** @type {(...args: any[]) => Promise<void>} */
const commitReconciliationAfterCleanup = async ({ db, cleanupTasks, updates }) => {
  await Promise.all(cleanupTasks);
  await db.ref().update(updates);
};

/** @param {any} transition */
const readTransitionDriverIds = (transition) => [...new Set([
  normalizeDriverId(transition?.driverId),
  ...readDisplacedDriverIds(transition),
  ...(Array.isArray(transition?.barrierDriverIds) ? transition.barrierDriverIds.map(normalizeDriverId) : []),
].filter(Boolean))].sort();

/** @type {(...args: any[]) => Promise<void>} */
const releaseTransitionBarriers = async ({ db, transitionId, transition }) => {
  await Promise.all(readTransitionDriverIds(transition).map((driverId) => (
    releaseDriverAssignmentBarrier({ db, driverId, transitionId })
  )));
};

/** @type {(...args: any[]) => Promise<any>} */
const failTransition = async ({ db, transitionId, transition, reason, nowMs }) => {
  const updates = {
    [`${TRANSITION_ROOT}/${transitionId}/status`]: 'failed',
    [`${TRANSITION_ROOT}/${transitionId}/reason`]: reason,
    [`${TRANSITION_ROOT}/${transitionId}/updatedAtMs`]: nowMs,
    [`${TRANSITION_ROOT}/${transitionId}/expiresAtMs`]: nowMs + COMPLETED_TRANSITION_TTL_MS,
    [`${TRANSITION_QUEUE_ROOT}/${transitionId}`]: null,
  };
  if (transition.admissionId) {
    updates[`driver_login_policy/v1/loginAdmissions/${transition.admissionId}`] = null;
  }
  await db.ref().update(updates);
  await releaseTransitionBarriers({ db, transitionId, transition });
  return { status: 'failed', reason, progressed: true };
};

/** @type {(...args: any[]) => Promise<any>} */
const applyCanonicalTransition = async ({ db, transitionId, transition, nowMs }) => {
  const owner = `assignment_transition:${randomUUID()}`;
  const acquired = [];
  let locationInvalidations = [];
  try {
    const [driverSnapshot, tourSnapshot, manifestSnapshot] = await Promise.all([
      db.ref(`drivers/${transition.driverId}`).once('value'),
      db.ref(`tours/${transition.tourId}`).once('value'),
      db.ref(`tour_manifests/${transition.tourId}`).once('value'),
    ]);
    if (!driverSnapshot.exists()) return failTransition({ db, transitionId, transition, reason: 'DRIVER_NOT_FOUND', nowMs });
    if (!tourSnapshot.exists()) return failTransition({ db, transitionId, transition, reason: 'TOUR_NOT_FOUND', nowMs });
    const driverData = driverSnapshot.val() || {};
    const tourData = tourSnapshot.val() || {};
    const previousTourId = normalizeTourKeyForComparison(driverData.currentTourId);
    const incumbentDriverId = normalizeDriverId(tourData.driverId);
    const displacedDriverIds = collectDisplacedDriverIds(
      manifestSnapshot.val() || {}, transition.driverId, incumbentDriverId,
    );
    if (JSON.stringify(displacedDriverIds) !== JSON.stringify(readDisplacedDriverIds(transition))) {
      return failTransition({ db, transitionId, transition, reason: 'ASSIGNMENT_ALREADY_CHANGED', nowMs });
    }
    const paths = [
      `driver_assignment_locks/drivers/${transition.driverId}`,
      `driver_assignment_locks/tours/${transition.tourId}`,
    ];
    if (previousTourId) paths.push(`driver_assignment_locks/tours/${previousTourId}`);
    displacedDriverIds.forEach((driverId) => paths.push(`driver_assignment_locks/drivers/${driverId}`));
    if (!await acquireSortedAssignmentLocks({ db, paths, owner, acquired })) {
      return { status: 'contended', progressed: false };
    }

    const [lockedDriverSnapshot, lockedTourSnapshot, lockedManifestSnapshot] = await Promise.all([
      db.ref(`drivers/${transition.driverId}`).once('value'),
      db.ref(`tours/${transition.tourId}`).once('value'),
      db.ref(`tour_manifests/${transition.tourId}`).once('value'),
    ]);
    const lockedDriver = lockedDriverSnapshot.val() || {};
    const lockedTour = lockedTourSnapshot.val() || {};
    if (readAssignmentRevision(lockedDriver.assignmentRevision) !== transition.expectedDriverRevision
      || readAssignmentRevision(lockedTour.driverAssignmentRevision) !== transition.expectedTourRevision
      || normalizeTourKeyForComparison(lockedDriver.currentTourId) !== previousTourId
      || normalizeDriverId(lockedTour.driverId) !== incumbentDriverId
      || JSON.stringify(collectDisplacedDriverIds(
        lockedManifestSnapshot.val() || {}, transition.driverId, incumbentDriverId,
      )) !== JSON.stringify(displacedDriverIds)) {
      return failTransition({ db, transitionId, transition, reason: 'ASSIGNMENT_STALE', nowMs });
    }
    if (transition.operation === 'unassign' && incumbentDriverId && incumbentDriverId !== transition.driverId) {
      return failTransition({ db, transitionId, transition, reason: 'ASSIGNMENT_ALREADY_CHANGED', nowMs });
    }
    const [previousTourSnapshot, displacedDriverEntries] = await Promise.all([
      previousTourId && previousTourId !== transition.tourId
        ? db.ref(`tours/${previousTourId}`).once('value')
        : Promise.resolve(null),
      Promise.all(displacedDriverIds.map(async (driverId) => {
        const snapshot = await db.ref(`drivers/${driverId}`).once('value');
        return [driverId, snapshot.val() || {}];
      })),
    ]);
    const incumbentDriversData = Object.fromEntries(displacedDriverEntries);
    const profileUpdates = transition.driverProfileUpdates || null;
    const effectiveDriver = profileUpdates ? {
      ...lockedDriver,
      ...(profileUpdates.name ? { name: profileUpdates.name } : {}),
      ...(profileUpdates.phone !== null ? { phone: profileUpdates.phone } : {}),
    } : lockedDriver;
    const canonical = buildCanonicalDriverAssignmentUpdates({
      operation: transition.operation,
      driverId: transition.driverId,
      driverData: effectiveDriver,
      tourId: transition.tourId,
      tourData: lockedTour,
      previousTourData: previousTourSnapshot?.val?.() || {},
      incumbentDriverId,
      incumbentDriverData: incumbentDriversData[incumbentDriverId] || {},
      incumbentDriversData,
      actorId: `${transition.actorType}:${transition.actorHash}`,
      nowMs,
    });
    const updates = {
      ...canonical.updates,
      [`${TRANSITION_ROOT}/${transitionId}/status`]: 'subject_sessions',
      [`${TRANSITION_ROOT}/${transitionId}/previousTourId`]: canonical.previousTourId || null,
      [`${TRANSITION_ROOT}/${transitionId}/incumbentDriverId`]: incumbentDriverId || null,
      [`${TRANSITION_ROOT}/${transitionId}/displacedDriverIds`]: displacedDriverIds.length
        ? displacedDriverIds
        : null,
      [`${TRANSITION_ROOT}/${transitionId}/displacedDriverIndex`]: 0,
      [`${TRANSITION_ROOT}/${transitionId}/canonicalTourCode`]: canonical.canonicalTourCode,
      [`${TRANSITION_ROOT}/${transitionId}/subjectSessionCursor`]: null,
      [`${TRANSITION_ROOT}/${transitionId}/incumbentSessionCursor`]: null,
      [`${TRANSITION_ROOT}/${transitionId}/canonicalAppliedAtMs`]: nowMs,
      [`${TRANSITION_ROOT}/${transitionId}/updatedAtMs`]: nowMs,
    };
    if (profileUpdates?.name) updates[`drivers/${transition.driverId}/name`] = profileUpdates.name;
    if (profileUpdates && profileUpdates.phone !== null) {
      updates[`drivers/${transition.driverId}/phone`] = profileUpdates.phone;
    }
    try {
      locationInvalidations = await acquireAssignmentLocationInvalidations({
        db, updates, leaseOwner: owner, nowMs,
      });
    } catch (error) {
      if (error?.code === 'DRIVER_LOCATION_PROJECTION_BUSY') {
        return { status: 'contended', progressed: false };
      }
      throw error;
    }
    await db.ref().update(updates);
    return { status: 'subject_sessions', progressed: true };
  } finally {
    await Promise.all([
      ...locationInvalidations.map((invalidation) => releaseDriverLocationProjectionInvalidation({
        database: db,
        invalidation,
      })),
      ...acquired.map((path) => releaseManualBookingLock({ db, path, owner })),
    ]);
  }
};

/** @type {(...args: any[]) => Promise<any>} */
const reconcileTransitionSessionPage = async ({ db, transitionId, transition, nowMs, pageSize }) => {
  const incumbent = transition.status === 'incumbent_sessions';
  const displacedDriverIds = readDisplacedDriverIds(transition);
  const displacedDriverIndex = Number.isSafeInteger(transition.displacedDriverIndex)
    ? transition.displacedDriverIndex
    : 0;
  const driverId = incumbent ? displacedDriverIds[displacedDriverIndex] : transition.driverId;
  if (!driverId) {
    await db.ref().update({
      [`${TRANSITION_ROOT}/${transitionId}/status`]: 'finalizing',
      [`${TRANSITION_ROOT}/${transitionId}/updatedAtMs`]: nowMs,
    });
    return { status: 'finalizing', progressed: true };
  }
  const cursorField = incumbent ? 'incumbentSessionCursor' : 'subjectSessionCursor';
  const page = await readDriverSessionPage(db, driverId, transition[cursorField] || null, pageSize);
  const authUids = page.entries.map(([authUid]) => authUid);
  const sessionLocks = [];
  const deviceLocks = [];
  try {
    for (const authUid of authUids) {
      const lock = await acquireAppSessionLock({
        db, authUid, operation: 'assign', nowMs, ttlMs: ASSIGNMENT_LOCK_TTL_MS,
      });
      if (!lock.acquired) return { status: 'contended', progressed: false };
      sessionLocks.push({ authUid, owner: lock.owner });
      const deviceOwner = `assignment_transition:${transitionId}`;
      const deviceLock = await acquireNotificationDeviceLock({
        db, authUid, owner: deviceOwner, nowMs, ttlMs: ASSIGNMENT_LOCK_TTL_MS,
      });
      if (!deviceLock.acquired) return { status: 'contended', progressed: false };
      deviceLocks.push({ lockRef: deviceLock.lockRef, owner: deviceOwner });
    }
    const driverData = (await db.ref(`drivers/${driverId}`).once('value')).val() || {};
    const sessions = Object.fromEntries(page.entries);
    const devices = await loadDevices(db, authUids);
    const reconciliation = buildDriverAssignmentReconciliationUpdates({
      driverId,
      targetTourId: incumbent ? null : (transition.operation === 'assign' ? transition.tourId : null),
      sessions,
      devices,
      policy: transition.policy,
      driverData,
      nowMs,
    });
    const updates = { ...reconciliation.updates };
    reconciliation.reconciledAuthUids.forEach((authUid) => {
      const eventId = db.ref('app_session_events').push().key;
      updates[`app_session_events/${eventId}`] = buildSafeAppSessionEvent({
        session: updates[`app_sessions/${authUid}`],
        eventType: 'assignment_changed',
        reason: 'resumable_driver_assignment',
        actorType: transition.actorType,
        nowMs,
      });
    });
    updates[`${TRANSITION_ROOT}/${transitionId}/${cursorField}`] = page.cursor;
    updates[`${TRANSITION_ROOT}/${transitionId}/updatedAtMs`] = nowMs;
    let nextStatus = transition.status;
    if (!page.hasMore) {
      if (!incumbent && displacedDriverIds.length) {
        nextStatus = 'incumbent_sessions';
        updates[`${TRANSITION_ROOT}/${transitionId}/incumbentSessionCursor`] = null;
      } else if (incumbent && displacedDriverIndex + 1 < displacedDriverIds.length) {
        nextStatus = 'incumbent_sessions';
        updates[`${TRANSITION_ROOT}/${transitionId}/displacedDriverIndex`] = displacedDriverIndex + 1;
        updates[`${TRANSITION_ROOT}/${transitionId}/incumbentSessionCursor`] = null;
      } else {
        nextStatus = 'finalizing';
      }
      updates[`${TRANSITION_ROOT}/${transitionId}/status`] = nextStatus;
    }
    const cleanupTasks = reconciliation.reconciledAuthUids.map((authUid) => {
      const oldSession = sessions[authUid];
      return oldSession?.tourId
        ? cleanupLiveStateForSession({ db, session: oldSession, nowMs })
        : Promise.resolve(null);
    });
    await commitReconciliationAfterCleanup({ db, cleanupTasks, updates });
    return {
      status: nextStatus,
      progressed: true,
      cleanupFailures: 0,
    };
  } finally {
    await Promise.all(deviceLocks.map((lock) => releaseNotificationDeviceLock(lock)));
    await Promise.all(sessionLocks.map((lock) => releaseAppSessionLock({ db, ...lock })));
  }
};

/** @type {(...args: any[]) => Promise<any>} */
const finalizeTransition = async ({ db, transitionId, transition, nowMs }) => {
  const result = {
    success: true,
    tourId: transition.tourId,
    tourCode: transition.canonicalTourCode,
    previousTourId: transition.previousTourId || null,
    ...(transition.actorType === 'admin' ? {
      operation: transition.operation,
      driverId: transition.driverId,
      driverRevision: transition.expectedDriverRevision + 1,
      tourRevision: transition.expectedTourRevision + 1,
    } : {}),
  };
  const updates = {
    [`${TRANSITION_ROOT}/${transitionId}/status`]: 'completed',
    [`${TRANSITION_ROOT}/${transitionId}/result`]: result,
    [`${TRANSITION_ROOT}/${transitionId}/updatedAtMs`]: nowMs,
    [`${TRANSITION_ROOT}/${transitionId}/expiresAtMs`]: nowMs + COMPLETED_TRANSITION_TTL_MS,
    [`${TRANSITION_QUEUE_ROOT}/${transitionId}`]: null,
    [transition.idempotencyPath]: {
      schemaVersion: 1,
      status: 'completed',
      requestHash: transition.requestHash,
      result,
      createdAtMs: transition.createdAtMs,
      expiresAtMs: nowMs + COMPLETED_TRANSITION_TTL_MS,
    },
    [`driver_login_policy/v1/loginAdmissions/${transition.admissionId}`]: null,
    [`${ASSIGNMENT_RETENTION_ROOT}/${transitionId}`]: {
      schemaVersion: 1,
      targetPath: transition.idempotencyPath,
      expiresAtMs: nowMs + COMPLETED_TRANSITION_TTL_MS,
    },
  };
  await db.ref().update(updates);
  await releaseTransitionBarriers({ db, transitionId, transition });
  return { status: 'completed', progressed: true, completed: true, result };
};

/** @type {(...args: any[]) => Promise<any>} */
const acquireAssignmentTransitionWorker = async ({
  db, transitionId, owner = randomUUID(), nowMs = Date.now(),
}) => {
  const result = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    if (!current || ['completed', 'failed', 'aborted'].includes(current.status)) return undefined;
    if (current.workerOwner && current.workerOwner !== owner
      && Number(current.workerExpiresAtMs || 0) > nowMs) return undefined;
    return {
      ...current,
      workerOwner: owner,
      workerExpiresAtMs: nowMs + TRANSITION_WORKER_TTL_MS,
    };
  }, undefined, false);
  return {
    acquired: Boolean(result?.committed),
    owner,
    transition: result?.snapshot?.val?.() || null,
  };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseAssignmentTransitionWorker = async ({ db, transitionId, owner }) => {
  const result = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    if (!current || current.workerOwner !== owner) return undefined;
    return { ...current, workerOwner: null, workerExpiresAtMs: null };
  }, undefined, false);
  return Boolean(result?.committed);
};

/** @type {(...args: any[]) => Promise<any>} */
const advanceDriverAssignmentTransition = async ({
  db, transitionId, nowMs = Date.now(), pageSize = TRANSITION_PAGE_SIZE,
}) => {
  const snapshot = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).once('value');
  if (!snapshot.exists()) return { status: 'missing', progressed: false };
  let transition = snapshot.val() || {};
  if (transition.status === 'completed') return { status: 'completed', completed: true, result: transition.result };
  if (transition.status === 'failed') return { status: 'failed', reason: transition.reason, progressed: false };
  if (transition.status === 'reserving') {
    if (Number(transition.reservationExpiresAtMs || 0) > nowMs) {
      return { status: 'reserving', progressed: false };
    }
    return failTransition({
      db, transitionId, transition, reason: 'ASSIGNMENT_RESERVATION_EXPIRED', nowMs,
    });
  }
  const worker = await acquireAssignmentTransitionWorker({ db, transitionId, nowMs });
  if (!worker.acquired) return { status: 'contended', progressed: false };
  transition = worker.transition;
  try {
    if (!transition.admissionId || !transition.policy
      || !await renewDriverLoginAdmission({ db, admissionId: transition.admissionId, nowMs })) {
      return failTransition({
        db, transitionId, transition, reason: 'DRIVER_POLICY_CHANGE_IN_PROGRESS', nowMs,
      });
    }
    for (const driverId of readTransitionDriverIds(transition)) {
      const barrier = await acquireDriverAssignmentBarrier({ db, driverId, transitionId, nowMs });
      if (!barrier.acquired) return { status: 'contended', progressed: false };
    }
    if (transition.status === 'queued') return applyCanonicalTransition({ db, transitionId, transition, nowMs });
    if (['subject_sessions', 'incumbent_sessions'].includes(transition.status)) {
      return reconcileTransitionSessionPage({ db, transitionId, transition, nowMs, pageSize });
    }
    if (transition.status === 'finalizing') return finalizeTransition({ db, transitionId, transition, nowMs });
    return failTransition({ db, transitionId, transition, reason: 'ASSIGNMENT_TRANSITION_INVALID', nowMs });
  } finally {
    await releaseAssignmentTransitionWorker({ db, transitionId, owner: worker.owner });
  }
};

/** @type {(...args: any[]) => Promise<any>} */
const processDriverAssignmentTransitions = async ({
  db, nowMs = Date.now(), limit = 5, stepsPerTransition = 4,
} = {}) => {
  const snapshot = await db.ref(TRANSITION_QUEUE_ROOT).limitToFirst(limit).once('value');
  const transitionIds = Object.keys(snapshot.val() || {});
  const results = [];
  for (const transitionId of transitionIds) {
    let result;
    for (let step = 0; step < stepsPerTransition; step += 1) {
      try {
        result = await advanceDriverAssignmentTransition({ db, transitionId, nowMs: nowMs + step });
        if (result.status === 'missing') {
          await db.ref(`${TRANSITION_QUEUE_ROOT}/${transitionId}`).remove();
        }
      } catch (error) {
        result = {
          status: 'cleanup_retry',
          progressed: false,
          errorCode: error?.code || 'CLEANUP_RETRY',
        };
      }
      if (!result.progressed || result.completed || result.status === 'failed') break;
    }
    results.push(result);
  }
  return { scanned: transitionIds.length, results };
};

/** @type {(...args: any[]) => Promise<any>} */
const cleanupExpiredDriverAssignmentRecords = async ({ db, nowMs = Date.now(), limit = 50 } = {}) => {
  const [retentionSnapshot, transitionSnapshot] = await Promise.all([
    db.ref(ASSIGNMENT_RETENTION_ROOT).orderByChild('expiresAtMs')
      .startAt(0).endAt(nowMs).limitToFirst(limit).once('value'),
    db.ref(TRANSITION_ROOT).orderByChild('expiresAtMs')
      .startAt(0).endAt(nowMs).limitToFirst(limit).once('value'),
  ]);
  const retention = retentionSnapshot.val() || {};
  const transitions = transitionSnapshot.val() || {};
  const updates = {};
  let transitionsDeleted = 0;
  Object.entries(retention).forEach(([retentionId, value]) => {
    const targetPath = typeof value?.targetPath === 'string' ? value.targetPath : '';
    if (/^driver_assignment_idempotency\/v1\/[a-f0-9]{24}\/[a-f0-9]{24}$/.test(targetPath)) {
      updates[targetPath] = null;
    }
    updates[`${ASSIGNMENT_RETENTION_ROOT}/${retentionId}`] = null;
  });
  for (const [transitionId, transition] of Object.entries(transitions)) {
    if (!['completed', 'failed', 'aborted'].includes(transition?.status)) continue;
    transitionsDeleted += 1;
    updates[`${TRANSITION_ROOT}/${transitionId}`] = null;
    updates[`${TRANSITION_QUEUE_ROOT}/${transitionId}`] = null;
    if (transition?.admissionId) {
      updates[`driver_login_policy/v1/loginAdmissions/${transition.admissionId}`] = null;
    }
    for (const driverId of readTransitionDriverIds(transition)) {
      await db.ref(`${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`).transaction((current) => (
        current?.transitionId === transitionId ? null : undefined
      ), undefined, false);
    }
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
  return {
    idempotencyRecordsDeleted: Object.keys(retention).length,
    transitionsDeleted,
  };
};

module.exports = {
  ACTIVE_ASSIGNMENT_ROOT,
  ASSIGNMENT_LOCK_TTL_MS,
  ASSIGNMENT_RETENTION_ROOT,
  TRANSITION_QUEUE_ROOT,
  TRANSITION_ROOT,
  abandonDriverAssignmentReservation,
  advanceDriverAssignmentTransition,
  acquireAssignmentLocationInvalidations,
  acquireAssignmentTransitionWorker,
  acquireDriverAssignmentBarrier,
  acquireDriverAssignmentLoginAdmission,
  cleanupExpiredDriverAssignmentRecords,
  commitReconciliationAfterCleanup,
  processDriverAssignmentTransitions,
  readDriverSessionPage,
  reserveDriverAssignmentTransition,
  releaseDriverAssignmentBarrier,
  releaseDriverAssignmentLoginAdmission,
};
