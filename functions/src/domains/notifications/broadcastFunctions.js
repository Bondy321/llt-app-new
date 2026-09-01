'use strict';

// @ts-check

const { onValueCreated } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { verifyOperationsAdminAccess } = require('../administration/public');
const {
  isSupportedTourNotificationCategory,
  resolveTourNotificationCategoryLabel,
} = require('./notificationPolicy');
const { enqueueNotificationJob } = require('./notificationJobs');
const { TERMINAL_NOTIFICATION_JOB_STATUSES } = require('./notificationJobStatus');
const { buildChatNotificationJob, buildMarketingNotificationJob } = require('./notificationProducerJobs');
const { buildTourNotificationRecord, persistTourNotification } = require('./notificationState');
const { runNotificationSourceHandoff } = require('./notificationSourceHandoff');
const { NOTIFICATION_RETENTION_MS } = require('./notificationRetentionIntegration');

/** @param {any} value */
const normalizeSafeMarketingCta = (value) => {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const label = typeof value.label === 'string' ? value.label.replace(/\s+/gu, ' ').trim().slice(0, 60) : '';
  const rawUrl = typeof value.url === 'string' ? value.url.trim().slice(0, 500) : '';
  if (!label || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { label, url: url.toString() };
  } catch (_error) {
    return null;
  }
};

const isMatchingMarketingDetailSource = (current, expected) => Boolean(
  current && typeof current === 'object'
  && (!current.broadcastId || current.broadcastId === expected.broadcastId)
  && current.categoryKey === expected.categoryKey
  && Number(current.createdAtMs) === Number(expected.createdAtMs)
  && Number(current.expiresAtMs) === Number(expected.expiresAtMs)
  && current.title === expected.title
  && current.body === expected.body
  && JSON.stringify(current.cta ?? null) === JSON.stringify(expected.cta ?? null)
);

const persistMarketingNotificationDetail = async ({ db, broadcastId, detail }) => {
  let ownershipConflict = false;
  const result = await db.ref(`marketing_notification_details/${broadcastId}`).transaction((current) => {
    if (!current) return detail;
    const expectedRetentionDueAtMs = Number(current.expiresAtMs) + NOTIFICATION_RETENTION_MS;
    const existingRetentionDueAtMs = Number(current.retentionDueAtMs || 0);
    if (!isMatchingMarketingDetailSource(current, detail)
      || (current.deliveryJobId && current.deliveryJobId !== detail.deliveryJobId)
      || !Number.isSafeInteger(expectedRetentionDueAtMs)
      || (existingRetentionDueAtMs > 0 && existingRetentionDueAtMs !== expectedRetentionDueAtMs)) {
      ownershipConflict = true;
      return undefined;
    }
    return {
      ...current,
      broadcastId: detail.broadcastId,
      deliveryJobId: detail.deliveryJobId,
      retentionDueAtMs: expectedRetentionDueAtMs,
    };
  });
  if (ownershipConflict || !result?.committed) {
    const error = new Error('Marketing notification detail source ownership changed');
    error.code = 'MARKETING_NOTIFICATION_DETAIL_OWNERSHIP_CONFLICT';
    throw error;
  }
  return result.snapshot.val();
};

/** @param {any} broadcastData */
const validateBroadcastData = (broadcastData) => {
  const errors = [];
  if (!broadcastData || typeof broadcastData !== 'object') errors.push('Broadcast data is null or invalid');
  if (typeof broadcastData?.message !== 'string' || !broadcastData.message.trim() || broadcastData.message.length > 2000) {
    errors.push('Broadcast message must be 1-2000 characters');
  }
  if (!Number.isSafeInteger(broadcastData?.createdAtMs) || broadcastData.createdAtMs < 1) {
    errors.push('Missing or invalid createdAtMs');
  }
  if (typeof broadcastData?.createdByUid !== 'string' || !broadcastData.createdByUid.trim()) {
    errors.push('Missing createdByUid');
  }
  if (broadcastData?.source && typeof broadcastData.source !== 'string') errors.push('Invalid source');
  return { valid: errors.length === 0, errors };
};

/** @param {string} categoryKey @param {any} broadcastData */
const validateCategoryBroadcastData = (categoryKey, broadcastData) => {
  const errors = [...validateBroadcastData(broadcastData).errors];
  if (!isSupportedTourNotificationCategory(categoryKey)) errors.push('Unsupported tour notification category');
  if (broadcastData?.categoryKey && broadcastData.categoryKey !== categoryKey) errors.push('categoryKey must match the broadcast path');
  if (broadcastData?.categoryLabel && (typeof broadcastData.categoryLabel !== 'string'
    || !broadcastData.categoryLabel.trim() || broadcastData.categoryLabel.length > 120)) {
    errors.push('Invalid categoryLabel');
  }
  if (broadcastData?.expiresAtMs !== undefined
    && (!Number.isSafeInteger(broadcastData.expiresAtMs) || broadcastData.expiresAtMs <= broadcastData.createdAtMs)) {
    errors.push('Invalid expiresAtMs');
  }
  if (broadcastData?.cta !== undefined && !normalizeSafeMarketingCta(broadcastData.cta)) {
    errors.push('Invalid cta');
  }
  return { valid: errors.length === 0, errors };
};

const BROADCAST_TERMINAL_STATUSES = new Set([
  ...TERMINAL_NOTIFICATION_JOB_STATUSES,
  'delivered', 'failed',
]);

/** @param {any} input */
const resolveBroadcastDeliveryStatus = ({ successCount = 0, errorCount = 0, recipientCount = 0 } = {}) => {
  if (recipientCount <= 0) return 'no_recipients';
  if (successCount > 0 && errorCount > 0) return 'partial';
  if (successCount > 0) return 'ticket_accepted';
  return 'ticket_rejected';
};

/** @param {any} input */
const updateBroadcastDelivery = async ({ root, targetId, broadcastId, status, details = {} }) => {
  if (!isValidFirebaseKey(targetId) || !isValidFirebaseKey(broadcastId)) return;
  const nowMs = Date.now();
  const payload = { deliveryStatus: status, deliveryUpdatedAtMs: nowMs, ...details };
  const targetRef = admin.database().ref(`${root}/${targetId}/${broadcastId}`);
  await targetRef.transaction((current) => {
    if (!current) return current;
    if (details.deliveryJobId && current.deliveryJobId === details.deliveryJobId
      && BROADCAST_TERMINAL_STATUSES.has(current.deliveryStatus)
      && !BROADCAST_TERMINAL_STATUSES.has(status)) return current;
    if (BROADCAST_TERMINAL_STATUSES.has(status)) {
      payload.deliveryCompletedAtMs = Number(current.deliveryCompletedAtMs || nowMs);
    }
    return { ...current, ...payload };
  });
};

/** @param {string} authUid @param {{auth?: any, verifyAdmin?: Function}} dependencies */
const verifyBroadcastAuthor = async (authUid, { auth = admin.auth(), verifyAdmin = verifyOperationsAdminAccess } = {}) => {
  let record;
  try {
    record = await auth.getUser(authUid);
  } catch (error) {
    if (error?.code === 'auth/user-not-found' || error?.code === 'auth/invalid-uid') return false;
    throw error;
  }
  if (!record || record.disabled || record.providerData.length === 0) return false;
  // Database/Auth infrastructure failures must escape so the retry-enabled
  // source trigger can redeliver instead of permanently labelling an author invalid.
  return verifyAdmin({ authUid });
};

/** @param {any} event @param {{db?: any, verifyAuthor?: Function, enqueueJob?: Function, persistChat?: Function, persistNotice?: Function, publishStatus?: Function, nowMs?: number}} dependencies */
const enqueueTourBroadcastEvent = async (event, {
  db = admin.database(), verifyAuthor = verifyBroadcastAuthor,
  enqueueJob = enqueueNotificationJob, persistChat = ({ path, message }) => db.ref(path).set(message),
  persistNotice = persistTourNotification,
  publishStatus = updateBroadcastDelivery, nowMs = Date.now(),
} = {}) => { // eslint-disable-line complexity -- source validation and three-stage durable handoff stay explicit
  const { tourId, broadcastId } = event.params;
  const broadcast = event.data?.val?.() || {};
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(broadcastId)) return null;
  const validation = validateBroadcastData(broadcast);
  if (!validation.valid || !(await verifyAuthor(broadcast.createdByUid))) {
    await publishStatus({
      root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed',
      details: { deliveryErrorCode: validation.valid ? 'INVALID_AUTHOR' : 'INVALID_PAYLOAD' },
    });
    return null;
  }
  const messageData = {
    text: `ANNOUNCEMENT: ${broadcast.message.trim()}`,
    senderName: 'Loch Lomond Travel HQ',
    senderId: 'admin_hq_broadcast',
    senderUid: broadcast.createdByUid,
    timestamp: broadcast.createdAtMs,
    messageType: 'ADMIN_BROADCAST',
    source: broadcast.source || 'web_admin',
    isDriver: true,
    broadcastId,
    notificationActivationOwner: 'broadcast_source',
  };
  const tourName = (await db.ref(`tours/${tourId}/name`).once('value')).val() || 'Tour Chat';
  const job = buildChatNotificationJob({
    tourId, messageId: broadcastId, messageData, tourName, isAdmin: true, nowMs,
  });
  const result = await runNotificationSourceHandoff({
    persistSource: () => Promise.all([
      persistChat({ path: `chats/${tourId}/messages/${broadcastId}`, message: messageData }),
      persistNotice({
      db,
      record: buildTourNotificationRecord({
        type: 'announcement', tourId, sourceId: broadcastId,
        title: 'Loch Lomond Travel update', body: broadcast.message,
        screen: 'Chat', messageId: broadcastId,
        createdAtMs: broadcast.createdAtMs, priority: 'high',
      }),
      }),
    ]),
    enqueue: () => enqueueJob({ db, job }),
    publishStatus: (enqueued) => publishStatus({
      root: 'broadcasts', targetId: tourId, broadcastId, status: enqueued.job.status,
      details: { deliveryJobId: enqueued.jobId },
    }),
  });
  return { jobId: result.jobId, created: result.created };
};

/** @param {any} event */
const enqueueCategoryBroadcastEvent = async (event) => {
  const { categoryKey, broadcastId } = event.params;
  const broadcast = event.data?.val?.() || {};
  if (!isValidFirebaseKey(categoryKey) || !isValidFirebaseKey(broadcastId)) return null;
  const validation = validateCategoryBroadcastData(categoryKey, broadcast);
  if (!validation.valid || !(await verifyBroadcastAuthor(broadcast.createdByUid))) {
    await updateBroadcastDelivery({
      root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed',
      details: { deliveryErrorCode: validation.valid ? 'INVALID_AUTHOR' : 'INVALID_PAYLOAD' },
    });
    return null;
  }
  const nowMs = Date.now();
  const categoryLabel = broadcast.categoryLabel || resolveTourNotificationCategoryLabel(categoryKey);
  const job = buildMarketingNotificationJob({ categoryKey, broadcastId, categoryLabel, broadcast, nowMs });
  const marketingDetail = {
    schemaVersion: 1,
    broadcastId,
    categoryKey,
    deliveryJobId: job.jobId,
    title: `New ${categoryLabel} tour alert`.slice(0, 120),
    body: broadcast.message.trim().slice(0, 2000),
    createdAtMs: broadcast.createdAtMs,
    expiresAtMs: job.expiresAtMs,
    retentionDueAtMs: job.expiresAtMs + NOTIFICATION_RETENTION_MS,
    cta: normalizeSafeMarketingCta(broadcast.cta),
    status: 'active',
    updatedAtMs: nowMs,
  };
  const result = await runNotificationSourceHandoff({
    // Trigger replay must not move the explicit content/retention boundary or
    // overwrite delivery state already published by the durable worker.
    persistSource: () => persistMarketingNotificationDetail({
      db: admin.database(), broadcastId, detail: marketingDetail,
    }),
    enqueue: () => enqueueNotificationJob({ job }),
    publishStatus: (enqueued) => updateBroadcastDelivery({
      root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: enqueued.job.status,
      details: { deliveryJobId: enqueued.jobId },
    }),
  });
  return { jobId: result.jobId, created: result.created };
};

const processBroadcastWrite = onValueCreated({
  ref: '/broadcasts/{tourId}/{broadcastId}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
  retry: true,
}, enqueueTourBroadcastEvent);

const processCategoryBroadcastWrite = onValueCreated({
  ref: '/category_broadcasts/{categoryKey}/{broadcastId}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
  retry: true,
}, enqueueCategoryBroadcastEvent);

module.exports = {
  enqueueCategoryBroadcastEvent,
  enqueueTourBroadcastEvent,
  processBroadcastWrite,
  processCategoryBroadcastWrite,
  resolveBroadcastDeliveryStatus,
  updateBroadcastDelivery,
  validateBroadcastData,
  validateCategoryBroadcastData,
  normalizeSafeMarketingCta,
  persistMarketingNotificationDetail,
  isMatchingMarketingDetailSource,
  verifyBroadcastAuthor,
};
