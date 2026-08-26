'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');

const SAFETY_STATUS_ACTIONS = Object.freeze({
  acknowledge: 'acknowledged',
  start_response: 'in_progress',
  escalate: 'escalated',
  resolve: 'resolved',
});

const ALLOWED_SAFETY_TRANSITIONS = Object.freeze({
  pending: new Set(['acknowledged', 'in_progress', 'escalated', 'resolved']),
  acknowledged: new Set(['in_progress', 'escalated', 'resolved']),
  in_progress: new Set(['escalated', 'resolved']),
  escalated: new Set(['in_progress', 'resolved']),
  resolved: new Set(),
});

const snapshotValue = (snapshot) => snapshot?.val?.() ?? null;

const acquireTransitionLock = async ({ db, tourId, eventId, owner, nowMs }) => {
  const lockRef = db.ref(`safety_status_locks/${tourId}/${eventId}`);
  const result = await lockRef.transaction((current) => {
    if (current && current.owner !== owner && Number(current.expiresAtMs || 0) > nowMs) return undefined;
    return { owner, createdAtMs: nowMs, expiresAtMs: nowMs + 30_000 };
  }, undefined, false);
  return { acquired: result?.committed === true && snapshotValue(result.snapshot)?.owner === owner, lockRef };
};

const releaseTransitionLock = async (lockRef, owner) => {
  if (!lockRef) return;
  await lockRef.transaction((current) => (current?.owner === owner ? null : current), undefined, false);
};

const validateTransition = (currentStatus, nextStatus) => {
  if (currentStatus === nextStatus) return { allowed: true, duplicate: true };
  if (ALLOWED_SAFETY_TRANSITIONS[currentStatus]?.has(nextStatus)) return { allowed: true, duplicate: false };
  return {
    allowed: false,
    duplicate: false,
    reason: currentStatus === 'resolved' ? 'ALREADY_RESOLVED' : 'INVALID_TRANSITION',
  };
};
const resolveReporterAuthUid = (alert) => {
  const value = typeof alert.reporterAuthUid === 'string' && alert.reporterAuthUid.trim()
    ? alert.reporterAuthUid.trim()
    : (typeof alert.userId === 'string' ? alert.userId.trim() : '');
  return value && value.length <= 160 && !/[.#$/[\]]/u.test(value) ? value : '';
};
const loadSafetyMirrorPaths = async ({ db, tourPath, eventId, alert }) => {
  const globalPath = `globalSafetyAlerts/${eventId}`;
  const reporterAuthUid = resolveReporterAuthUid(alert);
  const logPath = reporterAuthUid ? `logs/${reporterAuthUid}/safety/${eventId}` : null;
  const [globalSnapshot, logSnapshot] = await Promise.all([
    db.ref(globalPath).once('value'),
    logPath ? db.ref(logPath).once('value') : Promise.resolve(null),
  ]);
  const paths = [tourPath];
  if (snapshotValue(globalSnapshot)) paths.push(globalPath);
  if (logPath && snapshotValue(logSnapshot)) paths.push(logPath);
  return paths;
};
const resolveStatusMetadata = ({ alert, duplicate, actorAuthUid, nowMs }) => {
  const statusUpdatedAtMs = duplicate && Number.isSafeInteger(alert.statusUpdatedAtMs)
    ? alert.statusUpdatedAtMs
    : nowMs;
  return {
    statusUpdatedAtMs,
    statusUpdatedAt: duplicate && typeof alert.statusUpdatedAt === 'string'
      ? alert.statusUpdatedAt
      : new Date(statusUpdatedAtMs).toISOString(),
    statusUpdatedBy: duplicate && typeof alert.statusUpdatedBy === 'string'
      ? alert.statusUpdatedBy
      : actorAuthUid,
  };
};
const buildStatusMirrorUpdates = ({ paths, nextStatus, metadata, notes }) => {
  const updates = {};
  paths.forEach((path) => {
    updates[`${path}/status`] = nextStatus;
    updates[`${path}/statusUpdatedAt`] = metadata.statusUpdatedAt;
    updates[`${path}/statusUpdatedAtMs`] = metadata.statusUpdatedAtMs;
    updates[`${path}/statusUpdatedBy`] = metadata.statusUpdatedBy;
    if (notes) updates[`${path}/statusNotes`] = notes;
  });
  return updates;
};

const transitionSafetyAlertStatus = async ({
  db,
  tourId,
  eventId,
  action,
  actorAuthUid,
  notes = null,
  nowMs = Date.now(),
  owner = randomUUID(),
} = {}) => {
  const nextStatus = SAFETY_STATUS_ACTIONS[action];
  if (!nextStatus) return { status: 400, reason: 'INVALID_ACTION' };

  const lock = await acquireTransitionLock({ db, tourId, eventId, owner, nowMs });
  if (!lock.acquired) return { status: 409, reason: 'TRANSITION_IN_PROGRESS' };

  try {
    const tourPath = `tours/${tourId}/safetyAlerts/${eventId}`;
    const tourSnapshot = await db.ref(tourPath).once('value');
    const alert = snapshotValue(tourSnapshot);
    if (!alert) return { status: 404, reason: 'NOT_FOUND' };

    const currentStatus = String(alert.status || 'pending').trim().toLowerCase();
    const validation = validateTransition(currentStatus, nextStatus);
    if (!validation.allowed) return { status: 409, reason: validation.reason };
    const paths = await loadSafetyMirrorPaths({ db, tourPath, eventId, alert });
    const metadata = resolveStatusMetadata({ alert, duplicate: validation.duplicate, actorAuthUid, nowMs });
    await db.ref().update(buildStatusMirrorUpdates({ paths, nextStatus, metadata, notes }));
    return {
      status: 200,
      reason: validation.duplicate ? 'ALREADY_APPLIED' : 'UPDATED',
      duplicate: validation.duplicate,
      nextStatus,
      updatedPaths: paths,
    };
  } finally {
    await releaseTransitionLock(lock.lockRef, owner);
  }
};

module.exports = {
  ALLOWED_SAFETY_TRANSITIONS,
  SAFETY_STATUS_ACTIONS,
  transitionSafetyAlertStatus,
};
