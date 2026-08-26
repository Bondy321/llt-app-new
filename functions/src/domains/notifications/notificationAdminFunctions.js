'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { verifyOperationsAdminAccess } = require('../administration/public');
const { buildPushNavigationData } = require('./pushNavigationData');
const { NOTIFICATION_TYPES } = require('./notificationDeliveryPolicy');
const { evaluateAudienceCandidate, loadNotificationAudiencePage } = require('./notificationAudiencePage');
const { createNotificationJobRecord, enqueueNotificationJob } = require('./notificationJobs');

/** @param {any} req @param {any} res */
const requireAdminRequest = async (req, res) => {
  if (!applyAuthenticatedCors(req, res)) {
    res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    return null;
  }
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return null;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    return null;
  }
  const auth = await verifyRequestAuthUid(req);
  if (!auth.success || !(await verifyOperationsAdminAccess({ authUid: auth.uid }))) {
    res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    return null;
  }
  return auth.uid;
};

/** @param {any} input @param {number} nowMs */
const buildPreviewJob = (input, nowMs) => {
  const categoryKey = typeof input?.categoryKey === 'string' ? input.categoryKey.trim().slice(0, 80) : null;
  const tourId = typeof input?.tourId === 'string' ? input.tourId.trim().slice(0, 160) : null;
  const notificationType = categoryKey
    ? NOTIFICATION_TYPES.FUTURE_TOUR_BROADCAST
    : NOTIFICATION_TYPES.TOUR_ANNOUNCEMENT;
  return createNotificationJobRecord({
    notificationType,
    sourceType: 'admin_preview',
    sourceId: `${categoryKey || tourId || 'invalid'}:${nowMs}`,
    audienceType: categoryKey ? 'marketing' : 'tour',
    categoryKey,
    tourId,
    presentation: { title: 'Preview', body: 'Preview' },
    navigation: buildPushNavigationData(categoryKey ? {
      screen: 'MarketingNotificationDetail',
      notificationType,
      categoryKey,
      broadcastId: 'preview',
      expiresAtMs: nowMs + 60_000,
      timestamp: nowMs,
    } : {
      screen: 'Chat', tourId, messageId: 'preview', notificationType, timestamp: nowMs, expiresAtMs: nowMs + 60_000,
    }),
    nowMs,
    expiresAtMs: nowMs + 60_000,
  });
};

/** @param {{ db?: any, job: any }} options */
const calculateNotificationAudiencePreview = async ({ db = admin.database(), job }) => {
  let cursor = null;
  let pages = 0;
  let audience = 0;
  let eligible = 0;
  /** @type {Record<string, number>} */
  const skipReasons = {};
  do {
    const page = await loadNotificationAudiencePage(db, cursor);
    pages += 1;
    cursor = page.nextCursor;
    audience += page.candidates.length;
    const outcomes = await Promise.all(page.candidates.map((candidate) => evaluateAudienceCandidate({ db, job, candidate })));
    outcomes.forEach((result) => {
      if (result.eligible) eligible += 1;
      else skipReasons[result.reason || 'invalid_token'] = Number(skipReasons[result.reason || 'invalid_token'] || 0) + 1;
    });
  } while (cursor);
  return {
    audience,
    eligible,
    skipped: audience - eligible,
    estimatedPages: pages,
    skipReasons,
  };
};

const previewNotificationAudience = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 120 }, async (req, res) => {
  const authUid = await requireAdminRequest(req, res);
  if (!authUid) return;
  try {
    const job = buildPreviewJob(req.body || {}, Date.now());
    const preview = await calculateNotificationAudiencePreview({ job });
    res.status(200).json({ success: true, preview });
  } catch (_error) {
    res.status(400).json({ success: false, reason: 'INVALID_PREVIEW_REQUEST' });
  }
});

const createServerTestNotification = onRequest({ region: 'europe-west1', maxInstances: 5 }, async (req, res) => {
  const authUid = await requireAdminRequest(req, res);
  if (!authUid) return;
  const nowMs = Date.now();
  const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim()
    ? req.body.requestId.trim().slice(0, 160)
    : randomUUID();
  const job = createNotificationJobRecord({
    notificationType: NOTIFICATION_TYPES.SERVER_TEST,
    sourceType: 'admin_server_test',
    sourceId: `${authUid}:${requestId}`,
    audienceType: 'single_installation',
    targetInstallationUid: authUid,
    presentation: { title: 'LLT server notification test', body: 'This test used the complete server, Expo ticket and receipt pipeline.' },
    navigation: buildPushNavigationData({
      screen: 'NotificationPreferences',
      notificationType: NOTIFICATION_TYPES.SERVER_TEST,
      timestamp: nowMs,
      expiresAtMs: nowMs + (60 * 60 * 1000),
    }),
    nowMs,
  });
  const result = await enqueueNotificationJob({ job });
  res.status(202).json({ success: true, jobId: result.jobId, status: result.job.status });
});

/** @param {{ db?: any, jobId: string, nowMs?: number }} options */
const requeueFailedNotificationJob = async ({ db = admin.database(), jobId, nowMs = Date.now() }) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  let allowed = false;
  const transaction = await jobRef.transaction((job) => {
    if (!job || !['ticket_rejected', 'provider_rejected', 'partial', 'expired'].includes(job.status)) return;
    if (Number(job.expiresAtMs || 0) <= nowMs) return;
    allowed = true;
    return { ...job, status: 'retrying', availableAtMs: nowMs, lease: null, updatedAtMs: nowMs, lastErrorCode: null };
  });
  if (!allowed) return { success: false, reason: 'JOB_NOT_REQUEUEABLE' };
  const attemptsSnapshot = await db.ref('notification_delivery_attempts').orderByChild('jobId').equalTo(jobId).once('value');
  /** @type {Record<string, any>} */
  const updates = {};
  Object.entries(attemptsSnapshot.val() || {}).forEach(([attemptId, attempt]) => {
    if (attempt?.status === 'provider_accepted') return;
    updates[`notification_delivery_attempts/${attemptId}/status`] = 'retrying';
    updates[`notification_delivery_attempts/${attemptId}/retryable`] = true;
    updates[`notification_delivery_attempts/${attemptId}/availableAtMs`] = nowMs;
    updates[`notification_delivery_attempts/${attemptId}/updatedAtMs`] = nowMs;
  });
  if (Object.keys(updates).length) await db.ref().update(updates);
  return { success: true, job: transaction.snapshot.val() };
};

const requeueNotificationJob = onRequest({ region: 'europe-west1', maxInstances: 5 }, async (req, res) => {
  const authUid = await requireAdminRequest(req, res);
  if (!authUid) return;
  const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId.trim().slice(0, 80) : '';
  const result = await requeueFailedNotificationJob({ jobId });
  res.status(result.success ? 200 : 409).json(result);
});

module.exports = {
  buildPreviewJob,
  calculateNotificationAudiencePreview,
  createServerTestNotification,
  previewNotificationAudience,
  requeueFailedNotificationJob,
  requeueNotificationJob,
};
