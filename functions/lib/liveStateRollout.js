'use strict';

const LIVE_STATE_ROLLOUT_PATH = 'live_state_rollout/v1';
const LIVE_STATE_ROLLOUT_SCHEMA_VERSION = 1;
const LIVE_STATE_COMPATIBILITY_PHASE = 'compatibility';
const LIVE_STATE_CUTOVER_PHASE = 'cutover';
const LIVE_STATE_MINIMUM_SUPPORTED_VERSION = '1.0.5';
const LIVE_STATE_PHASES = new Set([LIVE_STATE_COMPATIBILITY_PHASE, LIVE_STATE_CUTOVER_PHASE]);
const LIVE_STATE_ROLLOUT_KEYS = Object.freeze(['phase', 'projectionRevision', 'schemaVersion', 'updatedAtMs']);

const defaultLiveStateRollout = () => ({
  schemaVersion: LIVE_STATE_ROLLOUT_SCHEMA_VERSION,
  phase: LIVE_STATE_COMPATIBILITY_PHASE,
  projectionRevision: 0,
  updatedAtMs: null,
});

const normalizeLiveStateRollout = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, isDefault: true, rollout: defaultLiveStateRollout() };
  }
  const valid = Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === LIVE_STATE_ROLLOUT_KEYS.join('|')
    && value.schemaVersion === LIVE_STATE_ROLLOUT_SCHEMA_VERSION
    && LIVE_STATE_PHASES.has(value.phase)
    && Number.isSafeInteger(value.projectionRevision) && value.projectionRevision >= 1
    && Number.isSafeInteger(value.updatedAtMs) && value.updatedAtMs > 0
  );
  return { valid, isDefault: false, rollout: valid ? { ...value } : null };
};

const readLiveStateRollout = async ({ database }) => {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const ref = database.ref(LIVE_STATE_ROLLOUT_PATH);
  const snapshot = typeof ref?.get === 'function' ? await ref.get() : await ref.once('value');
  const normalized = normalizeLiveStateRollout(snapshot.val());
  if (!normalized.valid) {
    const error = new Error('Live-state rollout configuration is invalid');
    error.code = 'LIVE_STATE_ROLLOUT_INVALID';
    throw error;
  }
  return normalized;
};

const transitionLiveStateRollout = ({ current, expectedRevision, phase, actorHash, nowMs = Date.now() } = {}) => {
  const normalized = normalizeLiveStateRollout(current);
  if (!normalized.valid) throw new Error('Live-state rollout configuration is invalid');
  if (!LIVE_STATE_PHASES.has(phase)) throw new Error('A valid live-state rollout phase is required');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== normalized.rollout.projectionRevision) {
    throw new Error('Live-state rollout revision changed');
  }
  if (actorHash !== undefined && (typeof actorHash !== 'string' || !/^[a-f0-9]{24}$/.test(actorHash))) throw new Error('A valid operations actor hash is required');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('A valid update timestamp is required');
  return {
    schemaVersion: LIVE_STATE_ROLLOUT_SCHEMA_VERSION,
    phase,
    projectionRevision: normalized.rollout.projectionRevision + 1,
    updatedAtMs: nowMs,
  };
};

const parseVersion = (value) => {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
};

const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

const isLiveStateClientSupported = ({ rollout, clientVersion }) => {
  const normalized = normalizeLiveStateRollout(rollout);
  if (!normalized.valid || normalized.rollout.phase !== LIVE_STATE_CUTOVER_PHASE) return true;
  const comparison = compareVersions(clientVersion, LIVE_STATE_MINIMUM_SUPPORTED_VERSION);
  return comparison !== null && comparison >= 0;
};

module.exports = {
  LIVE_STATE_COMPATIBILITY_PHASE,
  LIVE_STATE_CUTOVER_PHASE,
  LIVE_STATE_MINIMUM_SUPPORTED_VERSION,
  LIVE_STATE_ROLLOUT_PATH,
  compareVersions,
  defaultLiveStateRollout,
  isLiveStateClientSupported,
  normalizeLiveStateRollout,
  readLiveStateRollout,
  transitionLiveStateRollout,
};
