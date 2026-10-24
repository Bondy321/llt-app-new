'use strict';

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');
const { randomUUID, createHash } = require('node:crypto');
const { captureMediaPublicationAuthority, mediaOperationPaths, commitMediaPublication } = require('./mediaPublication');
const { extensionForGroupPhotoContentType } = require('./mediaUploadMetadata');
const { toRealtimeKeySegment } = require('../../infrastructure/validation/stringNormalization');
const { sameMediaAuthority } = require('./mediaOperationBoundary');

const UPLOAD_LIFETIME_MS = 5 * 60 * 1000;
const uploadError = code => Object.assign(new Error('Media upload could not complete'), { code });
const cancelMediaUpload = async ({ db, operation }) => {
  const { operationPath } = mediaOperationPaths(operation);
  await transactExistingRecord(db.ref(operationPath), current => {
    if (!current || ['committed', 'cleaned'].includes(current.state)) return undefined;
    return { ...current, state: 'cancelled' };
  });
  // Keep the original deadline: a failed or disconnected request may still be saving bytes.
};

const assertMediaUploadSettled = async ({ record }) => {
  // Pending/cancelled records are removed only by their durable sweeper. Normal
  // deletion must never remove the empty storage cancellation sentinel.
  if (record?._upload && record._upload.status !== 'complete') throw uploadError('MEDIA_UPLOAD_IN_PROGRESS');
};

const mediaUploadFailureResponse = error => {
  if (error?.code === 'IDEMPOTENCY_CONFLICT') return { status: 409, reason: 'IDEMPOTENCY_CONFLICT' };
  if (['MEDIA_AUTHORITY_CHANGED', 'PERMISSION_DENIED', 'permission-denied'].includes(error?.code)) return { status: 403, reason: 'NOT_AUTHORIZED' };
  return { status: 503, reason: 'UPLOAD_NOT_COMPLETED' };
};
const assertReusableUpload = ({ existing, principalId, contentHash, idempotencyKey, sourcePrefix }) => {
  if (existing._serverDeletion || existing._upload?.status !== 'complete'
    || existing.userId !== principalId || existing.contentHash !== contentHash
    || existing.idempotencyKey !== idempotencyKey || typeof existing.storagePath !== 'string'
    || !existing.storagePath.startsWith(sourcePrefix) || existing.storagePath.slice(sourcePrefix.length).includes('/')
    || existing.storagePath.includes('..')) throw uploadError('IDEMPOTENCY_CONFLICT');
};

const performMediaUpload = async ({ db, bucket, input, access, authUid, visibility,
  body, contentType, lockOwner, readAccess, now = Date.now,
  captureAuthority = captureMediaPublicationAuthority, publish = commitMediaPublication }) => {
  const photoId = toRealtimeKeySegment(input.idempotencyKey);
  const ownerKey = visibility === 'private' ? access.principalId : null;
  const operationId = randomUUID();
  const sourcePrefix = `${visibility}_tour_photos/${input.tourId}/${ownerKey ? `${ownerKey}/` : ''}`;
  const storagePath = `${sourcePrefix}${photoId}-${operationId}.${extensionForGroupPhotoContentType(contentType)}`;
  const contentHash = createHash('sha256').update(body).digest('hex');
  const identity = { operationId, authUid, principalId: access.principalId,
    role: access.role, visibility, tourId: input.tourId, ownerKey, photoId, storagePath };
  const paths = mediaOperationPaths(identity);
  const existing = (await db.ref(paths.recordPath).once('value')).val();
  if (existing) {
    assertReusableUpload({ existing, principalId: access.principalId, contentHash, idempotencyKey: input.idempotencyKey, sourcePrefix });
    if (!sameMediaAuthority(access, await readAccess())) throw uploadError('MEDIA_AUTHORITY_CHANGED');
    return { photoId, storagePath: existing.storagePath, deduped: true };
  }
  const createdAtMs = now();
  const captured = await captureAuthority({ db, access, authUid, tourId: input.tourId });
  const operation = { schemaVersion: 1, ...identity, ...captured, ...paths,
    contentHash, contentType, fileSize: body.length, createdAtMs,
    expiresAtMs: createdAtMs + UPLOAD_LIFETIME_MS, dueAtMs: createdAtMs + UPLOAD_LIFETIME_MS, state: 'pending' };
  await db.ref().update({ [paths.operationPath]: operation,
    [`media_upload_cleanup_queue/${operation.operationId}`]: { authUid, dueAtMs: operation.dueAtMs } });
  const record = { userId: access.principalId, caption: input.caption, timestamp: createdAtMs,
    storagePath, fileSize: body.length, fileType: contentType, contentHash,
    idempotencyKey: input.idempotencyKey, variantStatus: 'processing', variantUpdatedAt: createdAtMs,
    variantVersion: 2, ...(visibility === 'group' ? { uploaderName: input.uploaderName } : {}),
    _upload: { operationId: operation.operationId, authUid, status: 'pending' } };
  try {
    await publish({ db, operation, lockOwner, record, phase: 'reserve' });
    if (now() >= operation.expiresAtMs) throw uploadError('MEDIA_UPLOAD_EXPIRED');
    await bucket.file(storagePath).save(body, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType, cacheControl: 'private,max-age=300,no-transform', metadata: {
        visibility, sourceRole: 'source', uploadOperationId: operation.operationId, authUid,
      } } });
    await publish({ db, operation, lockOwner, phase: 'finalize',
      record: { ...record, _upload: { ...record._upload, status: 'complete' } } });
    if (!sameMediaAuthority(access, await readAccess())) throw uploadError('MEDIA_AUTHORITY_CHANGED');
    return { photoId, storagePath, deduped: false };
  } catch (error) {
    await cancelMediaUpload({ db, operation });
    throw error;
  }
};

module.exports = { mediaUploadFailureResponse, UPLOAD_LIFETIME_MS, performMediaUpload, cancelMediaUpload, assertMediaUploadSettled };
