'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { deleteOwnedGroupPhotoRecord, deleteOwnedPrivatePhotoRecord } = require('../media/public');
const {
  buildNotificationJobId,
  NOTIFICATION_RETENTION_MS,
  nextNotificationRetentionGeneration,
  resolveChatJobShape,
  scheduleNotificationRetentionIfEligible,
} = require('../notifications/public');
const {
  ACCOUNT_DELETION_CHAT_PAGE_SIZE,
  ACCOUNT_DELETION_MEDIA_PAGE_SIZE,
  emptyAccountDeletionSummary,
} = require('./accountDeletionConstants');
const { assertCurrentJobLease } = require('./accountDeletionCoordination');

/** @param {any} ref @param {string | null | undefined} afterKey @param {number} limit */
const readAccountDeletionKeyPage = async (ref, afterKey, limit) => {
  let query = ref.orderByKey();
  if (afterKey) query = query.startAt(afterKey);
  const snapshot = await query.limitToFirst(limit + (afterKey ? 1 : 0)).once('value');
  return Object.entries(snapshot.val() || {})
    .filter(([key]) => !afterKey || key > afterKey)
    .slice(0, limit)
    .sort(([left], [right]) => left.localeCompare(right));
};

const releaseOwnedPassengerAuthority = async ({ db, scope, leaseGuard = null }) => {
  const securityRef = db.ref(`passenger_identity_security/${scope.bookingRef}/authorizedAuthUid`);
  const bindingRef = db.ref(`identity_bindings/${scope.stablePassengerKey}/${scope.authUid}`);
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  const security = await securityRef.transaction(
    (current) => current === scope.authUid ? null : undefined, undefined, false,
  );
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  const binding = await bindingRef.transaction((current) => current === true ? null : undefined, undefined, false);
  return Number(security?.committed === true) + Number(binding?.committed === true);
};

const releaseOwnedDriverAuthority = async ({ db, scope, leaseGuard = null }) => {
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  const result = await db.ref(`drivers/${scope.driverId}/authUid`).transaction(
    (current) => current === scope.authUid ? null : undefined,
    undefined,
    false,
  );
  return Number(result?.committed === true);
};

const deleteGroupMediaPage = async ({ db, bucket, scope, cursor, lease }) => {
  if (scope.principalType !== 'passenger' || !scope.tourId) return { done: true, lastKey: null, ...emptyAccountDeletionSummary() };
  const ref = db.ref(`group_tour_photos/${scope.tourId}`);
  const page = await readAccountDeletionKeyPage(ref, cursor, ACCOUNT_DELETION_MEDIA_PAGE_SIZE);
  let recordsRemoved = 0;
  let storageObjectsRemoved = 0;
  for (const [photoId, record] of page) {
    if (!scope.actorKeys.includes(record?.userId)) continue;
    if (lease) await assertCurrentJobLease(lease);
    const result = await deleteOwnedGroupPhotoRecord({
      db,
      bucket,
      tourId: scope.tourId,
      photoId,
      trustedOwnerKeys: scope.actorKeys,
      assertCanDelete: () => assertCurrentJobLease(lease),
    });
    recordsRemoved += Number(result.deleted === true);
    storageObjectsRemoved += Number(result.storageObjectsRemoved || 0);
  }
  return {
    done: page.length < ACCOUNT_DELETION_MEDIA_PAGE_SIZE,
    lastKey: page.at(-1)?.[0] || cursor || null,
    recordsRemoved,
    storageObjectsRemoved,
  };
};

const deletePrivateMediaPage = async ({ db, bucket, scope, cursor, lease }) => {
  if (scope.principalType !== 'passenger' || !scope.tourId || !scope.privatePhotoOwnerKey) {
    return { done: true, lastKey: null, ...emptyAccountDeletionSummary() };
  }
  const ref = db.ref(`private_tour_photos/${scope.tourId}/${scope.privatePhotoOwnerKey}`);
  const page = await readAccountDeletionKeyPage(ref, cursor, ACCOUNT_DELETION_MEDIA_PAGE_SIZE);
  let recordsRemoved = 0;
  let storageObjectsRemoved = 0;
  for (const [photoId] of page) {
    if (lease) await assertCurrentJobLease(lease);
    const result = await deleteOwnedPrivatePhotoRecord({
      db,
      bucket,
      tourId: scope.tourId,
      ownerKey: scope.privatePhotoOwnerKey,
      photoId,
      trustedOwnerKeys: scope.actorKeys,
      assertCanDelete: () => assertCurrentJobLease(lease),
    });
    recordsRemoved += Number(result.deleted === true);
    storageObjectsRemoved += Number(result.storageObjectsRemoved || 0);
  }
  return {
    done: page.length < ACCOUNT_DELETION_MEDIA_PAGE_SIZE,
    lastKey: page.at(-1)?.[0] || cursor || null,
    recordsRemoved,
    storageObjectsRemoved,
  };
};

const isOwnedPassengerMessage = (message, actorKeys) => Boolean(
  message && actorKeys && (actorKeys.has(message.senderId) || actorKeys.has(message.senderStableId))
);

const canonicalAccountDeletionValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalAccountDeletionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, canonicalAccountDeletionValue(value[key]),
  ]));
};

const fingerprintReplyContext = (value) => JSON.stringify(canonicalAccountDeletionValue(value ?? null));

const redactAuthoredChatNotificationJob = async ({
  db, scope, tourId, messageId, message, nowMs,
}) => {
  if (scope.principalType !== 'passenger') return 0;
  const canonical = resolveChatJobShape({ tourId, messageId, messageData: message, isAdmin: false });
  const candidates = [{ sourceType: canonical.sourceType, sourceId: canonical.sourceId }];
  let recordsRemoved = 0;
  for (const candidate of candidates) {
    const jobId = buildNotificationJobId(candidate.sourceType, candidate.sourceId);
    const jobRef = db.ref(`notification_jobs/${jobId}`);
    const observedJob = (await jobRef.once('value')).val();
    let replacedExisting = false;
    let blockedByLiveLease = false;
    const privacyExpiresAtMs = nowMs + NOTIFICATION_RETENTION_MS;
    const result = await jobRef.transaction((current) => {
      blockedByLiveLease = Boolean(current?.lease
        && Number(current.lease.expiresAtMs || 0) > nowMs);
      if (blockedByLiveLease) return undefined;
      replacedExisting = Boolean(current && current.status !== 'privacy_deleted');
      if (current?.status === 'privacy_deleted') return current;
      return {
        schemaVersion: 1,
        jobId,
        status: 'privacy_deleted',
        createdAtMs: Number(current?.createdAtMs || nowMs),
        updatedAtMs: nowMs,
        completedAtMs: nowMs,
        expiresAtMs: privacyExpiresAtMs,
        retentionDueAtMs: privacyExpiresAtMs,
        retentionGeneration: nextNotificationRetentionGeneration(current),
      };
    }, undefined, false);
    if (!result?.committed) {
      const error = /** @type {Error & { code?: string }} */ (
        new Error(blockedByLiveLease
          ? 'Authored notification delivery is still in progress'
          : 'Authored notification privacy tombstone changed')
      );
      error.code = blockedByLiveLease
        ? 'ACCOUNT_DELETION_NOTIFICATION_BUSY'
        : 'ACCOUNT_DELETION_NOTIFICATION_CHANGED';
      throw error;
    }
    const queueRoots = {
      fanout: 'notification_job_fanout_queue',
      retry: 'notification_attempt_retry_queue',
      receipt: 'notification_receipt_due_queue',
    };
    await db.ref().update({
      [`notification_job_token_claims/${jobId}`]: null,
      [`notification_job_recipients/${jobId}`]: null,
      [`notification_job_audience_claims/${jobId}`]: null,
      [`notification_delivery_warnings/${jobId}`]: null,
      ...(observedJob?.queueKind && observedJob?.queueKey && queueRoots[observedJob.queueKind]
        ? { [`${queueRoots[observedJob.queueKind]}/${observedJob.queueKey}`]: null }
        : {}),
    });
    const retention = await scheduleNotificationRetentionIfEligible(db, result.snapshot.val(), nowMs);
    if (!['scheduled', 'already_scheduled', 'queue_repaired'].includes(retention?.reason)) {
      const error = /** @type {Error & { code?: string }} */ (
        new Error('Authored notification privacy retention was not durably scheduled')
      );
      error.code = 'ACCOUNT_DELETION_NOTIFICATION_RETENTION_NOT_DURABLE';
      throw error;
    }
    recordsRemoved += Number(replacedExisting);
  }
  return recordsRemoved;
};

const scrubAccountDeletionMessage = async ({
  ref, scope, nowMs, scrubReplyContext = false, observedReplyContextFingerprint = null,
}) => {
  const actorKeys = new Set(scope.actorKeys || []);
  let chatMessagesScrubbed = 0;
  let reactionsRemoved = 0;
  // eslint-disable-next-line complexity -- one transaction atomically scrubs all owned message leaves
  const result = await ref.transaction((current) => {
    chatMessagesScrubbed = 0;
    reactionsRemoved = 0;
    let nextChatMessagesScrubbed = 0;
    let nextReactionsRemoved = 0;
    if (!current || typeof current !== 'object') return current;
    const ownsMessage = scope.principalType === 'passenger'
      && isOwnedPassengerMessage(current, actorKeys);
    const replyContextStillMatches = scrubReplyContext
      && typeof observedReplyContextFingerprint === 'string'
      && fingerprintReplyContext(current.replyTo) === observedReplyContextFingerprint;
    const nextReactions = {};
    Object.entries(current.reactions || {}).forEach(([emoji, actors]) => {
      if (!actors || typeof actors !== 'object') return;
      const kept = {};
      Object.entries(actors).forEach(([actorKey, value]) => {
        if (actorKeys.has(actorKey)) nextReactionsRemoved += 1;
        else kept[actorKey] = value;
      });
      if (Object.keys(kept).length) nextReactions[emoji] = kept;
    });
    if (!ownsMessage && nextReactionsRemoved === 0 && !replyContextStillMatches) return current;
    if (ownsMessage) nextChatMessagesScrubbed = 1;
    let scrubbed;
    if (ownsMessage) {
      scrubbed = {
        ...(Number.isSafeInteger(current.schemaVersion) ? { schemaVersion: current.schemaVersion } : {}),
        ...(typeof current.timestamp === 'string' || Number.isFinite(current.timestamp)
          ? { timestamp: current.timestamp } : {}),
        ...(Number.isFinite(current.clientCreatedAt) ? { clientCreatedAt: current.clientCreatedAt } : {}),
        ...(typeof current.status === 'string' ? { status: current.status } : {}),
        text: '',
        senderId: 'account_deleted',
        senderStableId: 'account_deleted',
        senderName: 'Deleted account',
        senderType: 'passenger',
        isDriver: false,
        type: 'text',
        deleted: true,
        deletedAt: current.deleted === true && current.deletedAt
          ? current.deletedAt
          : new Date(nowMs).toISOString(),
        deletedBy: current.deleted === true && current.deletedBy && !actorKeys.has(current.deletedBy)
          ? current.deletedBy
          : 'account_deleted',
      };
    } else {
      scrubbed = { ...current };
      if (replyContextStillMatches) delete scrubbed.replyTo;
    }
    scrubbed.reactions = nextReactions;
    chatMessagesScrubbed = nextChatMessagesScrubbed;
    reactionsRemoved = nextReactionsRemoved;
    return scrubbed;
  }, undefined, false);
  return result?.committed ? { chatMessagesScrubbed, reactionsRemoved } : {
    chatMessagesScrubbed: 0, reactionsRemoved: 0,
  };
};

// eslint-disable-next-line complexity -- bounded chat, reply and notification privacy work shares one cursor
const scrubChatPage = async ({ db, scope, cursor, nowMs, lease }) => {
  if (!scope.tourId) return { done: true, lastKey: null, ...emptyAccountDeletionSummary() };
  const ref = db.ref(`chats/${scope.tourId}/messages`);
  const page = await readAccountDeletionKeyPage(ref, cursor, ACCOUNT_DELETION_CHAT_PAGE_SIZE);
  let chatMessagesScrubbed = 0;
  let reactionsRemoved = 0;
  let recordsRemoved = 0;
  const actorKeys = new Set(scope.actorKeys || []);
  for (const [messageId, observed] of page) {
    if (lease) await assertCurrentJobLease(lease);
    if (scope.principalType === 'passenger' && isOwnedPassengerMessage(observed, actorKeys)) {
      recordsRemoved += await redactAuthoredChatNotificationJob({
        db, scope, tourId: scope.tourId, messageId, message: observed, nowMs,
      });
      if (lease) await assertCurrentJobLease(lease);
    }
    let scrubReplyContext = false;
    const replyMessageId = typeof observed?.replyTo?.messageId === 'string'
      ? observed.replyTo.messageId.trim()
      : '';
    if (scope.principalType === 'passenger' && isValidFirebaseKey(replyMessageId)) {
      const referenced = (await ref.child(replyMessageId).once('value')).val();
      scrubReplyContext = isOwnedPassengerMessage(referenced, actorKeys)
        || (referenced?.deletedBy === 'account_deleted'
          && referenced?.senderId === 'account_deleted');
    }
    const result = await scrubAccountDeletionMessage({
      ref: ref.child(messageId),
      scope,
      nowMs,
      scrubReplyContext,
      observedReplyContextFingerprint: scrubReplyContext
        ? fingerprintReplyContext(observed?.replyTo)
        : null,
    });
    chatMessagesScrubbed += result.chatMessagesScrubbed;
    reactionsRemoved += result.reactionsRemoved;
  }
  return {
    done: page.length < ACCOUNT_DELETION_CHAT_PAGE_SIZE,
    lastKey: page.at(-1)?.[0] || cursor || null,
    chatMessagesScrubbed,
    reactionsRemoved,
    recordsRemoved,
  };
};

const deleteUidAccountRecords = async ({ db, scope, leaseGuard = null }) => {
  const updates = {
    [`app_sessions/${scope.authUid}`]: null,
    [`users/${scope.authUid}`]: null,
    [`logs/${scope.authUid}`]: null,
  };
  if (scope.tourId) {
    [...new Set(scope.actorKeys || [])].forEach((actorKey) => {
      updates[`notification_read_state/${scope.tourId}/${actorKey}`] = null;
      updates[`notification_read_migration_requests/${scope.tourId}/${actorKey}`] = null;
    });
    updates[`tours/${scope.tourId}/liveTracking/${scope.authUid}`] = null;
  }
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  await db.ref().update(updates);
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  const roleClaim = await db.ref(`app_session_role_claim_jobs/v1/${scope.authUid}`).transaction((current) => (
    current?.appSessionId === scope.expectedSessionId ? null : undefined
  ), undefined, false);
  if (leaseGuard) await assertCurrentJobLease(leaseGuard);
  const policyCleanup = await db.ref(`driver_login_policy_cleanup/v1/${scope.authUid}`).transaction((current) => (
    current?.sessionId === scope.expectedSessionId ? null : undefined
  ), undefined, false);
  return Object.keys(updates).length
    + Number(roleClaim?.committed === true)
    + Number(policyCleanup?.committed === true);
};

module.exports = {
  deleteGroupMediaPage,
  deletePrivateMediaPage,
  deleteUidAccountRecords,
  readAccountDeletionKeyPage,
  redactAuthoredChatNotificationJob,
  releaseOwnedDriverAuthority,
  releaseOwnedPassengerAuthority,
  scrubAccountDeletionMessage,
  scrubChatPage,
};
