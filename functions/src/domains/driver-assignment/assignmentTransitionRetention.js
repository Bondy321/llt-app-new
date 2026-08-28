'use strict';

/* eslint-disable complexity -- compare-safe terminal cleanup keeps each exact fence explicit */

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const {
  acquireManualBookingLock,
  releaseManualBookingLock,
} = require('../../infrastructure/database/operationLock');
const { normalizeDriverId } = require('./driverAssignment');

const {
  boundedWarningCode,
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
} = loadLegacyLibrary('operationsTerminalWarnings');

const ACTIVE_ASSIGNMENT_ROOT = 'driver_assignment_active/v1';
const ASSIGNMENT_RETENTION_ROOT = 'driver_assignment_retention/v1';
const TRANSITION_ROOT = 'driver_assignment_transitions/v1';
const TRANSITION_QUEUE_ROOT = 'driver_assignment_transition_queue/v1';
const ASSIGNMENT_LOCK_ROOT = 'driver_assignment_locks';
const TERMINAL_CLEANUP_LOCK_TTL_MS = 3 * 60 * 1000;
const IDEMPOTENCY_PATH_PATTERN = /^driver_assignment_idempotency\/v1\/[a-f0-9]{24}\/[a-f0-9]{24}$/;

/** @param {any} transition */
const readTransitionDriverIds = (transition) => [...new Set([
  normalizeDriverId(transition?.driverId),
  normalizeDriverId(transition?.incumbentDriverId),
  ...(Array.isArray(transition?.displacedDriverIds) ? transition.displacedDriverIds.map(normalizeDriverId) : []),
  ...(Array.isArray(transition?.barrierDriverIds) ? transition.barrierDriverIds.map(normalizeDriverId) : []),
].filter(Boolean))].sort();

/** @type {(...args: any[]) => Promise<boolean>} */
const recordAssignmentTransitionFailure = async ({ db, transitionId, nowMs, reason }) => {
  const result = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    if (!current || ['completed', 'failed', 'aborted'].includes(current.status)) return undefined;
    const attemptCount = Number.isSafeInteger(current.attemptCount) ? current.attemptCount + 1 : 1;
    return {
      ...current,
      attemptCount,
      firstAttemptAtMs: Number.isSafeInteger(current.firstAttemptAtMs) ? current.firstAttemptAtMs : nowMs,
      lastAttemptAtMs: nowMs,
      lastFailureReason: boundedWarningCode(reason, 'cleanup_retry'),
    };
  }, undefined, false);
  return result?.committed === true;
};

/** @type {(...args: any[]) => Promise<any>} */
const terminalizeExpiredAssignmentTransition = async ({ db, transitionId, transition, nowMs }) => {
  const warningInput = {
    jobType: 'driver_assignment_transition',
    reason: transition.lastFailureReason || transition.reason || 'retention_expired',
    identifiers: {
      transitionId,
      driverId: transition.driverId,
      tourId: transition.tourId,
      actorHash: transition.actorHash,
    },
    attemptCount: transition.attemptCount,
    firstAttemptAtMs: transition.firstAttemptAtMs || transition.createdAtMs,
    lastAttemptAtMs: transition.lastAttemptAtMs || transition.createdAtMs,
    expiresAtMs: transition.expiresAtMs,
    nowMs,
  };
  const initialWarning = buildOperationsTerminalWarning(warningInput);
  const claimed = await db.ref(`${TRANSITION_ROOT}/${transitionId}`).transaction((current) => {
    if (!current
      || current.transitionId !== transitionId
      || current.status !== transition.status
      || current.expiresAtMs !== transition.expiresAtMs
      || !['failed', 'aborted'].includes(current.status)
      || !Number.isSafeInteger(current.expiresAtMs)
      || current.expiresAtMs > nowMs
      || (current.terminalWarningId && current.terminalWarningId !== initialWarning.warningId)) return undefined;
    return {
      ...current,
      terminalWarningId: initialWarning.warningId,
      terminalizationReason: initialWarning.reason,
      terminalizationStartedAtMs: current.terminalizationStartedAtMs || nowMs,
    };
  }, undefined, false);
  if (!claimed?.committed) return { status: 'source_changed', terminalized: false };

  const claimedTransition = claimed.snapshot.val() || transition;
  const warning = buildOperationsTerminalWarning({
    ...warningInput,
    attemptCount: claimedTransition.attemptCount,
    firstAttemptAtMs: claimedTransition.firstAttemptAtMs || claimedTransition.createdAtMs,
    lastAttemptAtMs: claimedTransition.lastAttemptAtMs || claimedTransition.createdAtMs,
  });
  const persisted = await persistOperationsTerminalWarning({ db, warning });
  return {
    status: 'warning_persisted',
    terminalized: true,
    warningCreated: persisted.created,
    warningId: warning.warningId,
    transition: claimedTransition,
  };
};

/** @param {any} transition */
const readTransitionTourIds = (transition) => [...new Set([
  transition?.tourId,
  transition?.previousTourId,
].filter((tourId) => typeof tourId === 'string' && tourId))].sort();

/** @type {(...args: any[]) => Promise<any>} */
const releaseTerminalCleanupLocks = async ({ db, paths, owner }) => {
  await Promise.all(paths.map((path) => releaseManualBookingLock({ db, path, owner })));
};

/** @type {(...args: any[]) => Promise<any>} */
const acquireTerminalCleanupLocks = async ({ db, transition, warningId, nowMs }) => {
  const paths = [
    ...readTransitionDriverIds(transition).map((driverId) => `${ASSIGNMENT_LOCK_ROOT}/drivers/${driverId}`),
    ...readTransitionTourIds(transition).map((tourId) => `${ASSIGNMENT_LOCK_ROOT}/tours/${tourId}`),
  ].sort();
  const owner = `terminal_cleanup:${warningId}`;
  const acquired = [];
  for (const path of paths) {
    const locked = await acquireManualBookingLock({
      db, path, owner, nowMs, ttlMs: TERMINAL_CLEANUP_LOCK_TTL_MS,
    });
    if (!locked) {
      await releaseTerminalCleanupLocks({ db, paths: acquired, owner });
      return { acquired: false, owner, paths: [] };
    }
    acquired.push(path);
  }
  return { acquired: true, owner, paths: acquired };
};

/** @type {(...args: any[]) => Promise<any>} */
const buildTerminalCleanupUpdates = async ({ db, transitionId, warningId, lockPaths }) => {
  const source = (await db.ref(`${TRANSITION_ROOT}/${transitionId}`).once('value')).val();
  if (!source
    || source.transitionId !== transitionId
    || source.terminalWarningId !== warningId
    || !['failed', 'aborted'].includes(source.status)) return null;

  const paths = [
    ...readTransitionDriverIds(source).map((driverId) => `${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`),
    ...(source.admissionId ? [`driver_login_policy/v1/loginAdmissions/${source.admissionId}`] : []),
    ...(IDEMPOTENCY_PATH_PATTERN.test(source.idempotencyPath || '') ? [source.idempotencyPath] : []),
    `${ASSIGNMENT_RETENTION_ROOT}/${transitionId}`,
  ];
  const values = await Promise.all(paths.map(async (path) => ({
    path,
    value: (await db.ref(path).once('value')).val(),
  })));
  const currentByPath = Object.fromEntries(values.map(({ path, value }) => [path, value]));
  const updates = {
    [`${TRANSITION_ROOT}/${transitionId}`]: null,
    [`${TRANSITION_QUEUE_ROOT}/${transitionId}`]: null,
  };
  readTransitionDriverIds(source).forEach((driverId) => {
    const path = `${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`;
    if (currentByPath[path]?.transitionId === transitionId) updates[path] = null;
  });
  if (source.admissionId) {
    const admissionPath = `driver_login_policy/v1/loginAdmissions/${source.admissionId}`;
    if (currentByPath[admissionPath]?.transitionId === transitionId) updates[admissionPath] = null;
  }
  if (IDEMPOTENCY_PATH_PATTERN.test(source.idempotencyPath || '')) {
    const idempotency = currentByPath[source.idempotencyPath];
    const exactPendingRecord = idempotency?.transitionId === transitionId
      || (idempotency?.requestHash === source.requestHash && idempotency?.status !== 'completed');
    if (exactPendingRecord) updates[source.idempotencyPath] = null;
  }
  const retentionPath = `${ASSIGNMENT_RETENTION_ROOT}/${transitionId}`;
  if (currentByPath[retentionPath]?.targetPath === source.idempotencyPath) updates[retentionPath] = null;
  lockPaths.forEach((path) => { updates[path] = null; });
  return updates;
};

/** @type {(...args: any[]) => Promise<any>} */
const cleanupTerminalAssignmentTransition = async ({ db, transitionId, transition, warningId, nowMs }) => {
  const locks = await acquireTerminalCleanupLocks({ db, transition, warningId, nowMs });
  if (!locks.acquired) return { cleaned: false, cleanupFailed: false };
  const updates = await buildTerminalCleanupUpdates({
    db, transitionId, warningId, lockPaths: locks.paths,
  });
  if (!updates) {
    await releaseTerminalCleanupLocks({ db, paths: locks.paths, owner: locks.owner });
    return { cleaned: false, cleanupFailed: false };
  }
  try {
    await db.ref().update(updates);
    return { cleaned: true, cleanupFailed: false };
  } catch (_error) {
    // Keep the deterministic cleanup locks with the exact source and fences. A
    // replay by the same warning owner can reacquire them and retry atomically.
    return { cleaned: false, cleanupFailed: true };
  }
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
  let terminalWarnings = 0;
  let terminalWarningFailures = 0;
  let terminalCleanupFailures = 0;
  Object.entries(retention).forEach(([retentionId, value]) => {
    const targetPath = typeof value?.targetPath === 'string' ? value.targetPath : '';
    if (IDEMPOTENCY_PATH_PATTERN.test(targetPath)) updates[targetPath] = null;
    updates[`${ASSIGNMENT_RETENTION_ROOT}/${retentionId}`] = null;
  });
  for (const [transitionId, transition] of Object.entries(transitions)) {
    if (!['completed', 'failed', 'aborted'].includes(transition?.status)) continue;
    if (transition.status === 'failed' || transition.status === 'aborted') {
      try {
        const terminal = await terminalizeExpiredAssignmentTransition({ db, transitionId, transition, nowMs });
        if (terminal.terminalized) terminalWarnings += 1;
        if (!terminal.terminalized) continue;
        const cleanup = await cleanupTerminalAssignmentTransition({
          db,
          transitionId,
          transition: terminal.transition,
          warningId: terminal.warningId,
          nowMs,
        });
        if (cleanup.cleanupFailed) terminalCleanupFailures += 1;
        if (!cleanup.cleaned) continue;
      } catch (_error) {
        terminalWarningFailures += 1;
        continue;
      }
    } else updates[`${TRANSITION_ROOT}/${transitionId}`] = null;
    transitionsDeleted += 1;
    updates[`${TRANSITION_QUEUE_ROOT}/${transitionId}`] = null;
    if (transition?.admissionId) updates[`driver_login_policy/v1/loginAdmissions/${transition.admissionId}`] = null;
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
    terminalWarnings,
    terminalWarningFailures,
    terminalCleanupFailures,
  };
};

module.exports = {
  cleanupExpiredDriverAssignmentRecords,
  recordAssignmentTransitionFailure,
  terminalizeExpiredAssignmentTransition,
};
