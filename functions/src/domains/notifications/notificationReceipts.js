'use strict';

// @ts-check

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { expoAccessTokenSecret, getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { calculateRetryDelayMs } = require('./notificationJobs');
const { isTerminalNotificationJobStatus } = require('./notificationJobStatus');
const { evaluateAudienceCandidate, hashPushToken } = require('./notificationAudiencePage');
const { QUEUE_ROOTS, claimQueueEntry, loadDueQueueEntries, releaseClaimedQueueEntry,
  removeClaimedQueueEntry } = require('./notificationQueues');
const { markSubmissionUnknown, retryNotificationDeliveryAttempt, transitionDeliveryAttempt } = require('./notificationWorker');
const { syncNotificationSourceStatus } = require('./notificationSourceStatus');
const { removeMarketingAudienceForRevision } = require('./notificationMarketingAudience');
const {
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  runNotificationRetentionCycle,
  writeRetentionDeploymentHeartbeat,
} = require('../notification-retention/public');
const {
  NOTIFICATION_RETENTION_MS: RETENTION_MS,
  isNotificationLifecycleRetentionFenced,
  scheduleNotificationRetentionIfEligible,
} = require('./notificationRetentionIntegration');

const RECEIPT_BATCH_LIMIT = 1000;
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_SENDING_ATTEMPT_MS = 2 * 60 * 1000;
const TEMPORARY_RECEIPT_ERRORS = new Set(['MessageRateExceeded']);
const CONFIGURATION_RECEIPT_ERRORS = new Set(['MismatchSenderId', 'InvalidCredentials']);

/** @param {any} db @param {any} attempt @param {string} reason @param {number} nowMs */
const compareAndClearTokenByHash = async (db, attempt, reason, nowMs) => {
  const uid = attempt.installationUid || attempt.recipientUid;
  if (!uid) return false;
  let cleared = false;
  let invalidatedRevision = 0;
  await db.ref(`notification_devices/${uid}`).transaction((device) => {
    if (!device || device.tokenHash !== attempt.tokenHash) return device;
    cleared = true;
    invalidatedRevision = Number(device.registrationRevision || 0) + 1;
    return {
      ...device,
      pushToken: null,
      tokenHash: null,
      status: 'invalid',
      invalidReason: reason,
      operationalEligible: false,
      operationalTourId: null,
      operationalSessionId: null,
      operationalSessionRevision: null,
      marketingEligible: false,
      registrationRevision: invalidatedRevision,
      updatedAtMs: nowMs,
    };
  });
  await db.ref(`users/${uid}`).transaction((profile) => {
    const token = String(profile?.pushToken || '').trim();
    if (!token || hashPushToken(token) !== attempt.tokenHash) return profile;
    cleared = true;
    return { ...profile, pushToken: null, pushTokenStatus: 'INVALID', pushTokenInvalidReason: reason, pushTokenUpdatedAt: new Date(nowMs).toISOString() };
  });
  if (invalidatedRevision) {
    await removeMarketingAudienceForRevision({ db, authUid: uid, registrationRevision: invalidatedRevision });
  }
  return cleared;
};

// eslint-disable-next-line complexity -- explicit precedence is the notification state machine
const resolveJobStatus = (job) => {
  const counts = job.counts || {};
  if (!job.fanoutCompletedAtMs && ['queued', 'fanout_in_progress'].includes(job.status)) return job.status;
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  if (Number(counts.receiptAccepted || 0) > 0 && Number(counts.receiptRejected || 0) === 0 && Number(counts.ticketRejected || 0) === 0 && Number(counts.submissionUnknown || 0) === 0) return 'provider_accepted';
  if (Number(counts.submissionUnknown || 0) > 0) {
    const known = Number(counts.receiptAccepted || 0) + Number(counts.receiptRejected || 0)
      + Number(counts.ticketAccepted || 0) + Number(counts.ticketRejected || 0);
    return known > 0 ? 'partial' : 'submission_unknown';
  }
  if (Number(counts.receiptAccepted || 0) > 0) return 'partial';
  if (Number(counts.receiptRejected || 0) > 0) return 'provider_rejected';
  if (Number(counts.ticketRejected || 0) > 0) return 'ticket_rejected';
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

/** Current-state status refresh is O(1): transition helpers maintain job counters. */
const refreshNotificationJobStatus = async (db, jobId, nowMs) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  let updated = null;
  let retained = null;
  await jobRef.transaction((job) => {
    if (!job) return job;
    if (job.status === 'privacy_deleted' || isNotificationLifecycleRetentionFenced(job, nowMs)) {
      retained = job;
      return job;
    }
    const status = resolveJobStatus(job);
    updated = { ...job, status, updatedAtMs: nowMs, ...(isTerminalNotificationJobStatus(status) ? { completedAtMs: Number(job.completedAtMs || nowMs) } : {}) };
    return updated;
  });
  if (retained) return {
    status: retained.status, counts: retained.counts || {}, job: retained, retentionFenced: true,
  };
  if (!updated) return null;
  let schedulingError = null;
  try {
    await scheduleNotificationRetentionIfEligible(db, updated, nowMs);
  } catch (error) {
    schedulingError = error;
  }
  await syncNotificationSourceStatus(db, updated, nowMs);
  if (updated.priorityClass === 'critical' && ['provider_rejected', 'partial', 'submission_unknown'].includes(updated.status)) {
    await db.ref(`notification_delivery_warnings/${jobId}`).update({ jobId, tourId: updated.tourId || null, eventId: updated.eventId || null, severity: 'critical', code: updated.status.toUpperCase(), status: 'open', updatedAtMs: nowMs });
  }
  if (schedulingError) throw schedulingError;
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
  const observedJobs = new Map();
  for (const [queueKey, entry] of queue) {
    const claimed = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.receipt}/${queueKey}`), nowMs);
    if (!claimed.claimed) continue;
    const attempt = (await db.ref(`notification_delivery_attempts/${entry.targetId}`).once('value')).val();
    if (!attempt || attempt.queueKey !== queueKey || Number(attempt.queueVersion) !== Number(entry.version) || attempt.receiptStatus !== 'receipt_pending' || typeof attempt.ticketId !== 'string') {
      await removeClaimedQueueEntry(db.ref(`${QUEUE_ROOTS.receipt}/${queueKey}`), claimed.ownerId);
      continue;
    }
    if (!observedJobs.has(attempt.jobId)) {
      observedJobs.set(attempt.jobId, (await db.ref(`notification_jobs/${attempt.jobId}`).once('value')).val());
    }
    if (isNotificationLifecycleRetentionFenced(observedJobs.get(attempt.jobId), nowMs)) {
      await releaseClaimedQueueEntry(
        db.ref(`${QUEUE_ROOTS.receipt}/${queueKey}`), claimed.ownerId, nowMs + STALE_SENDING_ATTEMPT_MS,
      );
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
    if (!attempt || attempt.queueKey !== queueKey || Number(attempt.queueVersion) !== Number(entry.version)) { await removeClaimedQueueEntry(db.ref(`${QUEUE_ROOTS.retry}/${queueKey}`), claimedQueue.ownerId); continue; }
    scanned += 1;
    const job = (await db.ref(`notification_jobs/${attempt.jobId}`).once('value')).val();
    if (isNotificationLifecycleRetentionFenced(job, nowMs)) {
      await releaseClaimedQueueEntry(
        db.ref(`${QUEUE_ROOTS.retry}/${queueKey}`), claimedQueue.ownerId, nowMs + STALE_SENDING_ATTEMPT_MS,
      );
      continue;
    }
    if (attempt.status === 'request_started') {
      await markSubmissionUnknown(db, job || { jobId: attempt.jobId, priorityClass: 'standard' }, { attemptRef: db.ref(`notification_delivery_attempts/${attemptId}`), attemptId, attempt }, nowMs, new Error('Stale submission lease'));
      await refreshNotificationJobStatus(db, attempt.jobId, nowMs);
      continue;
    }
    if (attempt.status === 'prepared') {
      await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'retrying', retryable: true, availableAtMs: nowMs, submissionLease: null, safeErrorCode: 'PRE_REQUEST_RECOVERY' }, nowMs);
      Object.assign(attempt, (await db.ref(`notification_delivery_attempts/${attemptId}`).once('value')).val() || {});
    }
    if (attempt.status !== 'retrying') {
      await removeClaimedQueueEntry(db.ref(`${QUEUE_ROOTS.retry}/${queueKey}`), claimedQueue.ownerId);
      continue;
    }
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

const cleanupOldNotificationDeliveryData = async () => {
  // Parent-first compatibility cleanup cannot prove bounded attempt exhaustion.
  // It is intentionally inert in legacy, shadow, missing and malformed rollout
  // states. Destructive retention is available only through the durable
  // job-scoped compactor after protocol-bound preparation, shadow and canary.
  return { deleted: 0, rolloutChanged: false, failClosed: true };
};

const processNotificationReceipts = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Europe/London', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 1 }, async () => ({ receipts: await processDueNotificationReceipts(), retries: await retryDueNotificationAttempts() }));
const cleanupNotificationDeliveryData = onSchedule({
  schedule: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.schedule,
  timeZone: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.timeZone,
  region: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.region,
  maxInstances: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.maxInstances,
  timeoutSeconds: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.timeoutSeconds,
}, async () => {
  const db = admin.database();
  const nowMs = Date.now();
  await writeRetentionDeploymentHeartbeat({ db, nowMs });
  return runNotificationRetentionCycle({
    db,
    nowMs,
    resumeRequeue: (options) => require('./notificationAdminFunctions')
      .requeueFailedNotificationJob(options),
    legacyCleanup: (options = {}) => cleanupOldNotificationDeliveryData({
      ...options,
      db: options.db || db,
      nowMs: Number.isSafeInteger(options.nowMs) ? options.nowMs : nowMs,
    }),
  });
});

module.exports = { RECEIPT_BATCH_LIMIT, RECEIPT_WINDOW_MS, RETENTION_MS, STALE_SENDING_ATTEMPT_MS, cleanupNotificationDeliveryData, cleanupOldNotificationDeliveryData, compareAndClearTokenByHash, processDueNotificationReceipts, processNotificationReceipts, refreshNotificationJobStatus, retryDueNotificationAttempts };
