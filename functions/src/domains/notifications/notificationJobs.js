'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { buildDeliveryGrouping, getNotificationDeliveryPolicy } = require('./notificationDeliveryPolicy');

const JOB_SCHEMA_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_DATA_BYTES = 3072;
const MAX_ATTEMPTS = 8;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const COUNTS = Object.freeze({
  audience: 0,
  eligible: 0,
  skipped: 0,
  ticketAccepted: 0,
  ticketRejected: 0,
  receiptAccepted: 0,
  receiptRejected: 0,
  receiptPending: 0,
});

/** @param {unknown} value @param {number} maxLength */
const boundedString = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
};

/** @param {unknown} value */
const assertSafeData = (value) => {
  const serialized = JSON.stringify(value || {});
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
    throw new Error('Notification navigation payload is too large');
  }
  const forbidden = /"(?:pushToken|token|bookingRef|email|phone|customMessage|signedUrl|imageUrl|sourceUrl)"\s*:/iu;
  if (forbidden.test(serialized)) throw new Error('Notification job contains a forbidden field');
  return JSON.parse(serialized);
};

/** @param {string} sourceType @param {string} sourceId */
const buildNotificationJobId = (sourceType, sourceId) => {
  const type = boundedString(sourceType, 80);
  const id = boundedString(sourceId, 768);
  if (!type || !id) throw new Error('Notification source identity is required');
  return `notif_v1_${createHash('sha256').update(`${type}\u0000${id}`).digest('hex')}`;
};

/** @param {string} value */
const safeCoalescingKey = (value) => {
  const normalized = boundedString(value, 500);
  if (!normalized) return null;
  return `coal_v1_${createHash('sha256').update(normalized).digest('hex')}`;
};

const resolveJobInput = (input, nowMs) => {
  const sourceType = boundedString(input?.sourceType, 80);
  const sourceId = boundedString(input?.sourceId, 768);
  const notificationType = boundedString(input?.notificationType, 80);
  const policy = getNotificationDeliveryPolicy(notificationType);
  const title = boundedString(input?.presentation?.title, MAX_TITLE_LENGTH);
  const body = boundedString(input?.presentation?.body, MAX_BODY_LENGTH);
  const expiresAtMs = Number.isSafeInteger(input?.expiresAtMs) ? input.expiresAtMs : nowMs + policy.ttlMs;
  if (!title || !body) throw new Error('Notification presentation is required');
  if (expiresAtMs <= nowMs) throw new Error('Notification job must expire in the future');
  return { sourceType, sourceId, notificationType, policy, title, body, expiresAtMs };
};
const resolveJobScope = (input) => ({
  tourId: boundedString(input?.tourId, 160) || null, categoryKey: boundedString(input?.categoryKey, 80) || null,
  departureKey: boundedString(input?.departureKey, 180) || null, eventId: boundedString(input?.eventId, 160) || null,
  targetInstallationUid: boundedString(input?.targetInstallationUid, 160) || null, senderAuthUid: boundedString(input?.senderAuthUid, 160) || null,
});
const buildJobDeliveryPolicy = (policy, grouping) => ({ channelId: policy.channelId, priority: policy.priority, sound: policy.sound, interruptionLevel: policy.interruptionLevel, lockScreenPreviewPolicy: policy.lockScreenPreviewPolicy, mayCoalesce: policy.mayCoalesce, ttlMs: policy.ttlMs, collapseId: grouping.collapseId, androidTag: grouping.androidTag, iosThreadId: grouping.iosThreadId, requiresActiveSession: policy.requiresActiveSession, bypassesOptionalPreferences: policy.bypassesOptionalPreferences });

/** @param {any} input */
const createNotificationJobRecord = (input) => {
  const nowMs = Number.isSafeInteger(input?.nowMs) ? input.nowMs : Date.now();
  const { sourceType, sourceId, notificationType, policy, title, body, expiresAtMs } = resolveJobInput(input, nowMs);
  const jobId = buildNotificationJobId(sourceType, sourceId);
  const { tourId, categoryKey, departureKey, eventId, targetInstallationUid, senderAuthUid } = resolveJobScope(input);
  const coalescingKey = safeCoalescingKey(input?.coalescingKey || '');
  const grouping = buildDeliveryGrouping(notificationType, {
    tourId, categoryKey, departureKey, eventId,
  });

  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    notificationType,
    sourceType,
    sourceId,
    audienceType: boundedString(input?.audienceType, 80),
    tourId,
    categoryKey,
    departureKey,
    eventId,
    targetInstallationUid,
    senderAuthUid,
    senderPrincipalId: boundedString(input?.senderPrincipalId, 160) || null,
    allowedDriverIds: Array.isArray(input?.allowedDriverIds)
      ? input.allowedDriverIds.map((value) => boundedString(value, 160)).filter(Boolean).slice(0, 500)
      : null,
    status: 'queued',
    priorityClass: policy.retryClass,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    availableAtMs: nowMs,
    expiresAtMs,
    attemptCount: 0,
    maxAttempts: Number.isSafeInteger(input?.maxAttempts) ? input.maxAttempts : MAX_ATTEMPTS,
    afterRecipientId: null,
    supersededByJobId: null,
    coalescingKey,
    presentation: { title, body },
    navigation: assertSafeData(input?.navigation),
    deliveryPolicy: buildJobDeliveryPolicy(policy, grouping),
    counts: { ...COUNTS },
    skipReasons: {},
  };
};

/** @param {{ db?: any, job: any }} options */
const enqueueNotificationJob = async ({ db = admin.database(), job }) => {
  if (!job || !isValidFirebaseKey(job.jobId)) throw new Error('Invalid notification job');
  const jobRef = db.ref(`notification_jobs/${job.jobId}`);
  let created = false;
  const result = await jobRef.transaction((current) => {
    if (current) return;
    created = true;
    return job;
  });
  created = Boolean(created && result?.committed);

  if (created && job.coalescingKey) {
    const stateRef = db.ref(`notification_job_coalescing/${job.coalescingKey}`);
    let previousJobId = null;
    await stateRef.transaction((current) => {
      previousJobId = current?.jobId || null;
      return { jobId: job.jobId, updatedAtMs: job.createdAtMs };
    });
    if (previousJobId && previousJobId !== job.jobId && isValidFirebaseKey(previousJobId)) {
      await db.ref(`notification_jobs/${previousJobId}`).transaction((previous) => {
        if (!previous || ['provider_accepted', 'provider_rejected', 'partial', 'expired', 'no_recipients'].includes(previous.status)) {
          return previous;
        }
        return {
          ...previous,
          status: 'expired',
          supersededByJobId: job.jobId,
          updatedAtMs: job.createdAtMs,
          lease: null,
        };
      });
    }
  }

  return { created, jobId: job.jobId, job: result?.snapshot?.val?.() || job };
};

/** @param {{ jobRef: any, nowMs?: number, ownerId?: string, leaseMs?: number }} options */
const acquireNotificationJobLease = async ({
  jobRef,
  nowMs = Date.now(),
  ownerId = randomUUID(),
  leaseMs = DEFAULT_LEASE_MS,
}) => {
  let acquired = false;
  const transaction = await jobRef.transaction((job) => {
    if (!job || !['queued', 'retrying', 'fanout_in_progress'].includes(job.status)) return;
    if (Number(job.expiresAtMs) <= nowMs || job.supersededByJobId) {
      return { ...job, status: 'expired', lease: null, updatedAtMs: nowMs };
    }
    if (Number(job.availableAtMs || 0) > nowMs) return;
    if (job.lease && Number(job.lease.expiresAtMs) > nowMs && job.lease.ownerId !== ownerId) return;
    acquired = true;
    return {
      ...job,
      status: 'fanout_in_progress',
      updatedAtMs: nowMs,
      lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs },
    };
  });
  const job = transaction?.snapshot?.val?.() || null;
  return { acquired: Boolean(acquired && job?.lease?.ownerId === ownerId), ownerId, job };
};

const calculateRetryDelayMs = (attemptCount, priorityClass = 'standard') => {
  const baseMs = priorityClass === 'critical' ? 10_000 : 30_000;
  return Math.min(30 * 60 * 1000, baseMs * (2 ** Math.max(0, Math.min(10, attemptCount - 1))));
};

module.exports = {
  DEFAULT_LEASE_MS,
  JOB_SCHEMA_VERSION,
  MAX_ATTEMPTS,
  acquireNotificationJobLease,
  assertSafeData,
  buildNotificationJobId,
  calculateRetryDelayMs,
  createNotificationJobRecord,
  enqueueNotificationJob,
  safeCoalescingKey,
};
