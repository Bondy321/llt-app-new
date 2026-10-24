'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { isValidPushToken, TOUR_NOTIFICATION_CATEGORY_KEYS } = require('./notificationPolicy');
const {
  buildMarketingAudienceUpdates,
} = require('./notificationMarketingAudience');
const { resolveOperationalAuthority } = require('./notificationAudiencePage');
const { verifyOperationsAdminAccess } = require('../administration/public');
const { publishNotificationMutation } = require('./notificationMutationPublication');
const { transitionSafetyAlertStatus } = require('../safety/public');

const { isActiveSessionRecord } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { acquireNotificationDeviceLock, releaseNotificationDeviceLock } = loadLegacyLibrary('appSessionCleanup');

const PERMISSION_STATES = new Set(['granted', 'provisional', 'ephemeral', 'denied', 'blocked', 'unavailable']);
const DEVICE_ACTIONS = new Set(['reconcile', 'preferences', 'logout', 'security_revoke']);

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
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const readPositiveRevision = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const resolveDeviceInput = (input, existing) => {
  const marketingPreferences = normalizeMarketingPreferences(
    hasOwn(input, 'marketingPreferences') ? input.marketingPreferences : existing.marketingPreferences,
  );
  const permissionState = String(
    hasOwn(input, 'permissionState') ? input.permissionState : (existing.permissionState || 'unavailable'),
  ).trim().toLowerCase();
  if (!PERMISSION_STATES.has(permissionState)) return { error: 'INVALID_PERMISSION_STATE' };
  const permissionAllowsPush = ['granted', 'provisional', 'ephemeral'].includes(permissionState);
  const token = hasOwn(input, 'pushToken')
    ? optionalString(input.pushToken, 300)
    : optionalString(existing.pushToken, 300);
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
const resolveOperationalRequest = (input, existing) => {
  const preserveExisting = input?.action === 'preferences';
  return {
    requested: input?.action === 'reconcile'
      ? input?.operationalEligible === true
      : preserveExisting && existing.operationalEligible === true,
    tourId: optionalString(input?.tourId, 160)
      || (preserveExisting ? optionalString(existing.operationalTourId, 160) : null),
    sessionId: optionalString(input?.appSessionId, 80)
      || (preserveExisting ? optionalString(existing.operationalSessionId, 80) : null),
    sessionRevision: readPositiveRevision(input?.appSessionRevision)
      || (preserveExisting ? readPositiveRevision(existing.operationalSessionRevision) : null),
  };
};
const sessionMatchesOperationalRequest = ({ session, authUid, request, nowMs }) => Boolean(
  isActiveSessionRecord(session, { nowMs })
  && session.authUid === authUid
  && session.sessionId === request.sessionId
  && Number(session.sessionRevision) === request.sessionRevision
  && session.tourId === request.tourId
);
const resolveOperationalEligibility = async (db, authUid, input, state, existing = {}, nowMs = Date.now()) => {
  const request = resolveOperationalRequest(input, existing);
  const base = { operationalEligible: false, requestedTourId: request.tourId };
  if (!request.requested || !request.tourId || !state.permissionAllowsPush || !state.token) return base;
  if (!request.sessionId || !request.sessionRevision) {
    return { ...base, reason: 'SESSION_BINDING_REQUIRED' };
  }
  const session = (await db.ref(`app_sessions/${authUid}`).once('value')).val();
  if (!sessionMatchesOperationalRequest({ session, authUid, request, nowMs })) {
    return { ...base, reason: 'SESSION_CHANGED' };
  }
  const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const authority = await resolveOperationalAuthority(db, authUid, profile, request.tourId, nowMs);
  return {
    operationalEligible: authority.allowed === true,
    requestedTourId: request.tourId,
    requestedSessionId: request.sessionId,
    requestedSessionRevision: request.sessionRevision,
    reason: authority.allowed === true ? null : (authority.reason || 'NOT_AUTHORIZED'),
  };
};
const buildNotificationDeviceRecord = ({ authUid, input, existing, action, state, token, operational, authoritySessionId, nowMs, registrationRevision }) => {
  const marketingEligible = isMarketingDeliveryEligible(action, state, token);
  return {
    schemaVersion: 1,
    authUid,
    pushToken: token,
    tokenHash: token ? createTokenHash(token) : null,
    provider: 'expo',
    status: action === 'security_revoke' ? 'revoked' : resolveDeviceStatus(token, state),
    permissionState: state.permissionState,
    permissionCanAskAgain: resolveStoredBoolean(input, existing, 'permissionCanAskAgain'),
    operationalEligible: operational.operationalEligible,
    operationalTourId: operational.operationalEligible ? operational.requestedTourId : null,
    operationalSessionId: operational.operationalEligible ? operational.requestedSessionId : null,
    operationalSessionRevision: operational.operationalEligible ? operational.requestedSessionRevision : null,
    // Ownership is current server-verified session authority, independently of
    // permission, consent, token or operational tour delivery eligibility.
    authoritySessionId,
    marketingEligible,
    marketingPreferences: state.marketingPreferences,
    marketingConsentVersion: 1,
    marketingConsentUpdatedAtMs: hasOwn(input, 'marketingPreferences') ? nowMs : Number(existing.marketingConsentUpdatedAtMs || nowMs),
    appVersion: preferOptionalString(input, existing, 'appVersion', 40),
    appBuild: preferOptionalString(input, existing, 'appBuild', 40),
    platform: preferOptionalString(input, existing, 'platform', 20),
    registrationRevision,
    lastMutationAction: action,
    lastMutationSessionId: optionalString(input?.appSessionId, 80),
    updatedAtMs: nowMs,
    createdAtMs: Number(existing.createdAtMs || nowMs),
  };
};

const ignoredDeviceMutation = (reason) => ({
  status: 200,
  body: { success: true, ignored: true, reason },
});
const removeNotificationDeviceRecords = async (db, authUid, existing, input, nowMs) => {
  const [consentSnapshot, tombstoneSnapshot] = await Promise.all([
    db.ref(`notification_consents/${authUid}`).once('value'),
    db.ref(`notification_device_tombstones/${authUid}`).once('value'),
  ]);
  const tombstone = tombstoneSnapshot.val() || null;
  if ((!existing || Object.keys(existing).length === 0) && !consentSnapshot.exists()
    && tombstone?.permanent === true) {
    await db.ref().update(buildMarketingAudienceUpdates({ authUid, device: null }));
    return { status: 200, body: { success: true, deleted: true, alreadyDeleted: true } };
  }
  const suppliedRevision = readPositiveRevision(input?.registrationRevision ?? input?.mutationRevision);
  const registrationRevision = Math.max(
    suppliedRevision || 0,
    (readPositiveRevision(existing?.registrationRevision) || 0) + 1,
    (readPositiveRevision(tombstone?.registrationRevision) || 0) + 1,
  );
  await db.ref().update({
    [`notification_devices/${authUid}`]: null,
    [`notification_consents/${authUid}`]: null,
    ...buildMarketingAudienceUpdates({ authUid, device: null }),
    [`notification_device_tombstones/${authUid}`]: {
      schemaVersion: 1,
      permanent: true,
      registrationRevision,
      deletedAtMs: nowMs,
    },
  });
  return { status: 200, body: { success: true, deleted: true } };
};

/** @param {{ db?: any, authUid: string, nowMs?: number, owner?: string }} options */
const deleteNotificationAccountState = async ({
  db = admin.database(), authUid, nowMs = Date.now(), owner = randomUUID(),
}) => {
  if (!isValidFirebaseKey(authUid)) throw new Error('Invalid notification account UID');
  const lock = await acquireNotificationDeviceLock({ db, authUid, owner, nowMs });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Notification device update in progress'));
    error.code = 'DEVICE_UPDATE_IN_PROGRESS';
    throw error;
  }
  try {
    const existing = (await db.ref(`notification_devices/${authUid}`).once('value')).val() || {};
    return removeNotificationDeviceRecords(db, authUid, existing, {}, nowMs);
  } finally {
    await releaseNotificationDeviceLock({ lockRef: lock.lockRef, owner });
  }
};
const endedLogoutDeviceOwner = existing => existing.authoritySessionId
  || (existing.lastMutationAction === 'logout' ? existing.lastMutationSessionId : null);
const isOwnedEndedLogout = ({ action, requestedSessionId, session, existing }) => Boolean(
  action === 'logout' && requestedSessionId
  && (!session?.sessionId || session.sessionId === requestedSessionId)
  && endedLogoutDeviceOwner(existing) === requestedSessionId
);
const supportedInstallationPublication = publication => !publication || (
  publication.schemaVersion === 1 && /^[a-f0-9]{48}$/.test(publication.epoch || '')
  && ['prepared', 'committed', 'blocked', 'deletion_prepared', 'deleted'].includes(publication.state)
);
const publicationBlocksRegistration = (publication, requestedSessionId) => (
  ['deleted', 'deletion_prepared', 'prepared'].includes(publication?.state)
  || (publication?.state === 'blocked' && requestedSessionId
    && publication.previousSessionId && publication.previousSessionId !== requestedSessionId)
);
const resolveRegistrationAuthority = ({ authUid, requestedSessionId, session, publication, nowMs, action, existing }) => {
  if (!supportedInstallationPublication(publication) || publicationBlocksRegistration(publication, requestedSessionId)) {
    return { rejected: true, sessionId: null, expiresAtMs: null };
  }
  const active = isActiveSessionRecord(session, { nowMs }) && session.authUid === authUid
    && publication?.state === 'committed' && publication.sessionId === session.sessionId;
  if (!requestedSessionId && session?.status === 'active') return { rejected: true, sessionId: null, expiresAtMs: null };
  if (active && !requestedSessionId) return { rejected: true, sessionId: null, expiresAtMs: null };
  if (requestedSessionId && (!active || session.sessionId !== requestedSessionId)) {
    // Mobile ends the canonical session before its notification logout. Exact
    // server-owned device proof still permits that delivery-reducing cleanup;
    // it cannot authorise registration/preferences or affect a replacement.
    if (isOwnedEndedLogout({ action, requestedSessionId, session, existing })) {
      return { rejected: false, sessionId: null, expiresAtMs: null, endedLogout: true };
    }
    return { rejected: true, sessionId: null, expiresAtMs: null };
  }
  return { rejected: false, sessionId: active ? session.sessionId : null,
    expiresAtMs: active ? session.expiresAtMs : null };
};
const resolveTransactionRejection = ({ current, suppliedRevision, registrationRevision, action, requestedSessionId }) => {
  const currentRevision = Number(current.registrationRevision || 0);
  if (suppliedRevision && registrationRevision < currentRevision) return 'STALE_DEVICE_MUTATION';
  if (suppliedRevision && registrationRevision === currentRevision) {
    return current.lastMutationAction === action
      && (current.lastMutationSessionId || null) === (requestedSessionId || null)
      ? 'ALREADY_APPLIED'
      : 'STALE_DEVICE_MUTATION';
  }
  if (action === 'logout' && requestedSessionId
    && current.operationalSessionId && current.operationalSessionId !== requestedSessionId) {
    return 'STALE_APP_SESSION';
  }
  return null;
};
const applyNotificationDeviceMutation = async ({
  db, authUid, input, action, state, token, operational, suppliedRevision, registrationRevision,
  requestedSessionId, nowMs, authority, existing, canMutate, publication, tombstone, expiresAtMs, createPublisher,
}) => {
  if (!canMutate()) return ignoredDeviceMutation('SESSION_CHANGED');
  const rejected = resolveTransactionRejection({ current: existing, suppliedRevision,
    registrationRevision, action, requestedSessionId });
  if (rejected && rejected !== 'ALREADY_APPLIED') return ignoredDeviceMutation(rejected);
  const nextRecord = rejected === 'ALREADY_APPLIED' ? existing : buildNotificationDeviceRecord({
    authUid, input, existing, action, state, token, operational,
    authoritySessionId: authority.sessionId, nowMs, registrationRevision,
  });
  const revision = Number(nextRecord.registrationRevision);
  const updates = {
    [`notification_devices/${authUid}`]: nextRecord,
    [`notification_consents/${authUid}`]: { schemaVersion: 1, authUid,
      marketingPreferences: nextRecord.marketingPreferences, consentVersion: 1,
      consentUpdatedAtMs: nextRecord.marketingConsentUpdatedAtMs, registrationRevision: revision, updatedAtMs: nowMs },
    ...buildMarketingAudienceUpdates({ authUid, device: nextRecord }),
  };
  try {
    await publishNotificationMutation({ db, authUid, publication, sessionId: authority.sessionId,
      existing, tombstone, updates, expiresAtMs, canMutate, createPublisher });
  } catch (error) {
    if (['SESSION_CHANGED', 'PERMISSION_DENIED', 'permission_denied'].includes(error?.code)) return ignoredDeviceMutation('SESSION_CHANGED');
    throw error;
  }
  if (rejected) return ignoredDeviceMutation(rejected);
  return { status: 200, body: { success: true, device: { permissionState: nextRecord.permissionState,
    operationalEligible: nextRecord.operationalEligible, marketingEligible: nextRecord.marketingEligible,
    status: nextRecord.status, tokenHash: nextRecord.tokenHash, registrationRevision: revision, updatedAtMs: nowMs } } };
};
const processLockedNotificationDeviceUpdate = async ({ db, ref, authUid, input, action, nowMs, clock, expiresAtMs, createPublisher }) => {
  const existing = (await ref.once('value')).val() || {};
  const tombstone = (await db.ref(`notification_device_tombstones/${authUid}`).once('value')).val();
  if (tombstone?.permanent === true) return ignoredDeviceMutation('DEVICE_DELETED');
  const suppliedRevision = readPositiveRevision(input?.registrationRevision ?? input?.mutationRevision);
  const registrationRevision = suppliedRevision || (readPositiveRevision(existing.registrationRevision) || 0) + 1;
  const session = (await db.ref(`app_sessions/${authUid}`).once('value')).val();
  const requestedSessionId = optionalString(input?.appSessionId, 80);
  const publication = (await db.ref(`app_session_authority/${authUid}`).once('value')).val();
  const authority = resolveRegistrationAuthority({ authUid, requestedSessionId, session, publication, nowMs: clock(), action, existing });
  if (authority.rejected) return ignoredDeviceMutation('STALE_APP_SESSION');
  // Recovery logout can reduce existing delivery, never install a new token,
  // permission or consent from an expired request.
  const effectiveInput = authority.endedLogout ? { action, appSessionId: requestedSessionId } : input;
  const state = resolveDeviceInput(effectiveInput, existing);
  if (state.error) return { status: 400, body: { success: false, reason: state.error } };
  const token = shouldKeepToken(action, state) ? state.token : null;
  // The local deadline stops new preparation. Restricted publication additionally
  // checks current authority and the deadline at the actual server commit.
  const canMutate = () => clock() < expiresAtMs
    && (!authority.expiresAtMs || clock() < authority.expiresAtMs);
  const operational = await resolveOperationalEligibility(
    db, authUid, { ...effectiveInput, action }, { ...state, token }, existing, clock(),
  );
  return applyNotificationDeviceMutation({
    db, ref, authUid, input: effectiveInput, action, state, token, operational,
    suppliedRevision, registrationRevision, requestedSessionId, nowMs, authority, existing, canMutate,
    publication, tombstone, expiresAtMs, createPublisher,
  });
};

/** @param {{ db?: any, authUid: string, input: any, nowMs?: number, clock?: () => number, createPublisher?: any }} options */
const updateNotificationDevice = async ({ db = admin.database(), authUid, input, nowMs = Date.now(), clock = Date.now, createPublisher }) => {
  const action = String(input?.action || 'reconcile').trim();
  if (!DEVICE_ACTIONS.has(action)) return { status: 400, body: { success: false, reason: 'INVALID_ACTION' } };
  const ref = db.ref(`notification_devices/${authUid}`);
  const operationOwner = randomUUID();
  const sessionLock = await acquireAppSessionLock({ db, authUid, operation: 'notification_device', owner: operationOwner, nowMs, clock });
  if (!sessionLock.acquired) return { status: 409, body: { success: false, reason: 'SESSION_IN_PROGRESS' } };
  let deviceLock = null;
  try {
    deviceLock = await acquireNotificationDeviceLock({ db, authUid, owner: operationOwner, nowMs });
    if (!deviceLock.acquired) return { status: 409, body: { success: false, reason: 'DEVICE_UPDATE_IN_PROGRESS' } };
    return await processLockedNotificationDeviceUpdate({ db, ref, authUid, input, action, nowMs, clock,
      expiresAtMs: sessionLock.lock.expiresAtMs, createPublisher });
  } finally {
    if (deviceLock?.acquired) await releaseNotificationDeviceLock({ lockRef: deviceLock.lockRef, owner: operationOwner });
    await releaseAppSessionLock({ db, authUid, owner: operationOwner });
  }
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
  return auth;
};

const updateNotificationDeviceRegistration = onRequest({
  region: 'europe-west1',
  maxInstances: 20,
  cors: false,
}, async (req, res) => {
  const requestAuth = await requirePostAuth(req, res);
  if (!requestAuth) return;
  const authUid = requestAuth.uid;
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
  const requestAuth = await requirePostAuth(req, res);
  if (!requestAuth) return;
  const authUid = requestAuth.uid;
  const result = await readMarketingNotificationDetail({
    authUid,
    broadcastId: optionalString(req.body?.broadcastId, 160) || '',
    categoryKey: optionalString(req.body?.categoryKey, 80) || '',
  });
  res.status(result.status).json(result.body);
});

/** @param {{ db?: any, authUid: string, tourId: string, eventId: string, claims?: any }} options */
const readSafetyAlertDetail = async ({ db = admin.database(), authUid, tourId, eventId, claims }) => {
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(eventId)) return { status: 400, body: { success: false, reason: 'INVALID_INPUT' } };
  const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const adminAllowed = await verifyOperationsAdminAccess({ db, authUid, claims, requireSecondFactor: true });
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

/** @param {{ db?: any, authUid: string, tourId: string, eventId: string, action: string, notes?: string | null, nowMs?: number, claims?: any }} options */
const updateSafetyAlertStatus = async ({
  db = admin.database(), authUid, tourId, eventId, action, notes = null, nowMs = Date.now(), claims,
}) => {
  const access = await readSafetyAlertDetail({ db, authUid, tourId, eventId, claims });
  if (access.status !== 200) return access;
  const transition = await transitionSafetyAlertStatus({
    db, tourId, eventId, action, notes: optionalString(notes, 500), actorAuthUid: authUid, nowMs,
  });
  if (transition.status !== 200) {
    return { status: transition.status, body: { success: false, reason: transition.reason } };
  }
  return readSafetyAlertDetail({ db, authUid, tourId, eventId, claims });
};

const getSafetyAlertDetail = onRequest({ region: 'europe-west1', maxInstances: 20, cors: false }, async (req, res) => {
  if (!applyAuthenticatedCors(req, res)) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const requestAuth = await requirePostAuth(req, res);
  if (!requestAuth) return;
  const authUid = requestAuth.uid;
  const input = {
    authUid, claims: requestAuth.claims,
    tourId: optionalString(req.body?.tourId, 160) || '',
    eventId: optionalString(req.body?.eventId, 160) || '',
    notes: optionalString(req.body?.notes, 500),
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
  deleteNotificationAccountState,
  getMarketingNotificationDetail,
  getSafetyAlertDetail,
  normalizeMarketingPreferences,
  removeNotificationDeviceRecords,
  readMarketingNotificationDetail,
  readSafetyAlertDetail,
  updateSafetyAlertStatus,
  updateNotificationDevice,
  updateNotificationDeviceRegistration,
};
