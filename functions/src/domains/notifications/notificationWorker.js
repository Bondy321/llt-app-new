'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  expoAccessTokenSecret,
  getExpoPushClient,
} = require('../../infrastructure/notifications/expoPushClient');
const {
  acquireNotificationJobLease,
  calculateRetryDelayMs,
} = require('./notificationJobs');
const {
  evaluateAudienceCandidate,
  loadNotificationAudiencePage,
} = require('./notificationAudiencePage');
const { syncNotificationSourceStatus } = require('./notificationSourceStatus');

const MAX_CONCURRENCY = 10;
const RECEIPT_DUE_DELAY_MS = 15 * 60 * 1000;
const MAX_EXPO_PAYLOAD_BYTES = 4096;
const RETRYABLE_TICKET_ERRORS = new Set(['MessageRateExceeded', 'ExpoServerError', 'InternalError']);
const CONFIGURATION_TICKET_ERRORS = new Set(['MismatchSenderId', 'InvalidCredentials']);

/** @param {string} jobId @param {string} authUid */
const buildDeliveryAttemptId = (jobId, authUid) => `attempt_v1_${createHash('sha256')
  .update(`${jobId}\u0000${authUid}`)
  .digest('hex')}`;

/** @param {any} job @param {any} recipient @param {number} nowMs */
const buildExpoPushMessage = (job, recipient, nowMs = Date.now()) => {
  const policy = job.deliveryPolicy || {};
  const ttlSeconds = Math.max(1, Math.floor((Number(job.expiresAtMs) - nowMs) / 1000));
  const message = {
    to: recipient.token,
    title: job.presentation.title,
    body: job.presentation.body,
    data: job.navigation || {},
    sound: policy.sound || 'default',
    priority: policy.priority || 'default',
    channelId: policy.channelId || 'default',
    ttl: ttlSeconds,
    expiration: Math.floor(Number(job.expiresAtMs) / 1000),
    ...(policy.interruptionLevel ? { interruptionLevel: policy.interruptionLevel } : {}),
    ...(policy.collapseId ? { collapseId: policy.collapseId } : {}),
    ...(policy.androidTag ? { tag: policy.androidTag } : {}),
    ...(policy.iosThreadId ? { threadId: policy.iosThreadId } : {}),
  };
  const safePayload = { ...message, to: '<expo-token>' };
  if (Buffer.byteLength(JSON.stringify(safePayload), 'utf8') > MAX_EXPO_PAYLOAD_BYTES) {
    const error = new Error('Notification payload exceeds provider size limit');
    error.code = 'MessageTooBig';
    throw error;
  }
  return message;
};

/** @param {any[]} items @param {number} concurrency @param {(item: any) => Promise<any>} callback */
const mapWithConcurrency = async (items, concurrency, callback) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

/** @param {any} db @param {any} job @param {any} recipient @param {number} nowMs */
const claimDeliveryAttempt = async (db, job, recipient, nowMs) => {
  const tokenClaimRef = db.ref(`notification_job_token_claims/${job.jobId}/${recipient.tokenHash}`);
  const tokenClaim = await tokenClaimRef.transaction((current) => current || recipient.authUid);
  if (tokenClaim.snapshot.val() !== recipient.authUid) return { claimed: false, reason: 'duplicate_token' };

  const attemptId = buildDeliveryAttemptId(job.jobId, recipient.authUid);
  const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
  let claimed = false;
  const transaction = await attemptRef.transaction((current) => {
    if (current && !['retrying'].includes(current.status)) return;
    if (current && Number(current.availableAtMs || 0) > nowMs) return;
    claimed = true;
    return {
      schemaVersion: 1,
      attemptId,
      jobId: job.jobId,
      recipientUid: recipient.authUid,
      installationUid: recipient.authUid,
      tokenHash: recipient.tokenHash,
      status: 'sending',
      ticketStatus: current?.ticketStatus || 'pending',
      receiptStatus: current?.receiptStatus || 'not_requested',
      retryable: false,
      attemptNumber: Number(current?.attemptNumber || 0) + 1,
      createdAtMs: Number(current?.createdAtMs || nowMs),
      updatedAtMs: nowMs,
      availableAtMs: nowMs,
      expiresAtMs: Number(job.expiresAtMs),
      safeErrorCode: null,
    };
  });
  return {
    claimed: Boolean(claimed && transaction?.snapshot?.val?.()?.status === 'sending'),
    attemptId,
    attemptRef,
    attempt: transaction?.snapshot?.val?.() || null,
  };
};

/** @param {any} db @param {any} jobRef @param {Record<string, number>} increments @param {Record<string, number>} skipReasons @param {number} nowMs */
const addJobCounts = async (db, jobRef, increments, skipReasons, nowMs) => {
  await jobRef.transaction((current) => {
    if (!current) return current;
    const counts = { ...(current.counts || {}) };
    Object.entries(increments).forEach(([key, value]) => {
      counts[key] = Number(counts[key] || 0) + Number(value || 0);
    });
    const reasons = { ...(current.skipReasons || {}) };
    Object.entries(skipReasons).forEach(([key, value]) => {
      reasons[key] = Number(reasons[key] || 0) + Number(value || 0);
    });
    return { ...current, counts, skipReasons: reasons, updatedAtMs: nowMs };
  });
};

/** @param {any} db @param {any} recipient @param {string} reason @param {number} nowMs */
const compareAndInvalidateToken = async (db, recipient, reason, nowMs) => {
  await Promise.all([
    db.ref(`notification_devices/${recipient.authUid}`).transaction((device) => {
      if (!device || device.tokenHash !== recipient.tokenHash) return device;
      return { ...device, pushToken: null, status: 'invalid', invalidReason: reason, updatedAtMs: nowMs };
    }),
    db.ref(`users/${recipient.authUid}`).transaction((profile) => {
      if (!profile || String(profile.pushToken || '').trim() !== recipient.token) return profile;
      return {
        ...profile,
        pushToken: null,
        pushTokenStatus: 'INVALID',
        pushTokenInvalidReason: reason,
        pushTokenUpdatedAt: new Date(nowMs).toISOString(),
      };
    }),
  ]);
};

/** @param {any} options */
const persistTicketResult = async ({ db, job, claimed, recipient, ticket, nowMs }) => {
  if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
    await claimed.attemptRef.update({
      status: 'receipt_pending',
      ticketStatus: 'ticket_accepted',
      receiptStatus: 'receipt_pending',
      ticketId: ticket.id,
      receiptDueAtMs: nowMs + RECEIPT_DUE_DELAY_MS,
      receiptWindowExpiresAtMs: nowMs + (24 * 60 * 60 * 1000),
      updatedAtMs: nowMs,
      safeErrorCode: null,
    });
    return { ticketAccepted: 1, ticketRejected: 0, receiptPending: 1, retrying: 0 };
  }

  const code = String(ticket?.details?.error || ticket?.code || 'PROVIDER_REJECTED').slice(0, 80);
  const retryable = RETRYABLE_TICKET_ERRORS.has(code);
  const attemptNumber = Number(claimed.attempt?.attemptNumber || 1);
  await claimed.attemptRef.update({
    status: retryable ? 'retrying' : 'ticket_rejected',
    ticketStatus: 'ticket_rejected',
    receiptStatus: 'not_requested',
    retryable,
    availableAtMs: retryable ? nowMs + calculateRetryDelayMs(attemptNumber, job.priorityClass) : nowMs,
    updatedAtMs: nowMs,
    safeErrorCode: code,
  });
  if (code === 'DeviceNotRegistered') await compareAndInvalidateToken(db, recipient, code, nowMs);
  if (CONFIGURATION_TICKET_ERRORS.has(code)) {
    await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
      jobId: job.jobId,
      severity: 'critical',
      code,
      status: 'open',
      updatedAtMs: nowMs,
    });
  }
  return { ticketAccepted: 0, ticketRejected: 1, receiptPending: 0, retrying: retryable ? 1 : 0 };
};

/** @param {any} options */
const retryNotificationDeliveryAttempt = async ({
  db = admin.database(), job, attemptId, attempt, recipient, nowMs = Date.now(), expo = getExpoPushClient(),
}) => {
  const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
  const nextAttempt = { ...attempt, attemptNumber: Number(attempt.attemptNumber || 0) + 1 };
  await attemptRef.update({ status: 'sending', attemptNumber: nextAttempt.attemptNumber, updatedAtMs: nowMs });
  try {
    const message = buildExpoPushMessage(job, recipient, nowMs);
    const tickets = await expo.sendPushNotificationsAsync([message]);
    await persistTicketResult({
      db, job, claimed: { attemptRef, attempt: nextAttempt }, recipient, ticket: tickets[0], nowMs,
    });
    return { success: true };
  } catch (error) {
    await attemptRef.update({
      status: 'retrying',
      availableAtMs: nowMs + calculateRetryDelayMs(nextAttempt.attemptNumber, job.priorityClass),
      safeErrorCode: 'EXPO_REQUEST_FAILED',
      updatedAtMs: nowMs,
    });
    log.error('Notification attempt retry failed', error, { jobId: job.jobId, attemptId });
    return { success: false };
  }
};

const prepareDeliveryPage = async (db, job, candidates, nowMs) => {
  const skipReasons = {}; const prepared = [];
  const evaluations = await mapWithConcurrency(candidates, MAX_CONCURRENCY, async (candidate) => ({ candidate, result: await evaluateAudienceCandidate({ db, job, candidate, nowMs }) }));
  for (const { result } of evaluations) {
    const reason = result.eligible ? null : (result.reason || 'invalid_token');
    if (reason) { skipReasons[reason] = Number(skipReasons[reason] || 0) + 1; continue; }
    const claimed = await claimDeliveryAttempt(db, job, result, nowMs);
    if (!claimed.claimed) { const claimReason = claimed.reason || 'duplicate_token'; skipReasons[claimReason] = Number(skipReasons[claimReason] || 0) + 1; continue; }
    try { prepared.push({ recipient: result, claimed, message: buildExpoPushMessage(job, result, nowMs) }); } catch (error) { await claimed.attemptRef.update({ status: 'ticket_rejected', ticketStatus: 'ticket_rejected', safeErrorCode: String(error?.code || 'MessageTooBig').slice(0, 80), updatedAtMs: nowMs }); skipReasons.invalid_token = Number(skipReasons.invalid_token || 0) + 1; }
  }
  return { prepared, skipReasons };
};
const sendPreparedChunks = async (db, job, prepared, increments, expo, nowMs) => {
  for (const chunk of expo.chunkPushNotifications(prepared.map((item) => item.message))) {
    const items = chunk.map((message) => prepared.find((item) => item.message === message));
    try { const tickets = await expo.sendPushNotificationsAsync(chunk); for (let index = 0; index < items.length; index += 1) { const item = items[index]; if (!item) continue; const result = await persistTicketResult({ db, job, claimed: item.claimed, recipient: item.recipient, ticket: tickets[index], nowMs }); Object.entries(result).forEach(([key, value]) => { increments[key] += value; }); } } catch (error) { for (const item of items.filter(Boolean)) { const attemptNumber = Number(item.claimed.attempt?.attemptNumber || 1); await item.claimed.attemptRef.update({ status: 'retrying', ticketStatus: 'ticket_rejected', retryable: true, availableAtMs: nowMs + calculateRetryDelayMs(attemptNumber, job.priorityClass), updatedAtMs: nowMs, safeErrorCode: 'EXPO_REQUEST_FAILED' }); increments.ticketRejected += 1; increments.retrying += 1; } log.error('Notification delivery request failed', error, { jobId: job.jobId, chunkSize: chunk.length }); }
  }
};
const resolveFanoutStatus = (counts) => {
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

/** @param {{ db?: any, jobRef: any, job: any, nowMs?: number, expo?: any }} options */
const processNotificationJobPage = async ({
  db = admin.database(),
  jobRef,
  job,
  nowMs = Date.now(),
  expo = getExpoPushClient(),
}) => {
  if (job.supersededByJobId || Number(job.expiresAtMs) <= nowMs) {
    await jobRef.update({ status: 'expired', lease: null, updatedAtMs: nowMs });
    return { status: 'expired' };
  }
  const page = await loadNotificationAudiencePage(db, job.afterRecipientId);
  const { prepared, skipReasons } = await prepareDeliveryPage(db, job, page.candidates, nowMs);

  const increments = {
    audience: page.candidates.length,
    eligible: prepared.length,
    skipped: Object.values(skipReasons).reduce((sum, count) => sum + count, 0),
    ticketAccepted: 0,
    ticketRejected: 0,
    receiptPending: 0,
    retrying: 0,
  };
  await sendPreparedChunks(db, job, prepared, increments, expo, nowMs);

  await addJobCounts(db, jobRef, increments, skipReasons, nowMs);
  const refreshed = (await jobRef.once('value')).val() || job;
  if (page.nextCursor) {
    await jobRef.update({
      status: 'queued',
      afterRecipientId: page.nextCursor,
      availableAtMs: nowMs,
      lease: null,
      updatedAtMs: nowMs,
    });
    await syncNotificationSourceStatus(db, { ...refreshed, status: 'queued', afterRecipientId: page.nextCursor }, nowMs);
    return { status: 'queued', nextCursor: page.nextCursor, increments, skipReasons };
  }

  const counts = refreshed.counts || {};
  const finalStatus = resolveFanoutStatus(counts);
  await jobRef.update({
    status: finalStatus,
    afterRecipientId: null,
    lease: null,
    fanoutCompletedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await syncNotificationSourceStatus(db, {
    ...refreshed,
    status: finalStatus,
    afterRecipientId: null,
    fanoutCompletedAtMs: nowMs,
  }, nowMs);
  if (job.priorityClass === 'critical' && ['no_recipients', 'ticket_rejected'].includes(finalStatus)) {
    await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
      jobId: job.jobId,
      tourId: job.tourId || null,
      eventId: job.eventId || null,
      severity: 'critical',
      code: finalStatus.toUpperCase(),
      status: 'open',
      updatedAtMs: nowMs,
    });
  }
  return { status: finalStatus, increments, skipReasons };
};

/** @param {{ db?: any, jobId: string, nowMs?: number, expo?: any }} options */
const runNotificationJob = async ({ db = admin.database(), jobId, nowMs = Date.now(), expo }) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  const lease = await acquireNotificationJobLease({ jobRef, nowMs, ownerId: randomUUID() });
  if (!lease.acquired) return { acquired: false, status: lease.job?.status || 'missing' };
  try {
    const result = await processNotificationJobPage({ db, jobRef, job: lease.job, nowMs, ...(expo ? { expo } : {}) });
    return { acquired: true, ...result };
  } catch (error) {
    const nextAttempt = Number(lease.job.attemptCount || 0) + 1;
    const expired = nextAttempt >= Number(lease.job.maxAttempts || 8) || Number(lease.job.expiresAtMs) <= nowMs;
    await jobRef.update({
      status: expired ? 'expired' : 'retrying',
      attemptCount: nextAttempt,
      availableAtMs: expired ? nowMs : nowMs + calculateRetryDelayMs(nextAttempt, lease.job.priorityClass),
      lease: null,
      lastErrorCode: String(error?.code || 'WORKER_FAILED').slice(0, 80),
      updatedAtMs: nowMs,
    });
    const current = (await jobRef.once('value')).val();
    if (current) await syncNotificationSourceStatus(db, current, nowMs);
    log.error('Notification job page failed', error, { jobId });
    return { acquired: true, status: expired ? 'expired' : 'retrying' };
  }
};

const processNotificationDeliveryJob = onValueWritten({
  ref: '/notification_jobs/{jobId}',
  region: 'europe-west1',
  secrets: [expoAccessTokenSecret],
  maxInstances: 20,
}, async (event) => {
  const job = event.data.after.val();
  if (!job || !['queued', 'retrying'].includes(job.status) || Number(job.availableAtMs || 0) > Date.now()) return null;
  return runNotificationJob({ jobId: event.params.jobId });
});

const recoverNotificationDeliveryJobs = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west1',
  secrets: [expoAccessTokenSecret],
  maxInstances: 1,
}, async () => {
  const db = admin.database();
  const nowMs = Date.now();
  const snapshot = await db.ref('notification_jobs').orderByChild('availableAtMs').endAt(nowMs).limitToFirst(25).once('value');
  const jobs = snapshot.val() || {};
  const runnable = Object.entries(jobs).filter(([, job]) => (
    ['queued', 'retrying'].includes(job?.status)
    || (job?.status === 'fanout_in_progress' && Number(job?.lease?.expiresAtMs || 0) <= nowMs)
  ));
  await mapWithConcurrency(runnable, 5, ([jobId]) => runNotificationJob({ db, jobId, nowMs }));
  return { scanned: Object.keys(jobs).length, processed: runnable.length };
});

module.exports = {
  MAX_EXPO_PAYLOAD_BYTES,
  RECEIPT_DUE_DELAY_MS,
  buildDeliveryAttemptId,
  buildExpoPushMessage,
  claimDeliveryAttempt,
  mapWithConcurrency,
  persistTicketResult,
  processNotificationDeliveryJob,
  processNotificationJobPage,
  recoverNotificationDeliveryJobs,
  retryNotificationDeliveryAttempt,
  runNotificationJob,
};
