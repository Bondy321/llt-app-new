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
const { buildAttemptCountDeltaUpdates } = require('./notificationAttemptCounts');
const { classifyExpoRequestError } = require('./expoRequestErrorClassifier');
const { finalizeCompletedFanout, publishCriticalFanoutWarning } = require('./notificationFanoutFinalization');
const { TERMINAL_NOTIFICATION_JOB_STATUSES } = require('./notificationJobStatus');
const {
  QUEUE_ROOTS,
  claimQueueEntry,
  loadDueQueueEntries,
  releaseClaimedQueueEntry,
  removeClaimedQueueEntry,
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

/** @param {string} jobId @param {string | null | undefined} afterRecipientId */
const buildAudiencePageId = (jobId, afterRecipientId) => `page_v1_${createHash('sha256')
  .update(`${jobId}\u0000${afterRecipientId || 'START'}`)
  .digest('hex')}`;

/** @param {string} jobId @param {string} authUid @param {number} generation */
const buildDeliveryAttemptId = (jobId, authUid, generation = 1) => `attempt_v2_${createHash('sha256')
  .update(`${jobId}\u0000${authUid}\u0000${generation}`)
  .digest('hex')}`;

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
// eslint-disable-next-line complexity -- exact attempt/token idempotency handles every recoverable crash window
const claimDeliveryAttempt = async (db, job, recipient, nowMs, generation = 1) => {
  const attemptId = buildDeliveryAttemptId(job.jobId, recipient.authUid, generation);
  const recipientRef = db.ref(`notification_job_recipients/${job.jobId}/${recipient.authUid}`);
  const existingRecipient = (await recipientRef.once('value')).val();
  if (existingRecipient) {
    const existingAttempt = existingRecipient.attemptId
      ? (await db.ref(`notification_delivery_attempts/${existingRecipient.attemptId}`).once('value')).val()
      : null;
    const represented = Boolean(existingAttempt && existingAttempt.jobId === job.jobId);
    return {
      claimed: false,
      represented,
      reason: represented ? 'already_represented' : 'invalid_attempt',
      attemptId: existingRecipient.attemptId || null,
      attempt: existingAttempt,
    };
  }
  const tokenClaimRef = db.ref(`notification_job_token_claims/${job.jobId}/${recipient.tokenHash}`);
  const tokenClaim = await tokenClaimRef.transaction((current) => current || recipient.authUid);
  if (tokenClaim.snapshot.val() !== recipient.authUid) return { claimed: false, represented: false, reason: 'duplicate_token' };
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
    queueKind: null, queueKey: null, queueVersion: 0, countsPublished: false,
  };
  const transaction = await attemptRef.transaction((current) => current || attempt);
  let persisted = transaction?.snapshot?.val?.() || null;
  const claimed = persisted?.submissionLease?.ownerId === leaseOwnerId;
  if (persisted?.status === 'prepared' && (!persisted.queueKey || persisted.queueKind !== 'retry' || persisted.countsPublished !== true)) {
    const queue = await transitionQueuedRecord(db, {
      targetPath: `notification_delivery_attempts/${attemptId}`,
      current: persisted,
      patch: { countsPublished: true },
      queueKind: 'retry',
      dueAtMs: persisted.submissionLease.expiresAtMs,
      targetId: attemptId,
      additionalUpdates: persisted.countsPublished === true
        ? {}
        : buildAttemptCountDeltaUpdates(job.jobId, null, { ...persisted, countsPublished: true }),
    });
    persisted = { ...persisted, countsPublished: true, queueKind: 'retry', queueKey: queue.queueKey, queueVersion: queue.queueVersion };
  }
  await recipientRef.transaction((current) => current || {
    generation, attemptId, tokenHash: recipient.tokenHash, status: 'claimed', updatedAtMs: nowMs,
  });
  return { claimed, represented: Boolean(persisted), attemptId, attemptRef, attempt: persisted };
};

/**
 * Commits one deterministic audience page exactly once. Counts, cursor and
 * terminal state advance in the same transaction, so every crash boundary can
 * safely replay the page without adding its partition twice.
 * @param {any} jobRef
 * @param {any} input
 */
const commitNotificationAudiencePage = async (jobRef, {
  pageId, expectedCursor, nextCursor, increments, skipReasons, nowMs, leaseOwnerId = null,
}) => {
  let committed = false;
  // eslint-disable-next-line complexity -- one transaction owns the complete page state machine
  const transaction = await jobRef.transaction((current) => {
    if (!current) return;
    if ((current.afterRecipientId || null) !== (expectedCursor || null)) return;
    if (current.lastCommittedPageId === pageId) return;
    if (leaseOwnerId && current.lease?.ownerId !== leaseOwnerId) return;
    const counts = { ...(current.counts || {}) };
    Object.entries(increments).forEach(([key, value]) => {
      counts[key] = Number(counts[key] || 0) + Number(value || 0);
    });
    const reasons = { ...(current.skipReasons || {}) };
    Object.entries(skipReasons).forEach(([key, value]) => {
      reasons[key] = Number(reasons[key] || 0) + Number(value || 0);
    });
    const status = nextCursor ? 'queued' : resolveFanoutStatus(counts);
    const terminal = TERMINAL_NOTIFICATION_JOB_STATUSES.has(status);
    committed = true;
    return {
      ...current,
      counts,
      skipReasons: reasons,
      status,
      afterRecipientId: nextCursor || null,
      availableAtMs: nextCursor ? nowMs : current.availableAtMs,
      lease: null,
      lastCommittedPageId: pageId,
      pageSequence: Number(current.pageSequence || 0) + 1,
      ...(nextCursor ? {} : { fanoutCompletedAtMs: Number(current.fanoutCompletedAtMs || nowMs) }),
      ...(terminal ? { completedAtMs: Number(current.completedAtMs || nowMs) } : {}),
      updatedAtMs: nowMs,
    };
  });
  return { committed: Boolean(committed && transaction?.committed), job: transaction?.snapshot?.val?.() || null };
};

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
  if (!current || current.status !== 'request_started') return { transitioned: false };
  await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
    status: 'submission_unknown', ticketStatus: 'submission_unknown', receiptStatus: 'not_requested',
    retryable: false, submissionLease: null, safeErrorCode: 'SUBMISSION_UNKNOWN',
  }, nowMs);
  await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
    jobId: job.jobId, severity: job.priorityClass === 'critical' ? 'critical' : 'warning',
    code: 'SUBMISSION_UNKNOWN', status: 'open', updatedAtMs: nowMs,
  });
  log.error('Notification submission outcome is unknown; automatic resend suppressed', error, { jobId: job.jobId, attemptId: claimed.attemptId });
  return { transitioned: true };
};

/** @param {any} db @param {any} job @param {any} claimed @param {number} nowMs @param {any} error */
// eslint-disable-next-line complexity -- classifier outcomes intentionally remain explicit and fail closed
const handleExpoRequestFailure = async (db, job, claimed, nowMs, error) => {
  const classification = classifyExpoRequestError(error);
  if (classification.outcome === 'unknown') {
    await markSubmissionUnknown(db, job, claimed, nowMs, error);
    return classification;
  }
  const current = (await claimed.attemptRef.once('value')).val() || claimed.attempt;
  if (!current || current.status !== 'request_started') return { ...classification, transitioned: false };
  const maxAttempts = Number(job.maxAttempts || 8);
  const exhausted = classification.outcome === 'retryable'
    && Number(current.attemptNumber || 1) >= maxAttempts;
  const retryable = classification.outcome === 'retryable' && !exhausted;
  const safeErrorCode = exhausted ? 'REQUEST_RETRY_EXHAUSTED' : classification.safeErrorCode;
  await transitionDeliveryAttempt(db, claimed.attemptId || current.attemptId, current, {
    status: retryable ? 'retrying' : 'ticket_rejected',
    ticketStatus: 'ticket_rejected',
    receiptStatus: 'not_requested',
    retryable,
    availableAtMs: retryable
      ? nowMs + calculateRetryDelayMs(Number(current.attemptNumber || 1), job.priorityClass)
      : nowMs,
    submissionLease: null,
    retryLease: null,
    safeErrorCode,
  }, nowMs);
  if (classification.configuration) {
    await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
      jobId: job.jobId, severity: 'critical', code: 'INVALID_CREDENTIALS', status: 'open', updatedAtMs: nowMs,
    });
  } else if (classification.outcome === 'retryable' && job.priorityClass === 'critical') {
    await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
      jobId: job.jobId, tourId: job.tourId || null, eventId: job.eventId || null,
      severity: 'critical', code: safeErrorCode, status: 'open', updatedAtMs: nowMs,
    });
  }
  return { ...classification, exhausted, retryable, transitioned: true };
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
  let tickets;
  try {
    tickets = await expo.sendPushNotificationsAsync([message]);
  } catch (error) {
    const classified = await handleExpoRequestFailure(db, job, { attemptRef, attemptId, attempt: sending }, nowMs, error);
    return { success: false, reason: classified.outcome === 'unknown' ? 'SUBMISSION_UNKNOWN' : classified.safeErrorCode };
  }
  await persistTicketResult({ db, job, claimed: { attemptRef, attemptId, attempt: sending }, recipient, ticket: tickets[0], nowMs });
  return { success: true };
};

/** @param {any} db @param {string} jobId @param {string} authUid @param {string} pageId */
const claimAudienceCandidate = async (db, jobId, authUid, pageId) => {
  const claim = await db.ref(`notification_job_audience_claims/${jobId}/${authUid}`).transaction((current) => current || pageId);
  return claim?.snapshot?.val?.() === pageId;
};

const prepareDeliveryPage = async (db, job, candidates, pageId, nowMs) => {
  const skipReasons = {}; const prepared = []; let eligibleCount = 0; let audienceCount = 0;
  const uniqueCandidates = [];
  for (const candidate of candidates) {
    if (await claimAudienceCandidate(db, job.jobId, candidate.authUid, pageId)) uniqueCandidates.push(candidate);
  }
  audienceCount = uniqueCandidates.length;
  const evaluations = await mapWithConcurrency(uniqueCandidates, MAX_CONCURRENCY, async (candidate) => ({ result: await evaluateAudienceCandidate({ db, job, candidate, nowMs }) }));
  for (const { result } of evaluations) {
    const reason = result.eligible ? null : (result.reason || 'invalid_token');
    if (reason) { skipReasons[reason] = Number(skipReasons[reason] || 0) + 1; continue; }
    const claimed = await claimDeliveryAttempt(db, job, result, nowMs);
    if (!claimed.claimed && !claimed.represented) {
      const claimReason = claimed.reason || 'duplicate_token';
      skipReasons[claimReason] = Number(skipReasons[claimReason] || 0) + 1;
      continue;
    }
    eligibleCount += 1;
    if (!claimed.claimed) continue;
    try {
      prepared.push({ recipient: result, claimed, message: buildExpoPushMessage(job, result, nowMs) });
    } catch (_error) {
      const current = claimed.attempt;
      await transitionDeliveryAttempt(db, claimed.attemptId, current, { status: 'ticket_rejected', ticketStatus: 'ticket_rejected', retryable: false, submissionLease: null, safeErrorCode: 'PAYLOAD_TOO_LARGE' }, nowMs);
    }
  }
  return { prepared, skipReasons, eligibleCount, audienceCount };
};

const sendPreparedChunks = async (db, job, prepared, expo, nowMs) => {
  for (const chunk of expo.chunkPushNotifications(prepared.map((item) => item.message))) {
    const items = chunk.map((message) => prepared.find((item) => item.message === message)).filter(Boolean);
    // A local persistence failure happens before the provider request and must
    // bubble to page recovery rather than being labelled submission-unknown.
    for (const item of items) await markRequestStarted(db, item.claimed, nowMs);
    let tickets;
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      for (const item of items) await handleExpoRequestFailure(db, job, item.claimed, nowMs, error);
      continue;
    }
    // Ticket persistence is intentionally outside the provider-request catch.
    // A later database error cannot rewrite an already accepted ticket as an
    // ambiguous provider submission.
    for (let index = 0; index < items.length; index += 1) {
      await persistTicketResult({ db, job, claimed: items[index].claimed, recipient: items[index].recipient, ticket: tickets[index], nowMs });
    }
  }
};

const resolveFanoutStatus = (counts) => {
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  if (Number(counts.submissionUnknown || 0) > 0) {
    const known = Number(counts.ticketAccepted || 0) + Number(counts.ticketRejected || 0)
      + Number(counts.receiptAccepted || 0) + Number(counts.receiptRejected || 0);
    return known > 0 ? 'partial' : 'submission_unknown';
  }
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

/** @param {{ db?: any, jobRef: any, job: any, nowMs?: number, expo?: any, leaseOwnerId?: string | null, syncSourceStatus?: Function, publishCriticalWarning?: Function }} options */
const processNotificationJobPage = async ({ db = admin.database(), jobRef, job, nowMs = Date.now(), expo = getExpoPushClient(), leaseOwnerId = null, syncSourceStatus = syncNotificationSourceStatus, publishCriticalWarning = publishCriticalFanoutWarning }) => {
  if (job.supersededByJobId || Number(job.expiresAtMs) <= nowMs) {
    const completedAtMs = Number(job.completedAtMs || nowMs);
    await transitionQueuedRecord(db, { targetPath: `notification_jobs/${job.jobId}`, current: job, patch: { status: 'expired', lease: null, completedAtMs, updatedAtMs: nowMs }, targetId: job.jobId });
    await finalizeCompletedFanout(db, { ...job, status: 'expired', completedAtMs }, nowMs, syncSourceStatus, publishCriticalWarning);
    return { status: 'expired', fanoutComplete: true };
  }
  const expectedCursor = job.afterRecipientId || null;
  const pageId = buildAudiencePageId(job.jobId, expectedCursor);
  const page = await loadNotificationAudiencePage(db, expectedCursor);
  const { prepared, skipReasons, eligibleCount, audienceCount } = await prepareDeliveryPage(db, job, page.candidates, pageId, nowMs);
  const increments = { audience: audienceCount, eligible: eligibleCount, skipped: Object.values(skipReasons).reduce((sum, count) => sum + count, 0) };
  await sendPreparedChunks(db, job, prepared, expo, nowMs);
  const committed = await commitNotificationAudiencePage(jobRef, {
    pageId, expectedCursor, nextCursor: page.nextCursor, increments, skipReasons, nowMs, leaseOwnerId,
  });
  const latest = committed.job || (await jobRef.once('value')).val() || job;
  if (!committed.committed) return { status: latest.status, fanoutComplete: Boolean(latest.fanoutCompletedAtMs), replayed: true, increments: {}, skipReasons: {} };
  if (page.nextCursor) {
    await syncSourceStatus(db, latest, nowMs);
    return { status: 'queued', fanoutComplete: false, nextCursor: page.nextCursor, increments, skipReasons };
  }
  await finalizeCompletedFanout(db, latest, nowMs, syncSourceStatus, publishCriticalWarning);
  return { status: latest.status, fanoutComplete: true, increments, skipReasons };
};

/** @param {any} jobRef @param {string} queueKey */
const clearCompletedFanoutPointer = (jobRef, queueKey) => jobRef.transaction((current) => {
  if (!current || current.queueKey !== queueKey || !current.fanoutCompletedAtMs) return;
  return { ...current, queueKind: null, queueKey: null, queueVersion: Number(current.queueVersion || 0) + 1 };
});

/** @param {{ db?: any, jobId: string, nowMs?: number, expo?: any, queueKey?: string, queueVersion?: number, queueOwnerId?: string, queueLeaseExpiresAtMs?: number, syncSourceStatus?: Function, publishCriticalWarning?: Function }} options */
// eslint-disable-next-line complexity -- lease recovery and durable rescheduling must remain one worker transaction boundary
const runNotificationJob = async ({ db = admin.database(), jobId, nowMs = Date.now(), expo, queueKey, queueVersion, queueOwnerId, queueLeaseExpiresAtMs, syncSourceStatus = syncNotificationSourceStatus, publishCriticalWarning = publishCriticalFanoutWarning }) => {
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  const queueRef = queueKey ? db.ref(`${QUEUE_ROOTS.fanout}/${queueKey}`) : null;
  const before = (await jobRef.once('value')).val();
  if (queueKey && (!before || before.queueKey !== queueKey || Number(before.queueVersion) !== Number(queueVersion))) {
    if (queueOwnerId) await removeClaimedQueueEntry(queueRef, queueOwnerId);
    return { acquired: false, status: 'stale_queue' };
  }
  const leaseOwnerId = queueOwnerId || randomUUID();
  const lease = await acquireNotificationJobLease({
    jobRef,
    nowMs,
    ownerId: leaseOwnerId,
    ...(queueLeaseExpiresAtMs ? { leaseExpiresAtMs: queueLeaseExpiresAtMs } : {}),
  });
  if (!lease.acquired) {
    if (lease.job?.fanoutCompletedAtMs && (!queueKey || lease.job.queueKey === queueKey)) {
      try {
        await finalizeCompletedFanout(db, lease.job, nowMs, syncSourceStatus, publishCriticalWarning);
        if (queueRef && queueOwnerId) await removeClaimedQueueEntry(queueRef, queueOwnerId);
        if (queueKey) await clearCompletedFanoutPointer(jobRef, queueKey);
        return { acquired: false, status: lease.job.status, fanoutComplete: true };
      } catch (error) {
        if (queueRef && queueOwnerId) await releaseClaimedQueueEntry(queueRef, queueOwnerId, nowMs);
        log.error('Notification source status publication retry failed after fanout completion', error, { jobId });
        return { acquired: false, status: lease.job.status, fanoutComplete: true, sourceStatusPending: true };
      }
    }
    const terminal = lease.job && (TERMINAL_NOTIFICATION_JOB_STATUSES.has(lease.job.status)
      || lease.job.supersededByJobId || Number(lease.job.expiresAtMs || 0) <= nowMs);
    if (terminal) {
      await finalizeCompletedFanout(db, lease.job, nowMs, syncSourceStatus, publishCriticalWarning);
      if (queueRef && queueOwnerId) await removeClaimedQueueEntry(queueRef, queueOwnerId);
      if (queueKey) await clearCompletedFanoutPointer(jobRef, queueKey);
    } else if (queueRef && queueOwnerId && lease.job?.lease?.expiresAtMs) {
      // A competing live worker still owns the page. Keep the only recovery
      // pointer and make it claimable at that exact job-lease boundary.
      await releaseClaimedQueueEntry(queueRef, queueOwnerId, Number(lease.job.lease.expiresAtMs));
    } else if (queueRef && queueOwnerId && Number(lease.job?.availableAtMs || 0) > nowMs) {
      await transitionQueuedRecord(db, {
        targetPath: `notification_jobs/${jobId}`, current: lease.job, patch: {},
        queueKind: 'fanout', dueAtMs: Number(lease.job.availableAtMs), targetId: jobId,
      });
    } else if (queueRef && queueOwnerId) {
      await removeClaimedQueueEntry(queueRef, queueOwnerId);
    }
    return { acquired: false, status: lease.job?.status || 'missing' };
  }
  try {
    const result = await processNotificationJobPage({ db, jobRef, job: lease.job, nowMs, leaseOwnerId, syncSourceStatus, publishCriticalWarning, ...(expo ? { expo } : {}) });
    if (queueRef && queueOwnerId) {
      if (result.fanoutComplete) {
        await removeClaimedQueueEntry(queueRef, queueOwnerId);
        await clearCompletedFanoutPointer(jobRef, queueKey);
      } else if (result.status === 'queued') await releaseClaimedQueueEntry(queueRef, queueOwnerId, nowMs);
    }
    return { acquired: true, ...result };
  } catch (error) {
    const observed = (await jobRef.once('value')).val() || lease.job;
    if (observed.fanoutCompletedAtMs || TERMINAL_NOTIFICATION_JOB_STATUSES.has(observed.status)) {
      if (queueRef && queueOwnerId) await releaseClaimedQueueEntry(queueRef, queueOwnerId, nowMs);
      log.error('Notification source status publication failed after fanout completion', error, { jobId });
      return { acquired: true, status: observed.status, sourceStatusPending: true };
    }
    if ((observed.afterRecipientId || null) !== (lease.job.afterRecipientId || null)
      || observed.lastCommittedPageId !== lease.job.lastCommittedPageId) {
      if (queueRef && queueOwnerId) await releaseClaimedQueueEntry(queueRef, queueOwnerId, nowMs);
      log.error('Notification source status publication failed after page commit', error, { jobId });
      return { acquired: true, status: observed.status, sourceStatusPending: true };
    }
    const nextAttempt = Number(lease.job.attemptCount || 0) + 1;
    const expired = nextAttempt >= Number(lease.job.maxAttempts || 8) || Number(lease.job.expiresAtMs) <= nowMs;
    const dueAtMs = expired ? nowMs : nowMs + calculateRetryDelayMs(nextAttempt, lease.job.priorityClass);
    if (queueRef && queueOwnerId) {
      await jobRef.transaction((current) => {
        if (!current || current.lease?.ownerId !== leaseOwnerId) return;
        return {
          ...current,
          status: expired ? 'expired' : 'queued',
          attemptCount: nextAttempt,
          availableAtMs: dueAtMs,
          lease: null,
          ...(expired ? { completedAtMs: Number(current.completedAtMs || nowMs) } : {}),
          lastErrorCode: String(error?.code || 'WORKER_FAILED').slice(0, 80),
          updatedAtMs: nowMs,
        };
      });
      if (expired) {
        const terminalJob = (await jobRef.once('value')).val() || observed;
        await finalizeCompletedFanout(db, terminalJob, nowMs, syncSourceStatus, publishCriticalWarning);
        await removeClaimedQueueEntry(queueRef, queueOwnerId);
        await clearCompletedFanoutPointer(jobRef, queueKey);
      } else {
        const queuedJob = (await jobRef.once('value')).val() || observed;
        await transitionQueuedRecord(db, {
          targetPath: `notification_jobs/${jobId}`, current: queuedJob, patch: {},
          queueKind: 'fanout', dueAtMs, targetId: jobId,
        });
      }
    } else {
      const current = (await jobRef.once('value')).val() || lease.job;
      await transitionQueuedRecord(db, { targetPath: `notification_jobs/${jobId}`, current, patch: { status: expired ? 'expired' : 'queued', attemptCount: nextAttempt, availableAtMs: dueAtMs, lease: null, ...(expired ? { completedAtMs: Number(current.completedAtMs || nowMs) } : {}), lastErrorCode: String(error?.code || 'WORKER_FAILED').slice(0, 80), updatedAtMs: nowMs }, queueKind: expired ? null : 'fanout', dueAtMs, targetId: jobId });
    }
    const latest = (await jobRef.once('value')).val();
    if (latest) await syncSourceStatus(db, latest, nowMs);
    if (expired && lease.job.priorityClass === 'critical') await db.ref(`notification_delivery_warnings/${jobId}`).update({ jobId, tourId: lease.job.tourId || null, eventId: lease.job.eventId || null, severity: 'critical', code: 'EXPIRED', status: 'open', updatedAtMs: nowMs });
    log.error('Notification job page failed', error, { jobId });
    return { acquired: true, status: expired ? 'expired' : 'queued' };
  }
};

const processNotificationDeliveryJob = onValueWritten({
  ref: '/notification_job_fanout_queue/{queueKey}', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 20, timeoutSeconds: 90,
}, async (event) => {
  const nowMs = Date.now();
  const entry = event.data.after.val();
  if (!entry || Number(entry.dueAtMs || 0) > nowMs) return null;
  const claimed = await claimQueueEntry(event.data.after.ref, nowMs);
  if (!claimed.claimed) return null;
  return runNotificationJob({
    jobId: claimed.entry.targetId,
    nowMs,
    queueKey: event.params.queueKey,
    queueVersion: claimed.entry.version,
    queueOwnerId: claimed.ownerId,
    queueLeaseExpiresAtMs: claimed.entry.lease.expiresAtMs,
  });
});

const recoverNotificationDeliveryJobs = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/London', region: 'europe-west1', secrets: [expoAccessTokenSecret], maxInstances: 1, timeoutSeconds: 90 }, async () => {
  const db = admin.database(); const nowMs = Date.now();
  const due = await loadDueQueueEntries(db, 'fanout', nowMs, 25);
  let processed = 0;
  await mapWithConcurrency(due, 5, async ([queueKey]) => {
    const claimed = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.fanout}/${queueKey}`), nowMs);
    if (!claimed.claimed) return;
    processed += 1;
    await runNotificationJob({ db, jobId: claimed.entry.targetId, nowMs, queueKey, queueVersion: claimed.entry.version, queueOwnerId: claimed.ownerId, queueLeaseExpiresAtMs: claimed.entry.lease.expiresAtMs });
  });
  return { scanned: due.length, processed };
});

module.exports = {
  MAX_EXPO_PAYLOAD_BYTES, RECEIPT_DUE_DELAY_MS, buildAttemptCountDeltaUpdates,
  buildAudiencePageId, buildDeliveryAttemptId, buildExpoPushMessage, claimAudienceCandidate,
  claimDeliveryAttempt, commitNotificationAudiencePage, handleExpoRequestFailure, mapWithConcurrency,
  markSubmissionUnknown, persistTicketResult, prepareDeliveryPage, processNotificationDeliveryJob,
  processNotificationJobPage, recoverNotificationDeliveryJobs, retryNotificationDeliveryAttempt,
  runNotificationJob, sendPreparedChunks, transitionDeliveryAttempt,
};
