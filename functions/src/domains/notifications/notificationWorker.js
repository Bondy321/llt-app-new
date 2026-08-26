'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const { expoAccessTokenSecret, getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { acquireNotificationJobLease, calculateRetryDelayMs } = require('./notificationJobs');
const { evaluateAudienceCandidate, loadNotificationAudiencePage } = require('./notificationAudiencePage');
const {
  QUEUE_ROOTS,
  claimQueueEntry,
  loadDueQueueEntries,
  transitionQueuedRecord,
} = require('./notificationQueues');
const { syncNotificationSourceStatus } = require('./notificationSourceStatus');

const MAX_CONCURRENCY = 10;
const RECEIPT_DUE_DELAY_MS = 15 * 60 * 1000;
// Expo documents a 4 KiB payload ceiling. Keep headroom for provider-added
// envelope fields that are not represented by the SDK message object.
const MAX_EXPO_PAYLOAD_BYTES = 3800;
const RETRYABLE_TICKET_ERRORS = new Set(['MessageRateExceeded', 'ExpoServerError', 'InternalError']);
const CONFIGURATION_TICKET_ERRORS = new Set(['MismatchSenderId', 'InvalidCredentials']);

/** @param {string} jobId @param {string} authUid @param {number} generation */
const buildDeliveryAttemptId = (jobId, authUid, generation = 1) => `attempt_v2_${createHash('sha256')
  .update(`${jobId}\u0000${authUid}\u0000${generation}`)
  .digest('hex')}`;

/** @param {any} attempt */
const attemptCountShape = (attempt) => ({
  ticketAccepted: attempt?.ticketStatus === 'ticket_accepted' ? 1 : 0,
  ticketRejected: attempt?.ticketStatus === 'ticket_rejected' ? 1 : 0,
  receiptPending: attempt?.receiptStatus === 'receipt_pending' ? 1 : 0,
  receiptAccepted: attempt?.receiptStatus === 'provider_accepted' ? 1 : 0,
  receiptRejected: attempt?.receiptStatus === 'provider_rejected' ? 1 : 0,
  retrying: attempt?.status === 'retrying' ? 1 : 0,
  submissionUnknown: attempt?.status === 'submission_unknown' ? 1 : 0,
});

/** @param {string} jobId @param {any} before @param {any} after */
const buildAttemptCountDeltaUpdates = (jobId, before, after) => {
  const previous = attemptCountShape(before);
  const next = attemptCountShape(after);
  const updates = {};
  Object.keys(next).forEach((key) => {
    const delta = next[key] - previous[key];
    if (delta) updates[`notification_jobs/${jobId}/counts/${key}`] = admin.database.ServerValue.increment(delta);
  });
  return updates;
};

/**
 * All post-claim attempt state changes pass through here so queue membership and
 * the attempt state are one multi-location write. Aggregate deltas are bounded
 * and never scan delivery attempts.
 * @param {any} db @param {string} attemptId @param {any} current @param {any} patch @param {number} nowMs
 */
const transitionDeliveryAttempt = async (db, attemptId, current, patch, nowMs) => {
  const next = { ...current, ...patch, updatedAtMs: nowMs };
  let queueKind = null;
  let dueAtMs = null;
  if (next.status === 'retrying') { queueKind = 'retry'; dueAtMs = next.availableAtMs; }
  if (['prepared', 'request_started'].includes(next.status)) {
    queueKind = 'retry';
    dueAtMs = Number(next.retryLease?.expiresAtMs || next.submissionLease?.expiresAtMs || nowMs + 120_000);
  }
  if (next.receiptStatus === 'receipt_pending') { queueKind = 'receipt'; dueAtMs = next.receiptDueAtMs; }
  const queue = await transitionQueuedRecord(db, {
    targetPath: `notification_delivery_attempts/${attemptId}`,
    current,
    patch: { ...patch, updatedAtMs: nowMs },
    queueKind,
    dueAtMs,
    targetId: attemptId,
    additionalUpdates: buildAttemptCountDeltaUpdates(current.jobId || next.jobId, current, next),
  });
  const persisted = { ...next, queueKind, queueKey: queue.queueKey, queueVersion: queue.queueVersion };
  return persisted;
};

/** @param {any} job @param {any} recipient @param {number} nowMs */
const buildExpoPushMessage = (job, recipient, nowMs = Date.now()) => {
  const policy = job.deliveryPolicy || {};
  const message = {
    to: recipient.token,
    title: job.presentation.title,
    body: job.presentation.body,
    data: job.navigation || {},
    sound: policy.sound || 'default',
    priority: policy.priority || 'default',
    channelId: policy.channelId || 'default',
    ttl: Math.max(1, Math.floor((Number(job.expiresAtMs) - nowMs) / 1000)),
    expiration: Math.floor(Number(job.expiresAtMs) / 1000),
    ...(policy.interruptionLevel ? { interruptionLevel: policy.interruptionLevel } : {}),
    ...(policy.collapseId ? { collapseId: policy.collapseId } : {}),
    ...(policy.androidTag ? { tag: policy.androidTag } : {}),
    ...(policy.iosThreadId ? { threadId: policy.iosThreadId } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MAX_EXPO_PAYLOAD_BYTES) {
    const error = new Error('Notification payload exceeds provider size limit');
    error.code = 'MessageTooBig';
    throw error;
  }
  return message;
};

/** @param {any[]} items @param {number} concurrency @param {(item: any) => Promise<any>} callback */
const mapWithConcurrency = async (items, concurrency, callback) => {
  const results = new Array(items.length); let nextIndex = 0;
  const worker = async () => { while (nextIndex < items.length) { const index = nextIndex; nextIndex += 1; results[index] = await callback(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

/** @param {any} db @param {any} job @param {any} recipient @param {number} nowMs @param {number} generation */
const claimDeliveryAttempt = async (db, job, recipient, nowMs, generation = 1) => {
  const attemptId = buildDeliveryAttemptId(job.jobId, recipient.authUid, generation);
  const recipientRef = db.ref(`notification_job_recipients/${job.jobId}/${recipient.authUid}`);
  const existingRecipient = (await recipientRef.once('value')).val();
  if (existingRecipient && existingRecipient.attemptId !== attemptId) return { claimed: false, reason: 'already_evaluated' };
  const tokenClaimRef = db.ref(`notification_job_token_claims/${job.jobId}/${recipient.tokenHash}`);
  const tokenClaim = await tokenClaimRef.transaction((current) => current || recipient.authUid);
  if (tokenClaim.snapshot.val() !== recipient.authUid) return { claimed: false, reason: 'duplicate_token' };
  const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
  const leaseOwnerId = randomUUID();
  const attempt = {
    schemaVersion: 2, attemptId, generation, jobId: job.jobId,
    recipientUid: recipient.authUid, installationUid: recipient.authUid,
    tokenHash: recipient.tokenHash, status: 'prepared', ticketStatus: 'pending',
    receiptStatus: 'not_requested', retryable: false, attemptNumber: 1,
    submissionLease: { ownerId: leaseOwnerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + 2 * 60 * 1000 },
    createdAtMs: nowMs, updatedAtMs: nowMs, availableAtMs: nowMs,
    expiresAtMs: Number(job.expiresAtMs), safeErrorCode: null,
    queueKind: null, queueKey: null, queueVersion: 0,
  };
  const transaction = await attemptRef.transaction((current) => current || attempt);
  let persisted = transaction?.snapshot?.val?.() || null;
  const claimed = persisted?.submissionLease?.ownerId === leaseOwnerId;
  if (persisted?.status === 'prepared' && (!persisted.queueKey || persisted.queueKind !== 'retry')) {
    const queue = await transitionQueuedRecord(db, {
      targetPath: `notification_delivery_attempts/${attemptId}`,
      current: persisted,
      patch: {},
      queueKind: 'retry',
      dueAtMs: persisted.submissionLease.expiresAtMs,
      targetId: attemptId,
    });
    persisted = { ...persisted, queueKind: 'retry', queueKey: queue.queueKey, queueVersion: queue.queueVersion };
  }
  await recipientRef.transaction((current) => current || {
    generation, attemptId, tokenHash: recipient.tokenHash, status: 'claimed', updatedAtMs: nowMs,
  });
  return { claimed, attemptId, attemptRef, attempt: persisted };
};

/** @param {any} db @param {any} jobRef @param {Record<string, number>} increments @param {Record<string, number>} skipReasons @param {number} nowMs */
const addJobCounts = (db, jobRef, increments, skipReasons, nowMs) => jobRef.transaction((current) => {
  if (!current) return current;
  const counts = { ...(current.counts || {}) };
  Object.entries(increments).forEach(([key, value]) => { counts[key] = Number(counts[key] || 0) + Number(value || 0); });
  const reasons = { ...(current.skipReasons || {}) };
  Object.entries(skipReasons).forEach(([key, value]) => { reasons[key] = Number(reasons[key] || 0) + Number(value || 0); });
  return { ...current, counts, skipReasons: reasons, updatedAtMs: nowMs };
});

/** @param {any} db @param {any} recipient @param {string} reason @param {number} nowMs */
const compareAndInvalidateToken = async (db, recipient, reason, nowMs) => Promise.all([
  db.ref(`notification_devices/${recipient.authUid}`).transaction((device) => (!device || device.tokenHash !== recipient.tokenHash ? device : { ...device, pushToken: null, status: 'invalid', invalidReason: reason, updatedAtMs: nowMs })),
  db.ref(`users/${recipient.authUid}`).transaction((profile) => (!profile || String(profile.pushToken || '').trim() !== recipient.token ? profile : { ...profile, pushToken: null, pushTokenStatus: 'INVALID', pushTokenInvalidReason: reason, pushTokenUpdatedAt: new Date(nowMs).toISOString() })),
]);

/** @param {any} options */
const persistTicketResult = async ({ db, job, claimed, recipient, ticket, nowMs }) => {
  const current = (await claimed.attemptRef.once('value')).val() || claimed.attempt;
  if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
    await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
      status: 'receipt_pending', ticketStatus: 'ticket_accepted', receiptStatus: 'receipt_pending',
      ticketId: ticket.id, receiptDueAtMs: nowMs + RECEIPT_DUE_DELAY_MS,
      receiptWindowExpiresAtMs: nowMs + (24 * 60 * 60 * 1000), submissionLease: null,
      retryable: false, safeErrorCode: null,
    }, nowMs);
    return { ticketAccepted: 0, ticketRejected: 0, receiptPending: 0, retrying: 0 };
  }
  const code = String(ticket?.details?.error || ticket?.code || 'PROVIDER_REJECTED').slice(0, 80);
  const retryable = RETRYABLE_TICKET_ERRORS.has(code);
  await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
    status: retryable ? 'retrying' : 'ticket_rejected', ticketStatus: 'ticket_rejected',
    receiptStatus: 'not_requested', retryable,
    availableAtMs: retryable ? nowMs + calculateRetryDelayMs(Number(current.attemptNumber || 1), job.priorityClass) : nowMs,
    submissionLease: null, safeErrorCode: code,
  }, nowMs);
  if (code === 'DeviceNotRegistered') await compareAndInvalidateToken(db, recipient, code, nowMs);
  if (CONFIGURATION_TICKET_ERRORS.has(code)) await db.ref(`notification_delivery_warnings/${job.jobId}`).update({ jobId: job.jobId, severity: 'critical', code, status: 'open', updatedAtMs: nowMs });
  return { ticketAccepted: 0, ticketRejected: 0, receiptPending: 0, retrying: 0 };
};

/** Mark an externally ambiguous submission terminal: automatic retry could duplicate delivery. */
const markSubmissionUnknown = async (db, job, claimed, nowMs, error) => {
  const current = (await claimed.attemptRef.once('value')).val() || claimed.attempt;
  await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
    status: 'submission_unknown', ticketStatus: 'submission_unknown', receiptStatus: 'not_requested',
    retryable: false, submissionLease: null, safeErrorCode: 'SUBMISSION_UNKNOWN',
  }, nowMs);
  await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
    jobId: job.jobId, severity: job.priorityClass === 'critical' ? 'critical' : 'warning',
    code: 'SUBMISSION_UNKNOWN', status: 'open', updatedAtMs: nowMs,
  });
  log.error('Notification submission outcome is unknown; automatic resend suppressed', error, { jobId: job.jobId, attemptId: claimed.attemptId });
};

const markRequestStarted = async (db, claimed, nowMs) => {
  const current = (await claimed.attemptRef.once('value')).val() || claimed.attempt;
  const started = await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
    status: 'request_started', requestStartedAtMs: nowMs,
  }, nowMs);
  claimed.attempt = started;
  return started;
};

/** Retry worker is the only owner allowed to submit a retry generation. */
const retryNotificationDeliveryAttempt = async ({ db = admin.database(), job, attemptId, attempt, recipient, nowMs = Date.now(), expo = getExpoPushClient() }) => {
  const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
  let message;
  try { message = buildExpoPushMessage(job, recipient, nowMs); } catch (_error) {
    await transitionDeliveryAttempt(db, attemptId, attempt, { status: 'ticket_rejected', ticketStatus: 'ticket_rejected', retryable: false, safeErrorCode: 'PAYLOAD_TOO_LARGE' }, nowMs);
    return { success: false, reason: 'PAYLOAD_TOO_LARGE' };
  }
  const ownerId = randomUUID(); let acquired = false;
  const lease = await attemptRef.transaction((current) => {
    if (!current || current.status !== 'retrying' || Number(current.availableAtMs || 0) > nowMs) return;
    if (current.retryLease && Number(current.retryLease.expiresAtMs || 0) > nowMs) return;
    acquired = true;
    return { ...current, retryLease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + 120_000 }, updatedAtMs: nowMs };
  });
  const leased = lease?.snapshot?.val?.() || attempt;
  if (!acquired || leased.retryLease?.ownerId !== ownerId) return { success: false, reason: 'NOT_CLAIMED' };
  const sending = await transitionDeliveryAttempt(db, attemptId, leased, {
    status: 'request_started', requestStartedAtMs: nowMs,
    attemptNumber: Number(leased.attemptNumber || 0) + 1,
  }, nowMs);
  try {
    const tickets = await expo.sendPushNotificationsAsync([message]);
    await persistTicketResult({ db, job, claimed: { attemptRef, attemptId, attempt: sending }, recipient, ticket: tickets[0], nowMs });
    return { success: true };
  } catch (error) {
    await markSubmissionUnknown(db, job, { attemptRef, attemptId, attempt: sending }, nowMs, error);
    return { success: false, reason: 'SUBMISSION_UNKNOWN' };
  }
};

const prepareDeliveryPage = async (db, job, candidates, nowMs) => {
  const skipReasons = {}; const prepared = []; let eligibleCount = 0;
  const evaluations = await mapWithConcurrency(candidates, MAX_CONCURRENCY, async (candidate) => ({ result: await evaluateAudienceCandidate({ db, job, candidate, nowMs }) }));
  for (const { result } of evaluations) {
    const reason = result.eligible ? null : (result.reason || 'invalid_token');
    if (reason) { skipReasons[reason] = Number(skipReasons[reason] || 0) + 1; continue; }
    eligibleCount += 1;
    const claimed = await claimDeliveryAttempt(db, job, result, nowMs);
    if (!claimed.claimed) { const claimReason = claimed.reason || 'duplicate_token'; skipReasons[claimReason] = Number(skipReasons[claimReason] || 0) + 1; continue; }
    try {
      prepared.push({ recipient: result, claimed, message: buildExpoPushMessage(job, result, nowMs) });
    } catch (_error) {
      const current = claimed.attempt;
      await transitionDeliveryAttempt(db, claimed.attemptId, current, { status: 'ticket_rejected', ticketStatus: 'ticket_rejected', retryable: false, submissionLease: null, safeErrorCode: 'PAYLOAD_TOO_LARGE' }, nowMs);
      skipReasons.payload_too_large = Number(skipReasons.payload_too_large || 0) + 1;
    }
  }
  return { prepared, skipReasons, eligibleCount };
};

const sendPreparedChunks = async (db, job, prepared, expo, nowMs) => {
  for (const chunk of expo.chunkPushNotifications(prepared.map((item) => item.message))) {
    const items = chunk.map((message) => prepared.find((item) => item.message === message)).filter(Boolean);
    try {
      for (const item of items) await markRequestStarted(db, item.claimed, nowMs);
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let index = 0; index < items.length; index += 1) {
        await persistTicketResult({ db, job, claimed: items[index].claimed, recipient: items[index].recipient, ticket: tickets[index], nowMs });
      }
    } catch (error) {
      for (const item of items) await markSubmissionUnknown(db, job, item.claimed, nowMs, error);
    }
  }
};

const resolveFanoutStatus = (counts) => {
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  if (Number(counts.submissionUnknown || 0) > 0) return 'partial';
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

/** @param {{ db?: any, jobRef: any, job: any, nowMs?: number, expo?: any }} options */
// eslint-disable-next-line complexity -- page completion owns all terminal state and warning branches
const processNotificationJobPage = async ({ db = admin.database(), jobRef, job, nowMs = Date.now(), expo = getExpoPushClient() }) => {
  if (job.supersededByJobId || Number(job.expiresAtMs) <= nowMs) {
    await transitionQueuedRecord(db, { targetPath: `notification_jobs/${job.jobId}`, current: job, patch: { status: 'expired', lease: null, updatedAtMs: nowMs }, targetId: job.jobId });
    await syncNotificationSourceStatus(db, { ...job, status: 'expired' }, nowMs);
    if (job.priorityClass === 'critical') await db.ref(`notification_delivery_warnings/${job.jobId}`).update({ jobId: job.jobId, tourId: job.tourId || null, eventId: job.eventId || null, severity: 'critical', code: 'EXPIRED', status: 'open', updatedAtMs: nowMs });
    return { status: 'expired' };
  }
  const page = await loadNotificationAudiencePage(db, job.afterRecipientId);
  const { prepared, skipReasons, eligibleCount } = await prepareDeliveryPage(db, job, page.candidates, nowMs);
  const increments = { audience: page.candidates.length, eligible: eligibleCount, skipped: Object.values(skipReasons).reduce((sum, count) => sum + count, 0) };
  await sendPreparedChunks(db, job, prepared, expo, nowMs);
  await addJobCounts(db, jobRef, increments, skipReasons, nowMs);
  const refreshed = (await jobRef.once('value')).val() || job;
  if (page.nextCursor) {
    await transitionQueuedRecord(db, { targetPath: `notification_jobs/${job.jobId}`, current: refreshed, patch: { status: 'queued', afterRecipientId: page.nextCursor, availableAtMs: nowMs, lease: null, updatedAtMs: nowMs }, queueKind: 'fanout', dueAtMs: nowMs, targetId: job.jobId });
    await syncNotificationSourceStatus(db, { ...refreshed, status: 'queued', afterRecipientId: page.nextCursor }, nowMs);
    return { status: 'queued', nextCursor: page.nextCursor, increments, skipReasons };
  }
  const latest = (await jobRef.once('value')).val() || refreshed;
  const finalStatus = resolveFanoutStatus(latest.counts || {});
  const terminalAtFanout = ['no_recipients', 'ticket_rejected', 'partial'].includes(finalStatus);
  const completedAtMs = terminalAtFanout ? Number(latest.completedAtMs || nowMs) : latest.completedAtMs;
  await transitionQueuedRecord(db, { targetPath: `notification_jobs/${job.jobId}`, current: latest, patch: { status: finalStatus, afterRecipientId: null, lease: null, fanoutCompletedAtMs: nowMs, ...(completedAtMs ? { completedAtMs } : {}), updatedAtMs: nowMs }, targetId: job.jobId });
  const completed = { ...latest, status: finalStatus, afterRecipientId: null, fanoutCompletedAtMs: nowMs, ...(completedAtMs ? { completedAtMs } : {}) };
  await syncNotificationSourceStatus(db, completed, nowMs);
  if (job.priorityClass === 'critical' && ['no_recipients', 'ticket_rejected', 'partial'].includes(finalStatus)) await db.ref(`notification_delivery_warnings/${job.jobId}`).update({ jobId: job.jobId, tourId: job.tourId || null, eventId: job.eventId || null, severity: 'critical', code: finalStatus.toUpperCase(), status: 'open', updatedAtMs: nowMs });
  return { status: finalStatus, increments, skipReasons };
};

/** @param {{ db?: any, jobId: string, nowMs?: number, expo?: any, queueKey?: string, queueVersion?: number }} options */
// eslint-disable-next-line complexity -- lease recovery and durable rescheduling must remain one worker transaction boundary
const runNotificationJob = async ({ db = admin.database(), jobId, nowMs = Date.now(), expo, queueKey, queueVersion }) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  const before = (await jobRef.once('value')).val();
  if (queueKey && (!before || before.queueKey !== queueKey || Number(before.queueVersion) !== Number(queueVersion))) {
    await db.ref().update({ [`${QUEUE_ROOTS.fanout}/${queueKey}`]: null });
    return { acquired: false, status: 'stale_queue' };
  }
  const lease = await acquireNotificationJobLease({ jobRef, nowMs, ownerId: randomUUID() });
  if (!lease.acquired) {
    if (queueKey) await db.ref().update({ [`${QUEUE_ROOTS.fanout}/${queueKey}`]: null });
    if (lease.job?.status === 'expired') {
      await syncNotificationSourceStatus(db, lease.job, nowMs);
      if (lease.job.priorityClass === 'critical') await db.ref(`notification_delivery_warnings/${jobId}`).update({ jobId, tourId: lease.job.tourId || null, eventId: lease.job.eventId || null, severity: 'critical', code: 'EXPIRED', status: 'open', updatedAtMs: nowMs });
    }
    return { acquired: false, status: lease.job?.status || 'missing' };
  }
  if (lease.job.queueKey) await db.ref().update({ [`${QUEUE_ROOTS.fanout}/${lease.job.queueKey}`]: null });
  try {
    return { acquired: true, ...(await processNotificationJobPage({ db, jobRef, job: lease.job, nowMs, ...(expo ? { expo } : {}) })) };
  } catch (error) {
    const nextAttempt = Number(lease.job.attemptCount || 0) + 1;
    const expired = nextAttempt >= Number(lease.job.maxAttempts || 8) || Number(lease.job.expiresAtMs) <= nowMs;
    const dueAtMs = expired ? nowMs : nowMs + calculateRetryDelayMs(nextAttempt, lease.job.priorityClass);
    const current = (await jobRef.once('value')).val() || lease.job;
    await transitionQueuedRecord(db, { targetPath: `notification_jobs/${jobId}`, current, patch: { status: expired ? 'expired' : 'queued', attemptCount: nextAttempt, availableAtMs: dueAtMs, lease: null, lastErrorCode: String(error?.code || 'WORKER_FAILED').slice(0, 80), updatedAtMs: nowMs }, queueKind: expired ? null : 'fanout', dueAtMs, targetId: jobId });
    const latest = (await jobRef.once('value')).val();
    if (latest) await syncNotificationSourceStatus(db, latest, nowMs);
    if (expired && lease.job.priorityClass === 'critical') await db.ref(`notification_delivery_warnings/${jobId}`).update({ jobId, tourId: lease.job.tourId || null, eventId: lease.job.eventId || null, severity: 'critical', code: 'EXPIRED', status: 'open', updatedAtMs: nowMs });
    log.error('Notification job page failed', error, { jobId });
    return { acquired: true, status: expired ? 'expired' : 'queued' };
  }
};

const processNotificationDeliveryJob = onValueWritten({
  ref: '/notification_job_fanout_queue/{queueKey}', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 20,
}, async (event) => {
  const entry = event.data.after.val();
  if (!entry || Number(entry.dueAtMs || 0) > Date.now()) return null;
  const claimed = await claimQueueEntry(event.data.after.ref, Date.now());
  if (!claimed.claimed) return null;
  return runNotificationJob({ jobId: entry.targetId, queueKey: event.params.queueKey, queueVersion: entry.version });
});

const recoverNotificationDeliveryJobs = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/London', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 1 }, async () => {
  const db = admin.database(); const nowMs = Date.now();
  const due = await loadDueQueueEntries(db, 'fanout', nowMs, 25);
  let processed = 0;
  await mapWithConcurrency(due, 5, async ([queueKey, entry]) => {
    const claimed = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.fanout}/${queueKey}`), nowMs);
    if (!claimed.claimed) return;
    processed += 1;
    await runNotificationJob({ db, jobId: entry.targetId, nowMs, queueKey, queueVersion: entry.version });
  });
  return { scanned: due.length, processed };
});

module.exports = {
  MAX_EXPO_PAYLOAD_BYTES, RECEIPT_DUE_DELAY_MS, buildAttemptCountDeltaUpdates,
  buildDeliveryAttemptId, buildExpoPushMessage, claimDeliveryAttempt, mapWithConcurrency,
  markSubmissionUnknown, persistTicketResult, processNotificationDeliveryJob,
  processNotificationJobPage, recoverNotificationDeliveryJobs, retryNotificationDeliveryAttempt,
  runNotificationJob, transitionDeliveryAttempt,
};
