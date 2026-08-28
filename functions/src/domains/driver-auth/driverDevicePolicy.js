'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');

const DRIVER_LOGIN_POLICY_PATH = 'driver_login_policy/v1';
const DRIVER_LOGIN_POLICY_LOCK_PATH = 'driver_login_policy_locks/v1';
const DRIVER_LOGIN_POLICY_SCHEMA_VERSION = 1;
const DRIVER_LOGIN_POLICY_LOCK_TTL_MS = 60 * 1000;

const defaultDriverLoginPolicy = () => ({
  schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
  enforceSingleDevice: false,
  generation: 0,
  revision: 0,
  updatedAtMs: null,
});

/** @param {unknown} value */
const normalizeDriverLoginPolicy = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, isDefault: true, policy: defaultDriverLoginPolicy() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, isDefault: false, policy: null };
  }
  const record = /** @type {Record<string, any>} */ (value);
  const valid = record.schemaVersion === DRIVER_LOGIN_POLICY_SCHEMA_VERSION
    && typeof record.enforceSingleDevice === 'boolean'
    && Number.isSafeInteger(record.generation) && record.generation >= 0
    && Number.isSafeInteger(record.revision) && record.revision >= 1
    && Number.isSafeInteger(record.updatedAtMs) && record.updatedAtMs > 0;
  return { valid, isDefault: false, policy: valid ? {
    schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
    enforceSingleDevice: record.enforceSingleDevice,
    generation: record.generation,
    revision: record.revision,
    updatedAtMs: record.updatedAtMs,
  } : null };
};

/** @param {{ db: any }} input */
const readDriverLoginPolicy = async ({ db }) => {
  const snapshot = await db.ref(DRIVER_LOGIN_POLICY_PATH).once('value');
  const normalized = normalizeDriverLoginPolicy(snapshot.val());
  if (!normalized.valid) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Driver login policy is malformed'));
    error.code = 'POLICY_CONFIGURATION_INVALID';
    throw error;
  }
  return normalized;
};

/** @param {{ db: any, nowMs?: number }} input */
const ensureDriverLoginPolicy = async ({ db, nowMs = Date.now() }) => {
  const ref = db.ref(DRIVER_LOGIN_POLICY_PATH);
  const result = await ref.transaction((current) => current ?? {
    schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
    enforceSingleDevice: false,
    generation: 0,
    revision: 1,
    updatedAtMs: nowMs,
  }, undefined, false);
  const normalized = normalizeDriverLoginPolicy(result.snapshot.val());
  if (!normalized.valid) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Driver login policy is malformed'));
    error.code = 'POLICY_CONFIGURATION_INVALID';
    throw error;
  }
  return normalized;
};

/** @param {any} session @param {any} policy */
const driverSessionMatchesPolicyGeneration = (session, policy) => {
  const sessionGeneration = Number.isSafeInteger(session?.driverLoginPolicyGeneration)
    ? session.driverLoginPolicyGeneration
    : 0;
  return sessionGeneration === policy.generation;
};

/** @param {{ policy: any, authUid: string, claimedAuthUid?: unknown }} input */
const driverBindingAllowedByPolicy = ({ policy, authUid, claimedAuthUid }) => (
  policy.enforceSingleDevice !== true || String(claimedAuthUid || '').trim() === authUid
);

/** @param {{ db: any, owner?: string, nowMs?: number }} input */
const acquireDriverLoginPolicyLock = async ({ db, owner = randomUUID(), nowMs = Date.now() }) => ({
  acquired: await acquireManualBookingLock({
    db,
    path: DRIVER_LOGIN_POLICY_LOCK_PATH,
    owner,
    nowMs,
    ttlMs: DRIVER_LOGIN_POLICY_LOCK_TTL_MS,
  }),
  owner,
});

/** @param {{ db: any, owner: string }} input */
const releaseDriverLoginPolicyLock = ({ db, owner }) => releaseManualBookingLock({
  db, path: DRIVER_LOGIN_POLICY_LOCK_PATH, owner,
});

module.exports = {
  DRIVER_LOGIN_POLICY_LOCK_PATH,
  DRIVER_LOGIN_POLICY_PATH,
  acquireDriverLoginPolicyLock,
  defaultDriverLoginPolicy,
  driverBindingAllowedByPolicy,
  driverSessionMatchesPolicyGeneration,
  ensureDriverLoginPolicy,
  normalizeDriverLoginPolicy,
  readDriverLoginPolicy,
  releaseDriverLoginPolicyLock,
};
