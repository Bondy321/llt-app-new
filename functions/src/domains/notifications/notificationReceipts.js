'use strict';

// @ts-check

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  expoAccessTokenSecret,
  getExpoPushClient,
} = require('../../infrastructure/notifications/expoPushClient');
const { calculateRetryDelayMs } = require('./notificationJobs');
const { evaluateAudienceCandidate, hashPushToken } = require('./notificationAudiencePage');
const { retryNotificationDeliveryAttempt } = require('./notificationWorker');
const { syncNotificationSourceStatus } = require('./notificationSourceStatus');

const RECEIPT_BATCH_LIMIT = 1000;
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_SENDING_ATTEMPT_MS = 2 * 60 * 1000;
const TEMPORARY_RECEIPT_ERRORS = new Set(['MessageRateExceeded']);
const CONFIGURATION_RECEIPT_ERRORS = new Set(['MismatchSenderId', 'InvalidCredentials']);

const rescheduleReceiptRequestFailure = async (db, due, nowMs) => {
  await Promise.all(due.map(async ([attemptId, attempt]) => {
    const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
    const expired = Number(attempt.receiptWindowExpiresAtMs || 0) <= nowMs;
    const checks = Number(attempt.receiptCheckCount || 0) + 1;
    await attemptRef.update(expired ? {
      status: 'provider_rejected', receiptStatus: 'provider_rejected', retryable: false,
      receiptDueAtMs: null, safeErrorCode: 'RECEIPT_EXPIRED', updatedAtMs: nowMs,
    } : {
      receiptDueAtMs: nowMs + calculateRetryDelayMs(checks), receiptCheckCount: checks,
      safeErrorCode: 'RECEIPT_REQUEST_FAILED', updatedAtMs: nowMs,
    });
  }));
  return { checked: due.length, accepted: 0, rejected: 0, missing: 0, requestFailed: due.length };
};
const updateMissingReceipt = async (attemptRef, attempt, nowMs) => {
  const expired = Number(attempt.receiptWindowExpiresAtMs || 0) <= nowMs;
  await attemptRef.update(expired ? { status: 'provider_rejected', receiptStatus: 'provider_rejected', retryable: false, safeErrorCode: 'RECEIPT_EXPIRED', updatedAtMs: nowMs } : { receiptDueAtMs: nowMs + calculateRetryDelayMs(Number(attempt.receiptCheckCount || 0) + 1), receiptCheckCount: Number(attempt.receiptCheckCount || 0) + 1, updatedAtMs: nowMs });
  return expired ? 'rejected' : 'missing';
};
const updateAcceptedReceipt = (attemptRef, nowMs) => attemptRef.update({ status: 'provider_accepted', receiptStatus: 'provider_accepted', retryable: false, providerAcceptedAtMs: nowMs, receiptDueAtMs: null, safeErrorCode: null, updatedAtMs: nowMs });
const updateRejectedReceipt = async (db, attemptRef, attempt, receipt, nowMs) => {
  const code = String(receipt?.details?.error || 'PROVIDER_REJECTED').slice(0, 80);
  const retryable = TEMPORARY_RECEIPT_ERRORS.has(code) && Number(attempt.receiptWindowExpiresAtMs || 0) > nowMs;
  await attemptRef.update({ status: retryable ? 'retrying' : 'provider_rejected', receiptStatus: 'provider_rejected', retryable, availableAtMs: retryable ? nowMs + calculateRetryDelayMs(Number(attempt.attemptNumber || 1)) : nowMs, receiptDueAtMs: null, safeErrorCode: code, updatedAtMs: nowMs });
  if (code === 'DeviceNotRegistered') await compareAndClearTokenByHash(db, attempt, code, nowMs);
  if (CONFIGURATION_RECEIPT_ERRORS.has(code)) await db.ref(`notification_delivery_warnings/${attempt.jobId}`).update({ jobId: attempt.jobId, severity: 'critical', code, status: 'open', updatedAtMs: nowMs });
  return 'rejected';
};
const processReceipt = async (db, attemptId, attempt, receipt, nowMs) => {
  const ref = db.ref(`notification_delivery_attempts/${attemptId}`);
  if (!receipt) return updateMissingReceipt(ref, attempt, nowMs);
  if (receipt.status === 'ok') { await updateAcceptedReceipt(ref, nowMs); return 'accepted'; }
  return updateRejectedReceipt(db, ref, attempt, receipt, nowMs);
};
const rejectRetryAttempt = (db, attemptId, patch) => db.ref(`notification_delivery_attempts/${attemptId}`).update(patch);
const isRetryAttemptExpired = (job, nowMs) => !job || Number(job.expiresAtMs || 0) <= nowMs || job.supersededByJobId;
const queueExpiredBroadcastDeletion = (updates, job) => {
  const navigation = job?.navigation || {};
  if (job?.sourceType === 'tour_announcement' && isValidFirebaseKey(job.tourId) && isValidFirebaseKey(navigation.messageId)) updates[`broadcasts/${job.tourId}/${navigation.messageId}`] = null;
  if (job?.sourceType === 'future_tour_category_broadcast' && isValidFirebaseKey(job.categoryKey) && isValidFirebaseKey(navigation.broadcastId)) updates[`category_broadcasts/${job.categoryKey}/${navigation.broadcastId}`] = null;
};

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
    return {
      ...profile,
      pushToken: null,
      pushTokenStatus: 'INVALID',
      pushTokenInvalidReason: reason,
      pushTokenUpdatedAt: new Date(nowMs).toISOString(),
    };
  });
  return cleared;
};

/** @param {any} db @param {string} jobId @param {number} nowMs */
const refreshNotificationJobStatus = async (db, jobId, nowMs) => {
  const snapshot = await db.ref('notification_delivery_attempts').orderByChild('jobId').equalTo(jobId).once('value');
  const attempts = Object.values(snapshot.val() || {});
  const counts = attempts.reduce((result, attempt) => {
    if (attempt.ticketStatus === 'ticket_accepted') result.ticketAccepted += 1;
    if (attempt.ticketStatus === 'ticket_rejected') result.ticketRejected += 1;
    if (attempt.receiptStatus === 'receipt_pending') result.receiptPending += 1;
    if (attempt.receiptStatus === 'provider_accepted') result.receiptAccepted += 1;
    if (attempt.receiptStatus === 'provider_rejected') result.receiptRejected += 1;
    if (attempt.status === 'retrying') result.retrying += 1;
    return result;
  }, {
    ticketAccepted: 0,
    ticketRejected: 0,
    receiptPending: 0,
    receiptAccepted: 0,
    receiptRejected: 0,
    retrying: 0,
  });
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  const jobSnapshot = await jobRef.once('value');
  const job = jobSnapshot.val();
  if (!job) return null;
  let status = job.status;
  if (counts.retrying > 0) status = 'retrying';
  else if (counts.receiptPending > 0) status = 'receipt_pending';
  else if (counts.receiptAccepted > 0 && counts.receiptRejected === 0 && counts.ticketRejected === 0) status = 'provider_accepted';
  else if (counts.receiptAccepted > 0) status = 'partial';
  else if (attempts.length && (counts.receiptRejected > 0 || counts.ticketRejected > 0)) status = 'provider_rejected';
  else if (!attempts.length) status = 'no_recipients';
  await jobRef.update({
    status,
    updatedAtMs: nowMs,
    counts: { ...(job.counts || {}), ...counts },
    ...(status === 'provider_accepted' || status === 'provider_rejected' || status === 'partial'
      ? { completedAtMs: nowMs }
      : {}),
  });
  await syncNotificationSourceStatus(db, {
    ...job,
    status,
    updatedAtMs: nowMs,
    counts: { ...(job.counts || {}), ...counts },
  }, nowMs);
  return { status, counts, job };
};

/** @param {{ db?: any, nowMs?: number, expo?: any }} options */
const processDueNotificationReceipts = async ({
  db = admin.database(),
  nowMs = Date.now(),
  expo = getExpoPushClient(),
} = {}) => {
  const snapshot = await db.ref('notification_delivery_attempts')
    .orderByChild('receiptDueAtMs')
    .endAt(nowMs)
    .limitToFirst(RECEIPT_BATCH_LIMIT)
    .once('value');
  const due = Object.entries(snapshot.val() || {})
    .filter(([, attempt]) => attempt?.receiptStatus === 'receipt_pending' && typeof attempt?.ticketId === 'string');
  if (!due.length) return { checked: 0, accepted: 0, rejected: 0, missing: 0, requestFailed: 0 };
  let receiptMap;
  try {
    receiptMap = await expo.getPushNotificationReceiptsAsync(due.map(([, attempt]) => attempt.ticketId));
  } catch (_error) {
    return rescheduleReceiptRequestFailure(db, due, nowMs);
  }
  const touchedJobs = new Set(); const counts = { accepted: 0, rejected: 0, missing: 0 };
  for (const [attemptId, attempt] of due) {
    touchedJobs.add(attempt.jobId);
    const outcome = await processReceipt(db, attemptId, attempt, receiptMap?.[attempt.ticketId], nowMs);
    counts[outcome] += 1;
  }
  for (const jobId of touchedJobs) {
    const refreshed = await refreshNotificationJobStatus(db, jobId, nowMs);
    if (refreshed?.job?.priorityClass === 'critical'
      && ['provider_rejected', 'partial'].includes(refreshed.status)) {
      await db.ref(`notification_delivery_warnings/${jobId}`).update({
        jobId,
        tourId: refreshed.job.tourId || null,
        eventId: refreshed.job.eventId || null,
        severity: 'critical',
        code: refreshed.status.toUpperCase(),
        status: 'open',
        updatedAtMs: nowMs,
      });
    }
  }
  return { checked: due.length, ...counts, requestFailed: 0 };
};

/** @param {{ db?: any, nowMs?: number, expo?: any }} options */
const retryDueNotificationAttempts = async ({
  db = admin.database(),
  nowMs = Date.now(),
  expo = getExpoPushClient(),
} = {}) => {
  const snapshot = await db.ref('notification_delivery_attempts')
    .orderByChild('availableAtMs')
    .endAt(nowMs)
    .limitToFirst(100)
    .once('value');
  const due = Object.entries(snapshot.val() || {}).filter(([, attempt]) => (
    attempt?.status === 'retrying'
    || (attempt?.status === 'sending'
      && Number(attempt.updatedAtMs || 0) <= nowMs - STALE_SENDING_ATTEMPT_MS)
  ));
  let retried = 0;
  for (const [attemptId, attempt] of due) {
    const job = (await db.ref(`notification_jobs/${attempt.jobId}`).once('value')).val();
    if (isRetryAttemptExpired(job, nowMs)) {
      await rejectRetryAttempt(db, attemptId, {
        status: 'provider_rejected', retryable: false, safeErrorCode: 'JOB_EXPIRED', updatedAtMs: nowMs,
      });
      continue;
    }
    if (Number(attempt.attemptNumber || 0) >= Number(job.maxAttempts || 8)) {
      await rejectRetryAttempt(db, attemptId, {
        status: 'provider_rejected',
        receiptStatus: 'provider_rejected',
        retryable: false,
        safeErrorCode: 'MAX_ATTEMPTS_REACHED',
        updatedAtMs: nowMs,
      });
      await refreshNotificationJobStatus(db, job.jobId, nowMs);
      continue;
    }
    const device = (await db.ref(`notification_devices/${attempt.installationUid}`).once('value')).val();
    const profile = (await db.ref(`users/${attempt.recipientUid}`).once('value')).val() || {};
    const recipient = await evaluateAudienceCandidate({
      db,
      job,
      candidate: { authUid: attempt.recipientUid, device, profile, source: device ? 'device' : 'legacy_user' },
      nowMs,
    });
    if (!recipient.eligible || recipient.tokenHash !== attempt.tokenHash) {
      await rejectRetryAttempt(db, attemptId, {
        status: 'provider_rejected', retryable: false, safeErrorCode: 'RECIPIENT_CHANGED', updatedAtMs: nowMs,
      });
      continue;
    }
    const retry = await retryNotificationDeliveryAttempt({ db, job, attemptId, attempt, recipient, nowMs, expo });
    if (retry.success) retried += 1;
    await refreshNotificationJobStatus(db, job.jobId, nowMs);
  }
  return { scanned: Object.keys(snapshot.val() || {}).length, retried };
};

/** @param {{ db?: any, nowMs?: number }} options */
const cleanupOldNotificationDeliveryData = async ({ db = admin.database(), nowMs = Date.now() } = {}) => {
  const cutoff = nowMs - RETENTION_MS;
  /** @type {Record<string, null>} */
  const updates = {};
  const oldJobsSnapshot = await db.ref('notification_jobs')
    .orderByChild('updatedAtMs').endAt(cutoff).limitToFirst(100).once('value');
  const oldJobs = oldJobsSnapshot.val() || {};
  for (const [jobId, job] of Object.entries(oldJobs)) {
    updates[`notification_jobs/${jobId}`] = null;
    updates[`notification_job_token_claims/${jobId}`] = null;
    updates[`notification_delivery_warnings/${jobId}`] = null;
    queueExpiredBroadcastDeletion(updates, job);
    if (job?.coalescingKey) {
      const coalescing = (await db.ref(`notification_job_coalescing/${job.coalescingKey}`).once('value')).val();
      if (coalescing?.jobId === jobId) updates[`notification_job_coalescing/${job.coalescingKey}`] = null;
    }
  }
  for (const root of ['notification_delivery_attempts', 'marketing_notification_details']) {
    const snapshot = await db.ref(root).orderByChild('updatedAtMs').endAt(cutoff).limitToFirst(100).once('value');
    Object.keys(snapshot.val() || {}).forEach((key) => { updates[`${root}/${key}`] = null; });
  }
  await db.ref().update(updates);
  return { deleted: Object.keys(updates).length };
};

const processNotificationReceipts = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west1',
  secrets: [expoAccessTokenSecret],
  maxInstances: 1,
}, async () => {
  const receipts = await processDueNotificationReceipts();
  const retries = await retryDueNotificationAttempts();
  return { receipts, retries };
});

const cleanupNotificationDeliveryData = onSchedule({
  schedule: 'every 24 hours',
  timeZone: 'Europe/London',
  region: 'europe-west1',
  maxInstances: 1,
}, async () => cleanupOldNotificationDeliveryData());

module.exports = {
  RECEIPT_BATCH_LIMIT,
  RECEIPT_WINDOW_MS,
  RETENTION_MS,
  STALE_SENDING_ATTEMPT_MS,
  cleanupNotificationDeliveryData,
  cleanupOldNotificationDeliveryData,
  compareAndClearTokenByHash,
  processDueNotificationReceipts,
  processNotificationReceipts,
  refreshNotificationJobStatus,
  retryDueNotificationAttempts,
};
