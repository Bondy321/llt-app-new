'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { verifyOperationsAdminAccess } = require('../administration/public');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');

const {
  normalizeLiveStateRollout,
  readLiveStateRollout,
  transitionLiveStateRollout,
} = loadLegacyLibrary('driverLocationProjection');

const onRequestWithResult = /** @type {any} */ (onRequest);
const ROLLOUT_PATH = 'live_state_rollout/v1';
const CUTOVER_PREREQUISITE_REASON = 'LIVE_STATE_CUTOVER_PREREQUISITE_NOT_MET';

const evaluateOperationalRolloutPhase = (phase) => phase === 'cutover'
  ? { allowed: false, reason: CUTOVER_PREREQUISITE_REASON }
  : { allowed: true, reason: null };

const authorize = async ({ req, res }) => {
  if (!applyAuthenticatedCors(req, res)) return null;
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return null;
  }
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    return null;
  }
  const db = admin.database();
  if (!(await verifyOperationsAdminAccess({ authUid: String(requestAuth.uid), db }))) {
    res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    return null;
  }
  return { db };
};

const getLiveStateRollout = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorize({ req, res });
    if (!access) return null;
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }
    try {
      const context = await readLiveStateRollout({ database: access.db });
      return res.status(200).json({ success: true, rollout: context.rollout, isDefault: context.isDefault });
    } catch {
      return res.status(500).json({ success: false, reason: 'LIVE_STATE_ROLLOUT_INVALID' });
    }
  },
);

const setLiveStateRollout = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 1, timeoutSeconds: 60, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorize({ req, res });
    if (!access) return null;
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const phase = req.body?.phase;
    const expectedRevision = req.body?.expectedRevision;
    if (!['compatibility', 'cutover'].includes(phase)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const operationalGate = evaluateOperationalRolloutPhase(phase);
    if (!operationalGate.allowed) {
      return res.status(409).json({ success: false, reason: operationalGate.reason });
    }
    let conflictReason = null;
    const nowMs = Date.now();
    const result = await access.db.ref(ROLLOUT_PATH).transaction((current) => {
      try {
        return transitionLiveStateRollout({ current, expectedRevision, phase, nowMs });
      } catch (error) {
        conflictReason = /invalid/i.test(error.message) ? 'LIVE_STATE_ROLLOUT_INVALID' : 'ROLLOUT_CHANGED';
        return undefined;
      }
    }, undefined, false);
    if (!result?.committed) {
      return res.status(conflictReason === 'LIVE_STATE_ROLLOUT_INVALID' ? 500 : 409)
        .json({ success: false, reason: conflictReason || 'ROLLOUT_CHANGED' });
    }
    const normalized = normalizeLiveStateRollout(result.snapshot.val());
    if (!normalized.valid) return res.status(500).json({ success: false, reason: 'LIVE_STATE_ROLLOUT_INVALID' });
    return res.status(200).json({ success: true, rollout: normalized.rollout });
  },
);

module.exports = { evaluateOperationalRolloutPhase, getLiveStateRollout, setLiveStateRollout };
