'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { log } = require('../../infrastructure/logging/safeLogger');
const { resolveTrimmedString } = require('../notifications/notificationPolicy');
const { checkSafetySubmissionRateLimit } = require('./safetyRateLimit');
const {
  buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates,
  normalizeSafetySubmissionInput,
} = require('./safetySubmission');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

const SAFETY_SUBMISSION_LOCK_TTL_MS = 30 * 1000;

const onRequestWithResult = /** @type {any} */ (onRequest);

/** @type {(...args: any[]) => Promise<any>} */
const resolveExistingSafetySubmission = async ({ db, input, authUid, includeReceivedAt = false }) => {
  const snapshot = await db.ref(`tours/${input.tourId}/safetyAlerts/${input.clientEventId}`).once('value');
  if (!snapshot.exists()) return { handled: false };
  const existing = snapshot.val() || {};
  if (resolveTrimmedString(existing.reporterAuthUid || existing.userId) !== authUid) {
    return { handled: true, status: 409, body: { success: false, reason: 'EVENT_ID_CONFLICT' } };
  }
  return {
    handled: true,
    status: 200,
    body: {
      success: true,
      eventId: input.clientEventId,
      alreadySubmitted: true,
      ...(includeReceivedAt
        ? { receivedAtMs: Number(existing.receivedAtMs || existing.timestampMs) || null }
        : {}),
    },
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const acquireSafetySubmissionLock = async ({ db, input, authUid, lockPath, lockOwner }) => {
  const acquired = await acquireManualBookingLock({
    db,
    path: lockPath,
    owner: lockOwner,
    nowMs: Date.now(),
    ttlMs: SAFETY_SUBMISSION_LOCK_TTL_MS,
  });
  if (acquired) return { acquired: true };
  const retry = await resolveExistingSafetySubmission({ db, input, authUid });
  if (retry.handled) return { acquired: false, response: retry };
  return {
    acquired: false,
    response: { status: 409, body: { success: false, reason: 'SUBMISSION_IN_PROGRESS' } },
  };
};

const submitSafetyReport = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 20,
    timeoutSeconds: 30,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }
    try {
      const allowed = await checkSafetySubmissionRateLimit({ authUid: requestAuth.uid });
      if (!allowed) {
        return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
      }
    } catch (error) {
      log.error('Safety rate-limit check failed closed', error, { authUid: requestAuth.uid });
      return res.status(503).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    let input;
    try {
      input = normalizeSafetySubmissionInput(req.body, Date.now());
    } catch (error) {
      const errorCode = /** @type {{ code?: string }} */ (error)?.code;
      return res.status(400).json({ success: false, reason: errorCode || 'INVALID_INPUT' });
    }

    const db = admin.database();
    const lockPath = `safety_submission_locks/${input.tourId}/${input.clientEventId}`;
    const lockOwner = randomUUID();
    let lockAcquired = false;
    try {
      const access = await verifyActiveAppSession({
        db,
        authUid: requestAuth.uid,
        expectedTourId: input.tourId,
        expectedRole: input.role,
      });
      if (!access.allowed) {
        return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
      }

      const existing = await resolveExistingSafetySubmission({
        db, input, authUid: requestAuth.uid, includeReceivedAt: true,
      });
      if (existing.handled) return res.status(existing.status).json(existing.body);

      const lock = await acquireSafetySubmissionLock({
        db, input, authUid: requestAuth.uid, lockPath, lockOwner,
      });
      lockAcquired = lock.acquired;
      if (!lockAcquired) return res.status(lock.response.status).json(lock.response.body);

      const lockedExisting = await resolveExistingSafetySubmission({ db, input, authUid: requestAuth.uid });
      if (lockedExisting.handled) return res.status(lockedExisting.status).json(lockedExisting.body);

      const nowMs = Date.now();
      const record = buildCanonicalSafetyRecord({
        input,
        authUid: requestAuth.uid,
        principalId: access.principalId,
        nowMs,
      });
      await db.ref().update(buildSafetySubmissionUpdates({ record, lockPath }));
      lockAcquired = false;
      log.warn('Safety report submitted', {
        authUid: requestAuth.uid,
        tourId: input.tourId,
        eventId: input.clientEventId,
        category: input.category,
        severity: input.severity,
        isSOS: input.isSOS,
        processedFromQueue: input.processedFromQueue,
      });
      return res.status(201).json({
        success: true,
        eventId: input.clientEventId,
        alreadySubmitted: false,
        receivedAtMs: nowMs,
      });
    } catch (error) {
      log.error('Safety report submission failed', error, {
        authUid: requestAuth.uid,
        tourId: input.tourId,
        eventId: input.clientEventId,
      });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      if (lockAcquired) {
        await releaseManualBookingLock({ db, path: lockPath, owner: lockOwner });
      }
    }
  },
);

module.exports = { submitSafetyReport };
