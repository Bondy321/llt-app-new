'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { log } = require('../../infrastructure/logging/safeLogger');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { verifyOperationsAdminAccess } = require('../administration/public');
const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { distributedLoginRateLimiter } = require('../passenger-auth/public');
const { normalizeSessionEndRequest } = require('./sessionRequestBoundary');
const { isValidAppSessionId } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { cleanupAppSession } = loadLegacyLibrary('appSessionCleanup');

const onRequestWithResult = /** @type {any} */ (onRequest);

const endAppSession = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const { expectedSessionId, reason } = normalizeSessionEndRequest(req.body);
    if (!isValidAppSessionId(expectedSessionId) || reason !== 'user_logout') {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    try {
      const allowed = await distributedLoginRateLimiter(
        `session_end_${hashRateLimitDimension(requestAuth.uid)}`,
        20,
        60 * 1000,
      );
      if (!allowed) return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    } catch (error) {
      log.error('App session end rate limit failed closed', error);
      return res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    }

    const db = admin.database();
    const lock = await acquireAppSessionLock({ db, authUid: requestAuth.uid, operation: 'end' });
    if (!lock.acquired) return res.status(409).json({ success: false, reason: 'SESSION_IN_PROGRESS' });
    try {
      const snapshot = await db.ref(`app_sessions/${requestAuth.uid}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          reason: 'ENDED',
          endedSessionId: expectedSessionId,
          alreadyEnded: true,
          endedAtMs: Date.now(),
        });
      }
      const session = snapshot.val();
      if (session.sessionId !== expectedSessionId) {
        return res.status(409).json({ success: false, reason: 'SESSION_CHANGED' });
      }
      const endedAtMs = Date.now();
      await cleanupAppSession({
        db,
        session,
        expectedSessionId,
        eventType: 'ended_by_user',
        reason: 'user_logout',
        actorType: session.principalType,
        nowMs: endedAtMs,
        createEventId: () => db.ref('app_session_events').push().key,
      });
      log.info('App session ended by user', {
        authUid: requestAuth.uid,
        principalType: session.principalType,
        tourId: session.tourId,
      });
      return res.status(200).json({
        success: true,
        reason: 'ENDED',
        endedSessionId: expectedSessionId,
        alreadyEnded: false,
        endedAtMs,
      });
    } catch (error) {
      const errorCode = /** @type {{ code?: string }} */ (error)?.code;
      log.error('App session end failed', error, { authUid: requestAuth.uid });
      return res.status(errorCode === 'SESSION_CHANGED' ? 409 : 500).json({
        success: false,
        reason: errorCode === 'SESSION_CHANGED' ? 'SESSION_CHANGED' : 'INTERNAL_ERROR',
      });
    } finally {
      await releaseAppSessionLock({ db, authUid: requestAuth.uid, owner: lock.owner });
    }
  },
);

const APP_SESSION_REVOCATION_REASONS = new Set([
  'lost_device',
  'security_review',
  'staff_request',
  'account_support',
]);

const revokeAppSession = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: false },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (!applyAuthenticatedCors(req, res)) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) return res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    const db = admin.database();
    if (!(await verifyOperationsAdminAccess({ authUid: String(requestAuth.uid), db }))) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }
    const targetAuthUid = resolveTrimmedString(req.body?.authUid);
    const expectedSessionId = resolveTrimmedString(req.body?.expectedSessionId);
    const reason = resolveTrimmedString(req.body?.reason);
    if (!isValidFirebaseKey(targetAuthUid) || !APP_SESSION_REVOCATION_REASONS.has(reason)
      || (expectedSessionId && !isValidAppSessionId(expectedSessionId))) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const lock = await acquireAppSessionLock({ db, authUid: targetAuthUid, operation: 'revoke' });
    if (!lock.acquired) return res.status(409).json({ success: false, reason: 'SESSION_IN_PROGRESS' });
    try {
      const snapshot = await db.ref(`app_sessions/${targetAuthUid}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({ success: true, reason: 'ENDED', alreadyEnded: true });
      }
      const session = snapshot.val();
      if (expectedSessionId && session.sessionId !== expectedSessionId) {
        return res.status(409).json({ success: false, reason: 'SESSION_CHANGED' });
      }
      const endedAtMs = Date.now();
      await cleanupAppSession({
        db,
        session,
        expectedSessionId: session.sessionId,
        eventType: 'ended_by_admin',
        reason,
        actorType: 'operations_admin',
        nowMs: endedAtMs,
        createEventId: () => db.ref('app_session_events').push().key,
      });
      log.info('App session revoked by operations', {
        authUid: targetAuthUid,
        adminUid: requestAuth.uid,
        principalType: session.principalType,
        reason,
      });
      return res.status(200).json({ success: true, reason: 'ENDED', alreadyEnded: false, endedAtMs });
    } catch (error) {
      log.error('Admin app session revocation failed', error, { authUid: targetAuthUid, reason });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await releaseAppSessionLock({ db, authUid: targetAuthUid, owner: lock.owner });
    }
  },
);

module.exports = { endAppSession, revokeAppSession };
