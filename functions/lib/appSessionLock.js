'use strict';

const { randomBytes } = require('crypto');

const APP_SESSION_LOCK_TTL_MS = 30 * 1000;
const APP_SESSION_LOCK_OPERATIONS = new Set(['issue', 'end', 'assign', 'revoke', 'cleanup']);

const createAppSessionOperationId = (randomBytesFn = randomBytes) => (
  `op_v1_${randomBytesFn(16).toString('hex')}`
);

const acquireAppSessionLock = async ({
  db,
  authUid,
  operation,
  owner = createAppSessionOperationId(),
  nowMs = Date.now(),
  ttlMs = APP_SESSION_LOCK_TTL_MS,
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
  return {
    acquired: Boolean(result.committed && result.snapshot.val()?.owner === owner),
    owner,
    lockRef,
    lock: result.snapshot.val() || null,
  };
};

const releaseAppSessionLock = async ({ db, authUid, owner } = {}) => {
  if (!db || !authUid || !owner) return false;
  const result = await db.ref(`app_session_locks/${authUid}`).transaction((current) => (
    current?.owner === owner ? null : current
  ), undefined, false);
  return Boolean(result.committed && !result.snapshot.exists());
};

module.exports = {
  APP_SESSION_LOCK_TTL_MS,
  APP_SESSION_LOCK_OPERATIONS,
  createAppSessionOperationId,
  acquireAppSessionLock,
  releaseAppSessionLock,
};
