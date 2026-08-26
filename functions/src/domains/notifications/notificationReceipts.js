'use strict';

// @ts-check

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { expoAccessTokenSecret, getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { calculateRetryDelayMs } = require('./notificationJobs');
const { evaluateAudienceCandidate, hashPushToken } = require('./notificationAudiencePage');
const { QUEUE_ROOTS, claimQueueEntry, loadDueQueueEntries } = require('./notificationQueues');
const { markSubmissionUnknown, retryNotificationDeliveryAttempt, transitionDeliveryAttempt } = require('./notificationWorker');
const { syncNotificationSourceStatus } = require('./notificationSourceStatus');

const RECEIPT_BATCH_LIMIT = 1000;
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_SENDING_ATTEMPT_MS = 2 * 60 * 1000;
const TEMPORARY_RECEIPT_ERRORS = new Set(['MessageRateExceeded']);
const CONFIGURATION_RECEIPT_ERRORS = new Set(['MismatchSenderId', 'InvalidCredentials']);

/** @param {any} db @param {any} attempt @param {string} reason @param {number} nowMs */
const compareAndClearTokenByHash = async (db, attempt, reason, nowMs) => {
  const uid = attempt.installationUid || attempt.recipientUid;
  if (!uid) return false;
  let cleared = false;
  await db.ref(`notification_devices/${uid}`).transaction((device) => {
    if (!device || device.tokenHash !== attempt.tokenHash) return device;
    cleared = true;
    return { ...device, pushToken: null, status: 'invalid', invalidReason: reason, updatedAtMs: nowMs };
  });
  await db.ref(`users/${uid}`).transaction((profile) => {
    const token = String(profile?.pushToken || '').trim();
    if (!token || hashPushToken(token) !== attempt.tokenHash) return profile;
    cleared = true;
    return { ...profile, pushToken: null, pushTokenStatus: 'INVALID', pushTokenInvalidReason: reason, pushTokenUpdatedAt: new Date(nowMs).toISOString() };
  });
  return cleared;
};

// eslint-disable-next-line complexity -- explicit precedence is the notification state machine
const resolveJobStatus = (job) => {
  const counts = job.counts || {};
  if (!job.fanoutCompletedAtMs && ['queued', 'fanout_in_progress'].includes(job.status)) return job.status;
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  if (Number(counts.receiptAccepted || 0) > 0 && Number(counts.receiptRejected || 0) === 0 && Number(counts.ticketRejected || 0) === 0 && Number(counts.submissionUnknown || 0) === 0) return 'provider_accepted';
  if (Number(counts.receiptAccepted || 0) > 0 || Number(counts.submissionUnknown || 0) > 0) return 'partial';
  if (Number(counts.ticketRejected || 0) > 0 || Number(counts.receiptRejected || 0) > 0) return 'provider_rejected';
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

/** Current-state status refresh is O(1): transition helpers maintain job counters. */
const refreshNotificationJobStatus = async (db, jobId, nowMs) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  let updated = null;
  await jobRef.transaction((job) => {
    if (!job) return job;
    const status = resolveJobStatus(job);
    updated = { ...job, status, updatedAtMs: nowMs, ...(['provider_accepted', 'provider_rejected', 'partial', 'expired', 'no_recipients'].includes(status) ? { completedAtMs: Number(job.completedAtMs || nowMs) } : {}) };
    return updated;
  });
  if (!updated) return null;
  await syncNotificationSourceStatus(db, updated, nowMs);
  if (updated.priorityClass === 'critical' && ['provider_rejected', 'partial'].includes(updated.status)) {
    await db.ref(`notification_delivery_warnings/${jobId}`).update({ jobId, tourId: updated.tourId || null, eventId: updated.eventId || null, severity: 'critical', code: updated.status.toUpperCase(), status: 'open', updatedAtMs: nowMs });
  }
  return { status: updated.status, counts: updated.counts || {}, job: updated };
};

const rescheduleReceipt = async (db, attemptId, attempt, nowMs, errorCode = null) => {
  const checks = Number(attempt.receiptCheckCount || 0) + 1;
  if (Number(attempt.receiptWindowExpiresAtMs || 0) <= nowMs) {
    await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'provider_rejected', receiptStatus: 'provider_rejected', retryable: false, receiptDueAtMs: null, safeErrorCode: 'RECEIPT_EXPIRED' }, nowMs);
    return 'rejected';
  }
  await transitionDeliveryAttempt(db, attemptId, attempt, { receiptDueAtMs: nowMs + calculateRetryDelayMs(checks), receiptCheckCount: checks, safeErrorCode: errorCode }, nowMs);
  return 'missing';
};

const processReceipt = async (db, attemptId, attempt, receipt, nowMs) => {
  if (!receipt) return rescheduleReceipt(db, attemptId, attempt, nowMs);
  if (receipt.status === 'ok') {
    await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'provider_accepted', receiptStatus: 'provider_accepted', retryable: false, providerAcceptedAtMs: nowMs, receiptDueAtMs: null, safeErrorCode: null }, nowMs);
    return 'accepted';
  }
  const code = String(receipt?.details?.error || 'PROVIDER_REJECTED').slice(0, 80);
  const retryable = TEMPORARY_RECEIPT_ERRORS.has(code) && Number(attempt.receiptWindowExpiresAtMs || 0) > nowMs;
  await transitionDeliveryAttempt(db, attemptId, attempt, { status: retryable ? 'retrying' : 'provider_rejected', receiptStatus: 'provider_rejected', retryable, availableAtMs: retryable ? nowMs + calculateRetryDelayMs(Number(attempt.attemptNumber || 1)) : nowMs, receiptDueAtMs: null, safeErrorCode: code }, nowMs);
  if (code === 'DeviceNotRegistered') await compareAndClearTokenByHash(db, attempt, code, nowMs);
  if (CONFIGURATION_RECEIPT_ERRORS.has(code)) await db.ref(`notification_delivery_warnings/${attempt.jobId}`).update({ jobId: attempt.jobId, severity: 'critical', code, status: 'open', updatedAtMs: nowMs });
  return 'rejected';
};

/** @param {{ db?: any, nowMs?: number, expo?: any }} options */
// eslint-disable-next-line complexity -- queue validation and receipt outcomes are a single bounded batch
const processDueNotificationReceipts = async ({ db = admin.database(), nowMs = Date.now(), expo = getExpoPushClient() } = {}) => {
  const queue = await loadDueQueueEntries(db, 'receipt', nowMs, RECEIPT_BATCH_LIMIT);
  const due = [];
  for (const [queueKey, entry] of queue) {
    const claimed = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.receipt}/${queueKey}`), nowMs);
    if (!claimed.claimed) continue;
    const attempt = (await db.ref(`notification_delivery_attempts/${entry.targetId}`).once('value')).val();
    if (!attempt || attempt.queueKey !== queueKey || Number(attempt.queueVersion) !== Number(entry.version) || attempt.receiptStatus !== 'receipt_pending' || typeof attempt.ticketId !== 'string') {
      await db.ref().update({ [`${QUEUE_ROOTS.receipt}/${queueKey}`]: null });
      continue;
    }
    due.push([entry.targetId, attempt]);
  }
  if (!due.length) return { checked: 0, accepted: 0, rejected: 0, missing: 0, requestFailed: 0 };
  let receiptMap;
  try { receiptMap = await expo.getPushNotificationReceiptsAsync(due.map(([, attempt]) => attempt.ticketId)); } catch (_error) {
    const jobs = new Set();
    for (const [attemptId, attempt] of due) { jobs.add(attempt.jobId); await rescheduleReceipt(db, attemptId, attempt, nowMs, 'RECEIPT_REQUEST_FAILED'); }
    for (const jobId of jobs) await refreshNotificationJobStatus(db, jobId, nowMs);
    return { checked: due.length, accepted: 0, rejected: 0, missing: 0, requestFailed: due.length };
  }
  const touchedJobs = new Set(); const counts = { accepted: 0, rejected: 0, missing: 0 };
  for (const [attemptId, attempt] of due) { touchedJobs.add(attempt.jobId); counts[await processReceipt(db, attemptId, attempt, receiptMap?.[attempt.ticketId], nowMs)] += 1; }
  for (const jobId of touchedJobs) await refreshNotificationJobStatus(db, jobId, nowMs);
  return { checked: due.length, ...counts, requestFailed: 0 };
};

const isRetryAttemptExpired = (job, nowMs) => !job || Number(job.expiresAtMs || 0) <= nowMs || job.supersededByJobId;

/** @param {{ db?: any, nowMs?: number, expo?: any }} options */
// eslint-disable-next-line complexity -- retry ownership is intentionally fail-closed at every authority boundary
const retryDueNotificationAttempts = async ({ db = admin.database(), nowMs = Date.now(), expo = getExpoPushClient() } = {}) => {
  const queue = await loadDueQueueEntries(db, 'retry', nowMs, 100);
  let retried = 0; let scanned = 0;
  for (const [queueKey, entry] of queue) {
    const claimedQueue = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.retry}/${queueKey}`), nowMs);
    if (!claimedQueue.claimed) continue;
    const attemptId = entry.targetId;
    const attempt = (await db.ref(`notification_delivery_attempts/${attemptId}`).once('value')).val();
    if (!attempt || attempt.queueKey !== queueKey || Number(attempt.queueVersion) !== Number(entry.version)) { await db.ref().update({ [`${QUEUE_ROOTS.retry}/${queueKey}`]: null }); continue; }
    scanned += 1;
    const job = (await db.ref(`notification_jobs/${attempt.jobId}`).once('value')).val();
    if (attempt.status === 'request_started') {
      await markSubmissionUnknown(db, job || { jobId: attempt.jobId, priorityClass: 'standard' }, { attemptRef: db.ref(`notification_delivery_attempts/${attemptId}`), attemptId, attempt }, nowMs, new Error('Stale submission lease'));
      await refreshNotificationJobStatus(db, attempt.jobId, nowMs);
      continue;
    }
    if (attempt.status === 'prepared') {
      await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'retrying', retryable: true, availableAtMs: nowMs, submissionLease: null, safeErrorCode: 'PRE_REQUEST_RECOVERY' }, nowMs);
      Object.assign(attempt, (await db.ref(`notification_delivery_attempts/${attemptId}`).once('value')).val() || {});
    }
    if (attempt.status !== 'retrying') continue;
    if (isRetryAttemptExpired(job, nowMs) || Number(attempt.attemptNumber || 0) >= Number(job?.maxAttempts || 8)) {
      await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'provider_rejected', receiptStatus: 'provider_rejected', retryable: false, safeErrorCode: isRetryAttemptExpired(job, nowMs) ? 'JOB_EXPIRED' : 'MAX_ATTEMPTS_REACHED' }, nowMs);
      if (job?.priorityClass === 'critical') await db.ref(`notification_delivery_warnings/${attempt.jobId}`).update({ jobId: attempt.jobId, severity: 'critical', code: isRetryAttemptExpired(job, nowMs) ? 'JOB_EXPIRED' : 'MAX_ATTEMPTS_REACHED', status: 'open', updatedAtMs: nowMs });
      await refreshNotificationJobStatus(db, attempt.jobId, nowMs);
      continue;
    }
    const device = (await db.ref(`notification_devices/${attempt.installationUid}`).once('value')).val();
    const profile = (await db.ref(`users/${attempt.recipientUid}`).once('value')).val() || {};
    const recipient = await evaluateAudienceCandidate({ db, job, candidate: { authUid: attempt.recipientUid, device, profile, source: device ? 'device' : 'legacy_user' }, nowMs });
    if (!recipient.eligible || recipient.tokenHash !== attempt.tokenHash) {
      await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'provider_rejected', retryable: false, safeErrorCode: 'RECIPIENT_CHANGED' }, nowMs);
      await refreshNotificationJobStatus(db, attempt.jobId, nowMs);
      continue;
    }
    const retry = await retryNotificationDeliveryAttempt({ db, job, attemptId, attempt, recipient, nowMs, expo });
    if (retry.success) retried += 1;
    await refreshNotificationJobStatus(db, attempt.jobId, nowMs);
  }
  return { scanned, retried };
};

const queueExpiredBroadcastDeletion = (updates, job) => {
  const navigation = job?.navigation || {};
  if (job?.sourceType === 'tour_announcement' && isValidFirebaseKey(job.tourId) && isValidFirebaseKey(navigation.messageId)) updates[`broadcasts/${job.tourId}/${navigation.messageId}`] = null;
  if (job?.sourceType === 'future_tour_category_broadcast' && isValidFirebaseKey(job.categoryKey) && isValidFirebaseKey(navigation.broadcastId)) updates[`category_broadcasts/${job.categoryKey}/${navigation.broadcastId}`] = null;
};

const cleanupOldNotificationDeliveryData = async ({ db = admin.database(), nowMs = Date.now() } = {}) => {
  const cutoff = nowMs - RETENTION_MS; const updates = {};
  const oldJobs = (await db.ref('notification_jobs').orderByChild('updatedAtMs').endAt(cutoff).limitToFirst(100).once('value')).val() || {};
  for (const [jobId, job] of Object.entries(oldJobs)) {
    updates[`notification_jobs/${jobId}`] = null; updates[`notification_job_token_claims/${jobId}`] = null; updates[`notification_job_recipients/${jobId}`] = null; updates[`notification_delivery_warnings/${jobId}`] = null;
    if (job.queueKey && job.queueKind && QUEUE_ROOTS[job.queueKind]) updates[`${QUEUE_ROOTS[job.queueKind]}/${job.queueKey}`] = null;
    queueExpiredBroadcastDeletion(updates, job);
  }
  for (const root of ['notification_delivery_attempts', 'marketing_notification_details']) {
    const records = (await db.ref(root).orderByChild('updatedAtMs').endAt(cutoff).limitToFirst(100).once('value')).val() || {};
    Object.entries(records).forEach(([key, value]) => { updates[`${root}/${key}`] = null; if (value?.queueKey && value?.queueKind && QUEUE_ROOTS[value.queueKind]) updates[`${QUEUE_ROOTS[value.queueKind]}/${value.queueKey}`] = null; });
  }
  const expiredPreviews = (await db.ref('notification_audience_previews').orderByChild('expiresAtMs').endAt(nowMs).limitToFirst(100).once('value')).val() || {};
  Object.keys(expiredPreviews).forEach((previewId) => { updates[`notification_audience_previews/${previewId}`] = null; });
  const expiredRequeues = (await db.ref('notification_requeue_jobs').orderByChild('expiresAtMs').endAt(nowMs).limitToFirst(100).once('value')).val() || {};
  Object.keys(expiredRequeues).forEach((requeueId) => { updates[`notification_requeue_jobs/${requeueId}`] = null; });
  await db.ref().update(updates); return { deleted: Object.keys(updates).length };
};

const processNotificationReceipts = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Europe/London', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 1 }, async () => ({ receipts: await processDueNotificationReceipts(), retries: await retryDueNotificationAttempts() }));
const cleanupNotificationDeliveryData = onSchedule({ schedule: 'every 24 hours', timeZone: 'Europe/London', region: 'europe-west1', maxInstances: 1 }, async () => cleanupOldNotificationDeliveryData());

module.exports = { RECEIPT_BATCH_LIMIT, RECEIPT_WINDOW_MS, RETENTION_MS, STALE_SENDING_ATTEMPT_MS, cleanupNotificationDeliveryData, cleanupOldNotificationDeliveryData, compareAndClearTokenByHash, processDueNotificationReceipts, processNotificationReceipts, refreshNotificationJobStatus, retryDueNotificationAttempts };
