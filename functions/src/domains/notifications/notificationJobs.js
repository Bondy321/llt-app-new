'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { buildDeliveryGrouping, getNotificationDeliveryPolicy } = require('./notificationDeliveryPolicy');
const { isTerminalNotificationJobStatus } = require('./notificationJobStatus');
const {
  isNotificationLifecycleRetentionFenced,
  scheduleNotificationRetentionIfEligible,
} = require('./notificationRetentionIntegration');
const { buildNotificationQueueKey, buildQueueEntry, QUEUE_ROOTS, transitionQueuedRecord } = require('./notificationQueues');

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

const ensureNotificationFanoutQueue = async (db, job) => {
  if (job?.status !== 'queued' || job.queueKind !== 'fanout'
    || !isValidFirebaseKey(job.jobId) || !isValidFirebaseKey(job.queueKey)
    || !Number.isSafeInteger(job.queueVersion) || job.queueVersion < 1) return false;
  await db.ref(`${QUEUE_ROOTS.fanout}/${job.queueKey}`).transaction((current) => current || (
    buildQueueEntry('fanout', job.jobId, Number(job.availableAtMs || job.createdAtMs), job.queueVersion)
  ));
  return true;
};

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
    sourceOrderMs: Number.isSafeInteger(input?.sourceOrderMs) ? input.sourceOrderMs : nowMs,
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

/** @param {{ db?: any, job: any, afterCoalescingPublished?: Function }} options */
// eslint-disable-next-line complexity -- idempotency, coalescing and activation form one durable handoff
const enqueueNotificationJob = async ({ db = admin.database(), job, afterCoalescingPublished }) => {
  if (!job || !isValidFirebaseKey(job.jobId)) throw new Error('Invalid notification job');
  const jobRef = db.ref(`notification_jobs/${job.jobId}`);
  let created = false;
  const result = await jobRef.transaction((current) => {
    if (current) return;
    created = true;
    return { ...job, status: 'preparing', queueKind: null, queueKey: null, queueVersion: 0 };
  });
  created = Boolean(created && result?.committed);

  let supersededByJobId = null;
  let supersedesJobId = null;
  if (job.coalescingKey) {
    const stateRef = db.ref(`notification_job_coalescing/${job.coalescingKey}`);
    // eslint-disable-next-line complexity -- total ordering must handle legacy and current coalescing records
    await stateRef.transaction((current) => {
      const currentOrder = Number(current?.sourceOrderMs || current?.updatedAtMs || 0);
      const nextOrder = Number(job.sourceOrderMs || job.createdAtMs || 0);
      const currentTie = String(current?.sourceId || current?.jobId || '');
      const nextTie = String(job.sourceId || job.jobId);
      if (current?.jobId && (currentOrder > nextOrder || (currentOrder === nextOrder && currentTie > nextTie))) {
        supersededByJobId = current.jobId;
        return current;
      }
      if (current?.jobId === job.jobId) {
        supersedesJobId = current.previousJobId || null;
        return current;
      }
      supersedesJobId = current?.jobId || null;
      return {
        jobId: job.jobId,
        previousJobId: supersedesJobId,
        sourceId: job.sourceId,
        sourceOrderMs: nextOrder,
        updatedAtMs: job.createdAtMs,
      };
    });
    if (afterCoalescingPublished) await afterCoalescingPublished();
    if (supersedesJobId && isValidFirebaseKey(supersedesJobId)) {
      const previousRef = db.ref(`notification_jobs/${supersedesJobId}`);
      const previous = (await previousRef.once('value')).val();
      if (previous && !isTerminalNotificationJobStatus(previous.status)
        && !isNotificationLifecycleRetentionFenced(previous, job.createdAtMs)) {
        await transitionQueuedRecord(db, {
          targetPath: `notification_jobs/${supersedesJobId}`,
          current: previous,
          patch: { status: 'expired', supersededByJobId: job.jobId, completedAtMs: Number(previous.completedAtMs || job.createdAtMs), updatedAtMs: job.createdAtMs, lease: null },
          targetId: supersedesJobId,
        });
      }
      const persistedPrevious = (await previousRef.once('value')).val();
      await scheduleNotificationRetentionIfEligible(db, persistedPrevious, job.createdAtMs);
      await stateRef.transaction((current) => current?.jobId === job.jobId && current?.previousJobId === supersedesJobId
        ? { ...current, previousJobId: null, handoffCompletedAtMs: job.createdAtMs }
        : current);
    }
  }

  if (supersededByJobId) {
    await jobRef.transaction((current) => current?.status === 'preparing' ? {
      ...current,
      status: 'expired',
      supersededByJobId,
      completedAtMs: Number(current.completedAtMs || job.createdAtMs),
      updatedAtMs: job.createdAtMs,
      lease: null,
    } : undefined);
  } else {
    let activation = null;
    const activated = await jobRef.transaction((current) => {
      if (current?.status !== 'preparing') return undefined;
      const queueVersion = Number(current.queueVersion || 0) + 1;
      const queueKey = buildNotificationQueueKey(job.availableAtMs, job.jobId, queueVersion);
      activation = { queueKey, queueVersion };
      return {
        ...current,
        status: 'queued',
        queueKind: 'fanout',
        queueKey,
        queueVersion,
        updatedAtMs: job.createdAtMs,
      };
    });
    if (activated?.committed && activation) await ensureNotificationFanoutQueue(db, {
      ...job, status: 'queued', queueKind: 'fanout', ...activation,
    });
  }

  const persisted = (await jobRef.once('value')).val() || result?.snapshot?.val?.() || job;
  // Trigger replay repairs the non-atomic preparing -> queued -> queue handoff.
  // Privacy and terminal states fail closed because only exact queued jobs qualify.
  await ensureNotificationFanoutQueue(db, persisted);
  await scheduleNotificationRetentionIfEligible(db, persisted, Number(persisted.updatedAtMs || job.createdAtMs));
  return { created, jobId: job.jobId, job: persisted };
};

/** @param {{ jobRef: any, nowMs?: number, ownerId?: string, leaseMs?: number, leaseExpiresAtMs?: number }} options */
const acquireNotificationJobLease = async ({
  jobRef,
  nowMs = Date.now(),
  ownerId = randomUUID(),
  leaseMs = DEFAULT_LEASE_MS,
  leaseExpiresAtMs = nowMs + leaseMs,
}) => {
  let acquired = false;
  const transaction = await jobRef.transaction((job) => {
    if (!job || !['queued', 'fanout_in_progress'].includes(job.status)) return;
    if (isNotificationLifecycleRetentionFenced(job, nowMs)) return;
    if (Number(job.expiresAtMs) <= nowMs || job.supersededByJobId) {
      return { ...job, status: 'expired', lease: null, completedAtMs: Number(job.completedAtMs || nowMs), updatedAtMs: nowMs };
    }
    if (Number(job.availableAtMs || 0) > nowMs) return;
    if (job.lease && Number(job.lease.expiresAtMs) > nowMs && job.lease.ownerId !== ownerId) return;
    acquired = true;
    return {
      ...job,
      status: 'fanout_in_progress',
      updatedAtMs: nowMs,
      lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: leaseExpiresAtMs },
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
  ensureNotificationFanoutQueue,
  safeCoalescingKey,
};
