'use strict';

const { randomBytes } = require('crypto');

const APP_SESSION_LOCK_TTL_MS = 30 * 1000;
const APP_SESSION_LOCK_OPERATIONS = new Set([
  'issue',
  'end',
  'assign',
  'revoke',
  'cleanup',
  'policy_cleanup',
  'role_claim_cleanup',
  'driver_location_pickup',
  'driver_tracking_stop',
  'notification_device',
]);
// Assignment advances its revision together with its notification projection;
// a preliminary bump would invalidate the very registration it must reconcile.
const SESSION_MUTATING_OPERATIONS = new Set(['issue', 'end', 'revoke', 'cleanup', 'policy_cleanup']);

const createAppSessionOperationId = (randomBytesFn = randomBytes) => (
  `op_v1_${randomBytesFn(16).toString('hex')}`
);

// Lock-root reservation is admission only. Advancing the existing canonical
// revision is the bounded authority fence; supported clients already understand
// this field. Missing sessions stay missing (no synthetic authority records).
const fenceSessionOperation = async ({ db, authUid, clock, expiresAtMs, advanceRevision,
  expectedSessionId, expectedSessionRevision }) => {
  const result = await db.ref(`app_sessions/${authUid}`).transaction((current) => {
    if (current === null) return null; // Cold cache must compare with the server.
    if (clock() >= expiresAtMs) return undefined;
    // Stop and other capability-reducing operations must still recover their
    // exact retained state when canonical authority is malformed or inactive.
    if (!advanceRevision) return current;
    // A stale scheduled candidate is not permission even to advance a newer
    // session's revision: its notification binding must remain coherent.
    if ((expectedSessionId && current.sessionId !== expectedSessionId)
      || (Number.isSafeInteger(expectedSessionRevision)
        && current.sessionRevision !== expectedSessionRevision)) return current;
    if (!Number.isSafeInteger(current.sessionRevision) || current.sessionRevision < 1
      || current.sessionRevision === Number.MAX_SAFE_INTEGER) return undefined;
    return { ...current, sessionRevision: current.sessionRevision + 1 };
  }, undefined, false);
  return { committed: Boolean(result?.committed), session: result.snapshot.val() || null };
};

const acquireAppSessionLock = async ({
  db,
  authUid,
  operation,
  owner = createAppSessionOperationId(),
  nowMs = Date.now(),
  ttlMs = APP_SESSION_LOCK_TTL_MS,
  clock = Date.now,
  expectedSessionId = null,
  expectedSessionRevision = null,
} = {}) => {
  if (!db || !authUid || !APP_SESSION_LOCK_OPERATIONS.has(operation)) {
    throw new Error('Invalid app session lock request');
  }
  const lockRef = db.ref(`app_session_locks/${authUid}`);
  const result = await lockRef.transaction((current) => {
    const heldByAnotherOperation = current
      && current.owner !== owner
      && Number(current.expiresAtMs) > nowMs;
    if (heldByAnotherOperation) return undefined;
    return {
      owner,
      operation,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
  }, undefined, false);
  const reserved = Boolean(result.committed && result.snapshot.val()?.owner === owner);
  let acquired = false;
  let fencedSession = null;
  let finalLock = result.snapshot.val() || null;
  if (reserved) {
    const fence = await fenceSessionOperation({ db, authUid, clock, expiresAtMs: nowMs + ttlMs,
      advanceRevision: SESSION_MUTATING_OPERATIONS.has(operation), expectedSessionId, expectedSessionRevision });
    fencedSession = fence.session;
    if (fence.committed) {
      const attached = await lockRef.transaction((current) => {
        if (current === null) return null;
        if (current.owner !== owner || Number(current.expiresAtMs) <= clock()) return undefined;
        return { ...current, sessionId: fencedSession?.sessionId || null,
          sessionRevision: fencedSession?.sessionRevision || null };
      }, undefined, false);
      finalLock = attached.snapshot.val() || null;
      acquired = Boolean(attached?.committed && finalLock?.owner === owner);
    }
  }
  if (reserved && !acquired) await releaseAppSessionLock({ db, authUid, owner });
  return {
    acquired,
    owner,
    lockRef,
    lock: finalLock,
    session: fencedSession,
  };
};

const releaseAppSessionLock = async ({ db, authUid, owner } = {}) => {
  if (!db || !authUid || !owner) return false;
  const result = await db.ref(`app_session_locks/${authUid}`).transaction((current) => (
    current?.owner === owner ? null : current
  ), undefined, false);
  return Boolean(result.committed && !result.snapshot.exists());
};

const renewAppSessionLock = async ({
  db,
  authUid,
  owner,
  nowMs = Date.now(),
  ttlMs = APP_SESSION_LOCK_TTL_MS,
  clock = Date.now,
} = {}) => {
  if (!db || !authUid || !owner || !Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Invalid app session lock renewal request');
  }
  const lockRef = db.ref(`app_session_locks/${authUid}`);
  const observed = (await lockRef.once('value')).val();
  if (!observed || observed.owner !== owner || Number(observed.expiresAtMs) <= Math.max(nowMs, clock())) return false;
  const sessionResult = await db.ref(`app_sessions/${authUid}`).transaction((current) => {
    if (current === null) return null;
    if (Number(observed.expiresAtMs) <= Math.max(nowMs, clock())) return undefined;
    if (current.sessionId !== observed.sessionId || current.sessionRevision !== observed.sessionRevision) return undefined;
    return current;
  }, undefined, false);
  if (!sessionResult?.committed || (observed.sessionId && !sessionResult.snapshot.exists())) return false;
  const result = await lockRef.transaction((current) => {
    // A cold RTDB cache is not proof that the server lease is missing.
    if (current === null) return null;
    if (!current || current.owner !== owner || Number(current.expiresAtMs || 0) <= Math.max(nowMs, clock())
      || current.sessionId !== observed.sessionId || current.sessionRevision !== observed.sessionRevision) return undefined;
    return { ...current, expiresAtMs: nowMs + ttlMs };
  }, undefined, false);
  return Boolean(result?.committed && result.snapshot.val()?.owner === owner);
};

module.exports = {
  APP_SESSION_LOCK_TTL_MS,
  APP_SESSION_LOCK_OPERATIONS,
  createAppSessionOperationId,
  acquireAppSessionLock,
  renewAppSessionLock,
  releaseAppSessionLock,
};
