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
const { evaluateAudienceCandidate } = require('./notificationAudiencePage');
const { enumerateNotificationAudiencePage, mapWithBoundedConcurrency } = require('./notificationAudienceEnumerators');
const { createNotificationJobRecord, enqueueNotificationJob } = require('./notificationJobs');
const { buildDeliveryAttemptId, transitionDeliveryAttempt } = require('./notificationWorker');

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

/** @param {any} input @param {number} nowMs @param {string | null} senderAuthUid */
const buildPreviewJob = (input, nowMs, senderAuthUid = null) => {
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
    senderAuthUid: categoryKey ? null : senderAuthUid,
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
const calculateNotificationAudiencePreview = async ({ db = admin.database(), job, cursor: initialCursor = null, maxPages = 5 }) => {
  let cursor = initialCursor;
  let pages = 0;
  let audience = 0;
  let eligible = 0;
  const uidClaims = new Set();
  const tokenClaims = new Set();
  /** @type {Record<string, number>} */
  const skipReasons = {};
  do {
    const page = await enumerateNotificationAudiencePage({ db, job, cursor });
    pages += 1;
    cursor = page.nextCursor;
    const uniqueCandidates = page.candidates.filter((candidate) => {
      if (uidClaims.has(candidate.authUid)) return false;
      uidClaims.add(candidate.authUid);
      audience += 1;
      return true;
    });
    const outcomes = await mapWithBoundedConcurrency(
      uniqueCandidates, 10, (candidate) => evaluateAudienceCandidate({ db, job, candidate }),
    );
    outcomes.forEach((result) => {
      if (!result.eligible) {
        skipReasons[result.reason || 'invalid_token'] = Number(skipReasons[result.reason || 'invalid_token'] || 0) + 1;
      } else if (tokenClaims.has(result.tokenHash)) {
        skipReasons.duplicate_token = Number(skipReasons.duplicate_token || 0) + 1;
      } else {
        tokenClaims.add(result.tokenHash);
        eligible += 1;
      }
    });
  } while (cursor && pages < Math.max(1, Math.min(20, maxPages)));
  return {
    audience,
    eligible,
    skipped: audience - eligible,
    estimatedPages: pages,
    skipReasons,
    nextCursor: cursor,
    complete: !cursor,
  };
};

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_PAGE_LIMIT = 5;
const buildPreviewTargetKey = (job) => `${job.audienceType}:${job.tourId || job.categoryKey || ''}`;
const serializePreview = (previewId, state) => ({
  previewId,
  status: state.status,
  complete: state.status === 'complete',
  audience: Number(state.audience || 0),
  eligible: Number(state.eligible || 0),
  skipped: Number(state.skipped || 0),
  estimatedPages: Number(state.pages || 0),
  skipReasons: state.skipReasons || {},
  expiresAtMs: state.expiresAtMs,
});

/** @param {any} db @param {string} previewId @param {string} ownerAuthUid @param {number} nowMs */
const processAudiencePreviewChunk = async (db, previewId, ownerAuthUid, nowMs) => {
  const previewRef = db.ref(`notification_audience_previews/${previewId}`);
  const ownerId = randomUUID(); let acquired = false;
  const lease = await previewRef.transaction((state) => {
    if (!state || state.ownerAuthUid !== ownerAuthUid || Number(state.expiresAtMs || 0) <= nowMs) return;
    if (state.status === 'complete') return state;
    if (state.lease && Number(state.lease.expiresAtMs || 0) > nowMs) return state;
    acquired = true;
    return { ...state, lease: { ownerId, expiresAtMs: nowMs + 120_000 }, updatedAtMs: nowMs };
  });
  let state = lease?.snapshot?.val?.() || null;
  if (!state || state.ownerAuthUid !== ownerAuthUid) return null;
  if (state.status === 'complete' || !acquired) return serializePreview(previewId, state);
  let cursor = state.cursor || null;
  let pages = 0;
  const uidClaims = { ...(state.uidClaims || {}) };
  const tokenClaims = { ...(state.tokenClaims || {}) };
  const skipReasons = { ...(state.skipReasons || {}) };
  let audience = Number(state.audience || 0);
  let eligible = Number(state.eligible || 0);
  do {
    const page = await enumerateNotificationAudiencePage({ db, job: state.job, cursor });
    pages += 1;
    cursor = page.nextCursor;
    const unclaimed = page.candidates.filter((candidate) => {
      if (uidClaims[candidate.authUid]) return false;
      uidClaims[candidate.authUid] = true;
      audience += 1;
      return true;
    });
    const outcomes = await mapWithBoundedConcurrency(
      unclaimed, 10, (candidate) => evaluateAudienceCandidate({ db, job: state.job, candidate, nowMs }),
    );
    outcomes.forEach((result) => {
      if (!result.eligible) {
        const reason = result.reason || 'invalid_token';
        skipReasons[reason] = Number(skipReasons[reason] || 0) + 1;
      } else if (tokenClaims[result.tokenHash]) {
        skipReasons.duplicate_token = Number(skipReasons.duplicate_token || 0) + 1;
      } else {
        tokenClaims[result.tokenHash] = result.authUid;
        eligible += 1;
      }
    });
  } while (cursor && pages < PREVIEW_PAGE_LIMIT);
  const skipped = audience - eligible;
  await previewRef.transaction((current) => {
    if (!current || current.lease?.ownerId !== ownerId) return;
    return { ...current, cursor, pages: Number(current.pages || 0) + pages, audience, eligible, skipped, skipReasons, uidClaims, tokenClaims, status: cursor ? 'processing' : 'complete', lease: null, updatedAtMs: nowMs };
  });
  state = (await previewRef.once('value')).val();
  return state ? serializePreview(previewId, state) : null;
};

const previewNotificationAudience = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 120 },
// eslint-disable-next-line complexity -- owner and target binding are validated before each durable chunk
async (req, res) => {
  const authUid = await requireAdminRequest(req, res);
  if (!authUid) return;
  try {
    const db = admin.database();
    const nowMs = Date.now();
    let previewId = typeof req.body?.previewId === 'string' ? req.body.previewId.trim().slice(0, 100) : '';
    if (previewId && !isValidFirebaseKey(previewId)) throw new Error('Invalid preview id');
    if (!previewId) {
      const job = buildPreviewJob(req.body || {}, nowMs, authUid);
      previewId = `preview_v1_${randomUUID().replace(/-/gu, '')}`;
      await db.ref(`notification_audience_previews/${previewId}`).set({
        schemaVersion: 1, previewId, ownerAuthUid: authUid,
        targetKey: buildPreviewTargetKey(job), job, cursor: null,
        status: 'processing', audience: 0, eligible: 0, skipped: 0,
        pages: 0, skipReasons: {}, uidClaims: {}, tokenClaims: {},
        createdAtMs: nowMs, updatedAtMs: nowMs, expiresAtMs: nowMs + PREVIEW_TTL_MS,
      });
    } else {
      const existing = (await db.ref(`notification_audience_previews/${previewId}`).once('value')).val();
      if (!existing || existing.ownerAuthUid !== authUid || Number(existing.expiresAtMs || 0) <= nowMs) {
        if (existing && Number(existing.expiresAtMs || 0) <= nowMs) await db.ref().update({ [`notification_audience_previews/${previewId}`]: null });
        throw new Error('Preview not found');
      }
      if (req.body?.tourId || req.body?.categoryKey) {
        const requestedTarget = buildPreviewTargetKey(buildPreviewJob(req.body || {}, Number(existing.job?.createdAtMs || nowMs), authUid));
        if (requestedTarget !== existing.targetKey) throw new Error('Preview target mismatch');
      }
    }
    const preview = await processAudiencePreviewChunk(db, previewId, authUid, nowMs);
    if (!preview) throw new Error('Preview not found');
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

const REQUEUE_PAGE_SIZE = 100;
const REQUEUEABLE_STATUSES = new Set(['ticket_rejected', 'provider_rejected', 'partial', 'expired']);

const requeueRecipient = async ({ db, job, authUid, state, requeueId, nowMs }) => {
  if (state?.requeueId === requeueId) return state.requeueOutcome || 'skipped';
  const oldAttempt = state?.attemptId ? (await db.ref(`notification_delivery_attempts/${state.attemptId}`).once('value')).val() : null;
  if (!oldAttempt || ['provider_accepted', 'submission_unknown'].includes(oldAttempt.status)) return 'skipped';
  const device = (await db.ref(`notification_devices/${authUid}`).once('value')).val();
  const profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const recipient = await evaluateAudienceCandidate({ db, job, candidate: { authUid, device, profile, source: device ? 'device' : 'legacy_user' }, nowMs });
  if (!recipient.eligible) return 'skipped';
  await db.ref(`notification_job_token_claims/${job.jobId}/${oldAttempt.tokenHash}`).transaction((owner) => owner === authUid ? null : owner);
  const newClaim = await db.ref(`notification_job_token_claims/${job.jobId}/${recipient.tokenHash}`).transaction((owner) => owner || authUid);
  if (newClaim.snapshot.val() !== authUid) return 'skipped';
  const generation = Number(state.generation || oldAttempt.generation || 1) + 1;
  const attemptId = buildDeliveryAttemptId(job.jobId, authUid, generation);
  const existingNext = (await db.ref(`notification_delivery_attempts/${attemptId}`).once('value')).val();
  if (!existingNext) {
    await transitionDeliveryAttempt(db, state.attemptId, oldAttempt, { status: 'superseded', ticketStatus: 'superseded', receiptStatus: 'not_requested', retryable: false, supersededByAttemptId: attemptId, requeueId }, nowMs);
    await transitionDeliveryAttempt(db, attemptId, {}, {
      schemaVersion: 2, attemptId, generation, jobId: job.jobId, recipientUid: authUid,
      installationUid: authUid, tokenHash: recipient.tokenHash, status: 'retrying',
      ticketStatus: 'pending', receiptStatus: 'not_requested', retryable: true,
      attemptNumber: 0, createdAtMs: nowMs, updatedAtMs: nowMs, requeueId,
      availableAtMs: nowMs, expiresAtMs: Number(job.expiresAtMs), safeErrorCode: null,
      queueKind: null, queueKey: null, queueVersion: 0,
    }, nowMs);
  }
  await db.ref(`notification_job_recipients/${job.jobId}/${authUid}`).update({ generation, attemptId, tokenHash: recipient.tokenHash, status: 'requeued', requeueId, requeueOutcome: 'requeued', updatedAtMs: nowMs });
  return 'requeued';
};

/** @param {{ db?: any, jobId: string, nowMs?: number }} options */
// eslint-disable-next-line complexity -- bounded durable requeue owns initialization, lease and cursor progression
const requeueFailedNotificationJob = async ({ db = admin.database(), jobId, nowMs = Date.now() }) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  let job = (await jobRef.once('value')).val();
  if (!job || Number(job.expiresAtMs || 0) <= nowMs) return { success: false, reason: 'JOB_NOT_REQUEUEABLE' };
  const stateRef = db.ref(`notification_requeue_jobs/${jobId}`);
  let state = (await stateRef.once('value')).val();
  const sourceCompletedAtMs = Number(job.completedAtMs || job.updatedAtMs || 0);
  if (REQUEUEABLE_STATUSES.has(job.status)) {
    if (!state || state.status === 'complete' || Number(state.sourceCompletedAtMs) !== sourceCompletedAtMs) {
      const requeueId = `requeue_v1_${randomUUID().replace(/-/gu, '')}`;
      await stateRef.transaction((current) => current && current.status === 'processing' && Number(current.sourceCompletedAtMs) === sourceCompletedAtMs
        ? current
        : { schemaVersion: 1, requeueId, jobId, sourceStatus: job.status, sourceCompletedAtMs, cursor: null, status: 'processing', requeued: 0, skipped: 0, createdAtMs: nowMs, updatedAtMs: nowMs, expiresAtMs: nowMs + (60 * 60 * 1000) });
      state = (await stateRef.once('value')).val();
    }
    await jobRef.transaction((current) => current && REQUEUEABLE_STATUSES.has(current.status)
      ? { ...current, status: 'retrying', lease: null, updatedAtMs: nowMs, lastErrorCode: null }
      : current);
    job = (await jobRef.once('value')).val();
  }
  if (!state || state.status !== 'processing' || job?.status !== 'retrying') {
    if (state?.status === 'complete') return { success: true, complete: true, requeueId: state.requeueId, requeued: state.requeued, skipped: state.skipped, job };
    return { success: false, reason: 'JOB_NOT_REQUEUEABLE' };
  }
  const leaseOwner = randomUUID(); let acquired = false;
  const lease = await stateRef.transaction((current) => {
    if (!current || current.status !== 'processing') return current;
    if (current.lease && Number(current.lease.expiresAtMs || 0) > nowMs) return current;
    acquired = true;
    return { ...current, lease: { ownerId: leaseOwner, expiresAtMs: nowMs + 120_000 }, updatedAtMs: nowMs };
  });
  state = lease?.snapshot?.val?.() || state;
  if (!acquired) return { success: true, complete: false, status: 'processing', requeueId: state.requeueId, requeued: state.requeued, skipped: state.skipped };
  let query = db.ref(`notification_job_recipients/${jobId}`).orderByKey();
  if (state.cursor) query = query.startAfter(state.cursor);
  const records = Object.entries((await query.limitToFirst(REQUEUE_PAGE_SIZE + 1).once('value')).val() || {}).sort(([left], [right]) => left.localeCompare(right));
  const selected = records.slice(0, REQUEUE_PAGE_SIZE);
  let requeued = 0; let skipped = 0;
  for (const [authUid, recipientState] of selected) {
    const outcome = await requeueRecipient({ db, job, authUid, state: recipientState, requeueId: state.requeueId, nowMs });
    if (outcome === 'requeued') requeued += 1; else skipped += 1;
  }
  const complete = records.length <= REQUEUE_PAGE_SIZE;
  const cursor = complete || !selected.length ? null : selected[selected.length - 1][0];
  await stateRef.transaction((current) => current?.lease?.ownerId === leaseOwner
    ? { ...current, cursor, status: complete ? 'complete' : 'processing', requeued: Number(current.requeued || 0) + requeued, skipped: Number(current.skipped || 0) + skipped, lease: null, updatedAtMs: nowMs }
    : current);
  state = (await stateRef.once('value')).val();
  if (complete && Number(state.requeued || 0) === 0) {
    const terminalStatus = REQUEUEABLE_STATUSES.has(state.sourceStatus) ? state.sourceStatus : 'provider_rejected';
    await jobRef.update({ status: terminalStatus, completedAtMs: Number(job.completedAtMs || nowMs), updatedAtMs: nowMs });
  }
  return { success: true, complete, status: state.status, requeueId: state.requeueId, requeued: state.requeued, skipped: state.skipped, job: (await jobRef.once('value')).val() };
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
  processAudiencePreviewChunk,
  createServerTestNotification,
  previewNotificationAudience,
  requeueFailedNotificationJob,
  requeueNotificationJob,
};
