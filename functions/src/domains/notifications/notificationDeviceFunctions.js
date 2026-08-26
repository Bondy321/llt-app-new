'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { isValidPushToken, TOUR_NOTIFICATION_CATEGORY_KEYS } = require('./notificationPolicy');
const { isOperationsAdmin, resolveOperationalAuthority } = require('./notificationAudiencePage');

const PERMISSION_STATES = new Set(['granted', 'provisional', 'ephemeral', 'denied', 'blocked', 'unavailable']);
const DEVICE_ACTIONS = new Set(['reconcile', 'preferences', 'logout', 'security_revoke', 'delete']);

/** @param {any} value */
const normalizeMarketingPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(TOUR_NOTIFICATION_CATEGORY_KEYS.map((key) => [key, source[key] === true]));
};

/** @param {string} token */
const createTokenHash = (token) => createHash('sha256').update(token).digest('hex');

/** @param {any} value @param {number} maxLength */
const optionalString = (value, maxLength) => (
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
);
const resolveDeviceInput = (input, existing) => {
  const marketingPreferences = normalizeMarketingPreferences(input?.marketingPreferences || existing.marketingPreferences);
  const permissionState = String(input?.permissionState || existing.permissionState || 'unavailable').trim().toLowerCase();
  if (!PERMISSION_STATES.has(permissionState)) return { error: 'INVALID_PERMISSION_STATE' };
  const permissionAllowsPush = ['granted', 'provisional', 'ephemeral'].includes(permissionState);
  const token = optionalString(input?.pushToken, 300) || optionalString(existing.pushToken, 300);
  if (token && !isValidPushToken(token)) return { error: 'INVALID_PUSH_TOKEN' };
  return { marketingPreferences, hasMarketingConsent: Object.values(marketingPreferences).some(Boolean), permissionState, permissionAllowsPush, token };
};
const shouldKeepToken = (action, state) => state.permissionAllowsPush && action !== 'security_revoke' && !(action === 'logout' && !state.hasMarketingConsent);
const resolveDeviceStatus = (token, state) => token ? 'active' : (state.permissionAllowsPush ? 'inactive' : state.permissionState);
const resolveStoredBoolean = (input, existing, key) => (
  Object.prototype.hasOwnProperty.call(input || {}, key) ? input[key] === true : existing?.[key] === true
);
const preferOptionalString = (input, existing, key, maxLength) => (
  optionalString(input?.[key], maxLength) || optionalString(existing?.[key], maxLength)
);
const isMarketingDeliveryEligible = (action, state, token) => Boolean(
  action !== 'security_revoke' && state.permissionAllowsPush && token && state.hasMarketingConsent
);
const resolveOperationalEligibility = async (db, authUid, input, state, existing = {}) => {
  const tourId = optionalString(input?.tourId, 160) || (input?.action === 'preferences' ? optionalString(existing.operationalTourId, 160) : null);
  const requested = input?.action === 'reconcile' ? input?.operationalEligible === true : input?.action === 'preferences' && existing.operationalEligible === true;
  if (!(requested && tourId && state.permissionAllowsPush && state.token)) return { operationalEligible: false, requestedTourId: tourId };
  const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const authority = await resolveOperationalAuthority(db, authUid, profile, tourId);
  return { operationalEligible: authority.allowed === true, requestedTourId: tourId };
};
const persistNotificationDevice = async (db, ref, authUid, input, existing, action, state, token, operational, nowMs) => {
  const marketingEligible = isMarketingDeliveryEligible(action, state, token);
  const next = { schemaVersion: 1, authUid, pushToken: token, tokenHash: token ? createTokenHash(token) : null, provider: 'expo', status: resolveDeviceStatus(token, state), permissionState: state.permissionState, permissionCanAskAgain: resolveStoredBoolean(input, existing, 'permissionCanAskAgain'), operationalEligible: operational.operationalEligible, operationalTourId: operational.operationalEligible ? operational.requestedTourId : null, marketingEligible, marketingPreferences: state.marketingPreferences, marketingConsentVersion: 1, marketingConsentUpdatedAtMs: input?.marketingPreferences ? nowMs : Number(existing.marketingConsentUpdatedAtMs || nowMs), appVersion: preferOptionalString(input, existing, 'appVersion', 40), appBuild: preferOptionalString(input, existing, 'appBuild', 40), platform: preferOptionalString(input, existing, 'platform', 20), updatedAtMs: nowMs, createdAtMs: Number(existing.createdAtMs || nowMs) };
  await Promise.all([ref.set(next), db.ref(`notification_consents/${authUid}`).set({ schemaVersion: 1, authUid, marketingPreferences: state.marketingPreferences, consentVersion: 1, consentUpdatedAtMs: next.marketingConsentUpdatedAtMs, updatedAtMs: nowMs })]);
  return { status: 200, body: { success: true, device: { permissionState: state.permissionState, operationalEligible: operational.operationalEligible, marketingEligible, status: next.status, tokenHash: next.tokenHash, updatedAtMs: nowMs } } };
};

/** @param {{ db?: any, authUid: string, input: any, nowMs?: number }} options */
const updateNotificationDevice = async ({ db = admin.database(), authUid, input, nowMs = Date.now() }) => {
  const action = String(input?.action || 'reconcile').trim();
  if (!DEVICE_ACTIONS.has(action)) return { status: 400, body: { success: false, reason: 'INVALID_ACTION' } };
  const ref = db.ref(`notification_devices/${authUid}`);
  if (action === 'delete') {
    await Promise.all([
      ref.remove(),
      db.ref(`notification_consents/${authUid}`).remove(),
    ]);
    return { status: 200, body: { success: true, deleted: true } };
  }
  const existing = (await ref.once('value')).val() || {};
  const state = resolveDeviceInput(input, existing);
  if (state.error) return { status: 400, body: { success: false, reason: state.error } };
  let token = shouldKeepToken(action, state) ? state.token : null;
  const operational = await resolveOperationalEligibility(db, authUid, { ...input, action }, { ...state, token }, existing);
  return persistNotificationDevice(db, ref, authUid, input, existing, action, state, token, operational, nowMs);
};

/** @param {any} req @param {any} res */
const requirePostAuth = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    return null;
  }
  const auth = await verifyRequestAuthUid(req);
  if (!auth.success) {
    res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    return null;
  }
  return auth.uid;
};

const updateNotificationDeviceRegistration = onRequest({
  region: 'europe-west1',
  maxInstances: 20,
  cors: false,
}, async (req, res) => {
  const authUid = await requirePostAuth(req, res);
  if (!authUid) return;
  const result = await updateNotificationDevice({ authUid, input: req.body || {} });
  res.status(result.status).json(result.body);
});

/** @param {{ db?: any, authUid: string, broadcastId: string, categoryKey: string, nowMs?: number }} options */
const readMarketingNotificationDetail = async ({
  db = admin.database(), authUid, broadcastId, categoryKey, nowMs = Date.now(),
}) => {
  if (!isValidFirebaseKey(broadcastId) || !isValidFirebaseKey(categoryKey)) return { status: 400, body: { success: false, reason: 'INVALID_INPUT' } };
  const [deviceSnapshot, detailSnapshot] = await Promise.all([
    db.ref(`notification_devices/${authUid}`).once('value'),
    db.ref(`marketing_notification_details/${broadcastId}`).once('value'),
  ]);
  const device = deviceSnapshot.val() || {};
  const detail = detailSnapshot.val();
  if (!detail || detail.categoryKey !== categoryKey) return { status: 404, body: { success: false, reason: 'NOT_FOUND' } };
  if (Number(detail.expiresAtMs || 0) <= nowMs) return { status: 410, body: { success: false, reason: 'EXPIRED' } };
  if (device.marketingPreferences?.[categoryKey] !== true) {
    return { status: 403, body: { success: false, reason: 'CONSENT_REQUIRED' } };
  }
  return {
    status: 200,
    body: {
      success: true,
      detail: {
        schemaVersion: 1,
        broadcastId,
        categoryKey,
        title: detail.title,
        body: detail.body,
        createdAtMs: detail.createdAtMs,
        expiresAtMs: detail.expiresAtMs,
        cta: detail.cta || null,
        status: detail.status,
      },
    },
  };
};

const getMarketingNotificationDetail = onRequest({ region: 'europe-west1', maxInstances: 20, cors: false }, async (req, res) => {
  const authUid = await requirePostAuth(req, res);
  if (!authUid) return;
  const result = await readMarketingNotificationDetail({
    authUid,
    broadcastId: optionalString(req.body?.broadcastId, 160) || '',
    categoryKey: optionalString(req.body?.categoryKey, 80) || '',
  });
  res.status(result.status).json(result.body);
});

/** @param {{ db?: any, authUid: string, tourId: string, eventId: string }} options */
const readSafetyAlertDetail = async ({ db = admin.database(), authUid, tourId, eventId }) => {
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(eventId)) return { status: 400, body: { success: false, reason: 'INVALID_INPUT' } };
  const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const adminAllowed = await isOperationsAdmin(db, authUid);
  const authority = adminAllowed ? { allowed: true } : await resolveOperationalAuthority(db, authUid, profile, tourId);
  if (!authority.allowed || (!adminAllowed && authority.role !== 'driver')) {
    return { status: 403, body: { success: false, reason: 'NOT_AUTHORIZED' } };
  }
  const snapshot = await db.ref(`tours/${tourId}/safetyAlerts/${eventId}`).once('value');
  const alert = snapshot.val();
  if (!alert) return { status: 404, body: { success: false, reason: 'NOT_FOUND' } };
  return {
    status: 200,
    body: {
      success: true,
      alert: {
        schemaVersion: 1,
        eventId,
        tourId,
        category: optionalString(alert.category, 60),
        severity: optionalString(alert.severity, 20),
        status: optionalString(alert.status, 30),
        summary: optionalString(alert.message, 240),
        createdAtMs: Number(alert.receivedAtMs || alert.timestampMs || 0),
        resolved: alert.status === 'resolved',
      },
    },
  };
};

const SAFETY_STATUS_ACTIONS = Object.freeze({
  acknowledge: 'acknowledged',
  start_response: 'in_progress',
  resolve: 'resolved',
});

/** @param {{ db?: any, authUid: string, tourId: string, eventId: string, action: string, nowMs?: number }} options */
const updateSafetyAlertStatus = async ({
  db = admin.database(), authUid, tourId, eventId, action, nowMs = Date.now(),
}) => {
  const access = await readSafetyAlertDetail({ db, authUid, tourId, eventId });
  if (access.status !== 200) return access;
  const nextStatus = SAFETY_STATUS_ACTIONS[action];
  if (!nextStatus) return { status: 400, body: { success: false, reason: 'INVALID_ACTION' } };
  const alertRef = db.ref(`tours/${tourId}/safetyAlerts/${eventId}`);
  const result = await alertRef.transaction((current) => {
    if (!current || current.status === 'resolved') return;
    if (current.status === nextStatus) return current;
    return {
      ...current,
      status: nextStatus,
      statusUpdatedAt: new Date(nowMs).toISOString(),
      statusUpdatedAtMs: nowMs,
      statusUpdatedBy: authUid,
    };
  });
  const updated = result?.snapshot?.val?.();
  if (!updated) {
    return { status: 409, body: { success: false, reason: 'ALREADY_RESOLVED' } };
  }
  return readSafetyAlertDetail({ db, authUid, tourId, eventId });
};

const getSafetyAlertDetail = onRequest({ region: 'europe-west1', maxInstances: 20, cors: false }, async (req, res) => {
  const authUid = await requirePostAuth(req, res);
  if (!authUid) return;
  const input = {
    authUid,
    tourId: optionalString(req.body?.tourId, 160) || '',
    eventId: optionalString(req.body?.eventId, 160) || '',
  };
  const action = optionalString(req.body?.action, 40);
  const result = action
    ? await updateSafetyAlertStatus({ ...input, action })
    : await readSafetyAlertDetail(input);
  res.status(result.status).json(result.body);
});

module.exports = {
  DEVICE_ACTIONS,
  PERMISSION_STATES,
  createTokenHash,
  getMarketingNotificationDetail,
  getSafetyAlertDetail,
  normalizeMarketingPreferences,
  readMarketingNotificationDetail,
  readSafetyAlertDetail,
  updateSafetyAlertStatus,
  updateNotificationDevice,
  updateNotificationDeviceRegistration,
};
