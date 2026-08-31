'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { createHash, randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { enforceGroupMediaAppCheck } = require('../../infrastructure/auth/appCheckGate');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  GROUP_MEDIA_ALLOWED_TYPES,
  GROUP_MEDIA_MAX_UPLOAD_BYTES,
  GROUP_MEDIA_URL_TTL_MS,
  isGroupMediaPathForRecord,
  normalizeGroupMediaRequest,
  readGroupMediaRecords,
  signGroupMediaRecords,
  verifyCurrentTourPhotoAccess,
} = require('./mediaAccess');
const {
  extensionForGroupPhotoContentType,
  normalizeGroupPhotoUploadMetadata,
} = require('./mediaUploadMetadata');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('../../infrastructure/validation/stringNormalization');

const PHOTO_CACHE_CONTROL_HEADER = 'private,max-age=300,no-transform';
const MEDIA_RECORD_LOCK_TTL_MS = 5 * 60 * 1000;
const onRequestWithResult = /** @type {any} */ (onRequest);

const mediaRecordLockPath = ({ visibility, tourId, ownerKey = null, photoId }) => [
  'media_record_locks/v1', visibility, tourId, ownerKey || '_group', photoId,
].join('/');

const acquireMediaRecordLock = async ({
  db, visibility, tourId, ownerKey = null, photoId, owner = randomUUID(), nowMs = Date.now(),
}) => {
  if (!db?.ref || !['group', 'private'].includes(visibility)
    || !isValidFirebaseKey(tourId) || !isValidFirebaseKey(photoId)
    || (visibility === 'private' && !isValidFirebaseKey(ownerKey))) {
    throw new Error('Invalid media record lock request');
  }
  const ref = db.ref(mediaRecordLockPath({ visibility, tourId, ownerKey, photoId }));
  const result = await ref.transaction((current) => {
    if (current && current.owner !== owner && Number(current.expiresAtMs || 0) > nowMs) return undefined;
    return { schemaVersion: 1, owner, createdAtMs: nowMs, expiresAtMs: nowMs + MEDIA_RECORD_LOCK_TTL_MS };
  }, undefined, false);
  return { acquired: Boolean(result?.committed && result.snapshot.val()?.owner === owner), owner, ref };
};

const releaseMediaRecordLock = async ({ ref, owner }) => {
  let released = false;
  const result = await ref.transaction((current) => {
    if (current?.owner !== owner) return undefined;
    released = true;
    return null;
  }, undefined, false);
  return Boolean(released && result?.committed);
};

const readStorageObjectGeneration = async (file) => {
  if (typeof file.getMetadata !== 'function') return null;
  try {
    const [metadata] = await file.getMetadata();
    return metadata?.generation ? String(metadata.generation) : null;
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error || {}).code;
    if (code === 404 || code === '404') return 'missing';
    throw error;
  }
};

const deleteStorageObjectIgnoringMissing = async (bucket, path, expectedGeneration) => {
  if (expectedGeneration === 'missing') return false;
  if (!expectedGeneration) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Storage generation is unavailable'));
    error.code = 'MEDIA_GENERATION_UNAVAILABLE';
    throw error;
  }
  const file = bucket.file(path);
  try {
    await file.delete({
      ignoreNotFound: true,
      ifGenerationMatch: expectedGeneration,
    });
    return true;
  } catch (error) {
    const details = /** @type {{ code?: unknown }} */ (error || {});
    if (details.code === 412 || details.code === '412') {
      const changed = /** @type {Error & { code?: string }} */ (new Error('Storage object changed'));
      changed.code = 'MEDIA_OBJECT_CHANGED';
      throw changed;
    }
    if (details.code !== 404 && details.code !== '404') throw error;
    return false;
  }
};

const stableMediaValue = (value) => {
  if (Array.isArray(value)) return value.map(stableMediaValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableMediaValue(value[key])]));
};

const mediaRecordFingerprint = (record) => {
  const { _serverDeletion: _ignored, ...durable } = record || {};
  return createHash('sha256').update(JSON.stringify(stableMediaValue(durable))).digest('hex');
};

const captureStorageGenerations = async ({ bucket, captured }) => {
  const generations = {};
  for (const field of ['storagePath', 'viewerStoragePath', 'thumbnailStoragePath']) {
    const path = captured[field];
    if (path === null) continue;
    const generation = await readStorageObjectGeneration(bucket.file(path));
    if (!generation) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Storage generation is unavailable'));
      error.code = 'MEDIA_GENERATION_UNAVAILABLE';
      throw error;
    }
    generations[field] = generation;
  }
  return generations;
};

/**
 * Deletes only an exact, trusted-owner group-photo record. Storage is removed before a
 * compare-delete transaction so a concurrently replaced record is never source-deleted.
 * @param {{ db: any, bucket: any, tourId: string, photoId: string, trustedOwnerKeys: string[], assertCanDelete?: (() => Promise<any>) }} options
 */
const deleteOwnedGroupPhotoRecordUnlocked = async ({
  db, bucket, tourId, photoId, trustedOwnerKeys, assertCanDelete = null,
// eslint-disable-next-line complexity -- claim, trusted-path validation and compare-delete fail closed together
}) => {
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(photoId)) throw new Error('Invalid group photo key');
  const owners = new Set((Array.isArray(trustedOwnerKeys) ? trustedOwnerKeys : []).filter(isValidFirebaseKey));
  if (owners.size === 0) throw new Error('Trusted group photo owner is required');
  const recordRef = db.ref(`group_tour_photos/${tourId}/${photoId}`);
  const snapshot = await recordRef.once('value');
  if (!snapshot.exists()) return { deleted: false, alreadyDeleted: true, storageObjectsRemoved: 0 };
  const observed = snapshot.val() || {};
  if (!owners.has(observed.userId)) return { deleted: false, alreadyDeleted: false, reason: 'NOT_OWNER' };
  const captured = {
    userId: observed.userId,
    storagePath: observed.storagePath ?? null,
    viewerStoragePath: observed.viewerStoragePath ?? null,
    thumbnailStoragePath: observed.thumbnailStoragePath ?? null,
  };
  const capturedPaths = [captured.storagePath, captured.viewerStoragePath, captured.thumbnailStoragePath];
  if (capturedPaths.some((path) => path !== null && !isGroupMediaPathForRecord({ path, tourId }))) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Group photo path is invalid'));
    error.code = 'MEDIA_PATH_INVALID';
    throw error;
  }
  const fingerprint = mediaRecordFingerprint(observed);
  const existingClaim = observed._serverDeletion?.status === 'deleting'
    ? observed._serverDeletion
    : null;
  if (existingClaim && (existingClaim.recordFingerprint !== fingerprint
    || !existingClaim.generations || typeof existingClaim.generations !== 'object')) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Group photo claim changed'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  const generations = existingClaim?.generations || await captureStorageGenerations({ bucket, captured });
  let claimState = 'changed';
  const claim = await recordRef.transaction((current) => {
    if (!current) {
      claimState = 'missing';
      return current;
    }
    if (mediaRecordFingerprint(current) !== fingerprint) {
      claimState = 'changed';
      return undefined;
    }
    claimState = 'claimed';
    return {
      ...current,
      _serverDeletion: {
        schemaVersion: 1,
        status: 'deleting',
        recordFingerprint: fingerprint,
        generations,
      },
    };
  }, undefined, false);
  if (claimState === 'missing') return { deleted: false, alreadyDeleted: true, storageObjectsRemoved: 0 };
  if (!claim?.committed || claimState !== 'claimed') {
    const error = /** @type {Error & { code?: string }} */ (new Error('Group photo claim changed'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  const paths = [...new Set(capturedPaths.filter((path) => path !== null))];
  for (const path of paths) {
    if (assertCanDelete) await assertCanDelete();
    const field = ['storagePath', 'viewerStoragePath', 'thumbnailStoragePath']
      .find((candidate) => captured[candidate] === path);
    await deleteStorageObjectIgnoringMissing(bucket, path, generations[field]);
  }
  if (assertCanDelete) await assertCanDelete();
  let matched = false;
  let missingDuringCompare = false;
  const result = await recordRef.transaction((current) => {
    matched = false;
    missingDuringCompare = false;
    if (!current) {
      missingDuringCompare = true;
      return current;
    }
    if (current._serverDeletion?.status !== 'deleting'
      || current._serverDeletion?.recordFingerprint !== fingerprint
      || mediaRecordFingerprint(current) !== fingerprint) return undefined;
    matched = true;
    return null;
  }, undefined, false);
  if (missingDuringCompare) {
    return { deleted: false, alreadyDeleted: true, storageObjectsRemoved: paths.length };
  }
  if (!matched || !result?.committed) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Group photo changed during deletion'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  return { deleted: true, alreadyDeleted: false, storageObjectsRemoved: paths.length };
};

const deleteOwnedGroupPhotoRecord = async (options) => {
  const lock = await acquireMediaRecordLock({
    db: options.db, visibility: 'group', tourId: options.tourId, photoId: options.photoId,
  });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Group photo mutation in progress'));
    error.code = 'MEDIA_MUTATION_IN_PROGRESS';
    throw error;
  }
  try {
    return await deleteOwnedGroupPhotoRecordUnlocked(options);
  } finally {
    await releaseMediaRecordLock(lock);
  }
};

/** @type {(...args: any[]) => Promise<any>} */
const authorizeGroupMediaRequest = async ({ req, res, tourId, db = admin.database() }) => {
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    return null;
  }
  let appCheckValid = false;
  try {
    appCheckValid = await enforceGroupMediaAppCheck(req);
  } catch (error) {
    log.error('Group media App Check configuration failure', error);
    res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    return null;
  }
  if (!appCheckValid) {
    res.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
    return null;
  }
  const access = await verifyCurrentTourPhotoAccess({ db, authUid: requestAuth.uid, tourId });
  if (!access.allowed) {
    res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    return null;
  }
  return { requestAuth, access };
};

/** @type {(...args: any[]) => any} */
const resolveGroupPhotoMedia = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizeGroupMediaRequest(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId: input.tourId });
    if (!authorization) return null;
    const records = await readGroupMediaRecords({ db: admin.database(), ...input });
    const expires = Date.now() + GROUP_MEDIA_URL_TTL_MS;
    const media = await signGroupMediaRecords({ bucket: admin.storage().bucket(), input, records, expires });
    return res.status(200).json({ success: true, expiresAtMs: expires, media });
  },
);

/** @type {(...args: any[]) => Promise<any>} */
const reserveGroupPhotoRecord = async ({ db, input, access, contentType, fileSize, nowMs = Date.now() }) => {
  const photoId = toRealtimeKeySegment(input.idempotencyKey);
  const extension = extensionForGroupPhotoContentType(contentType);
  const storagePath = `group_tour_photos/${input.tourId}/${photoId}.${extension}`;
  const recordRef = db.ref(`group_tour_photos/${input.tourId}/${photoId}`);
  let conflict = false;
  let deduped = false;
  const result = await recordRef.transaction(/** @param {any} current */ (current) => {
    if (current) {
      if (current._serverDeletion?.status === 'deleting') {
        conflict = true;
        return undefined;
      }
      if (current.idempotencyKey === input.idempotencyKey && current.userId === access.principalId
        && current.storagePath === storagePath) {
        deduped = true;
        return current;
      }
      conflict = true;
      return;
    }
    return {
      userId: access.principalId,
      caption: input.caption,
      uploaderName: input.uploaderName,
      timestamp: nowMs,
      storagePath,
      fileSize,
      fileType: contentType,
      idempotencyKey: input.idempotencyKey,
      variantStatus: 'processing',
      variantUpdatedAt: nowMs,
      variantError: null,
      variantVersion: 2,
    };
  });
  if (conflict || !result.committed) return { success: false, reason: 'IDEMPOTENCY_CONFLICT' };
  return { success: true, photoId, storagePath, deduped, recordRef };
};

/** @type {(...args: any[]) => any} */
const uploadGroupPhoto = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 60, memory: '512MiB', cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizeGroupPhotoUploadMetadata(req.headers['x-group-photo-metadata']);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId: input.tourId });
    if (!authorization) return null;
    const contentType = resolveTrimmedString(req.headers['content-type'])?.toLowerCase();
    const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!body || body.length < 1 || body.length > GROUP_MEDIA_MAX_UPLOAD_BYTES
      || !GROUP_MEDIA_ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({ success: false, reason: 'INVALID_IMAGE' });
    }
    const db = admin.database();
    const photoId = toRealtimeKeySegment(input.idempotencyKey);
    const mutationLock = await acquireMediaRecordLock({
      db, visibility: 'group', tourId: input.tourId, photoId,
    });
    if (!mutationLock.acquired) {
      return res.status(409).json({ success: false, reason: 'MEDIA_MUTATION_IN_PROGRESS' });
    }
    try {
      const reservation = await reserveGroupPhotoRecord({
        db,
        input,
        access: authorization.access,
        contentType,
        fileSize: body.length,
      });
      if (!reservation.success) return res.status(409).json({ success: false, reason: reservation.reason });
      const file = admin.storage().bucket().file(reservation.storagePath);
      if (!reservation.deduped || !(await file.exists())[0]) {
        await file.save(body, {
          resumable: false,
          metadata: {
            contentType,
            cacheControl: PHOTO_CACHE_CONTROL_HEADER,
            metadata: { visibility: 'group', sourceRole: 'source' },
          },
        });
      }
      return res.status(200).json({
        success: true,
        photo: {
          id: reservation.photoId,
          userId: authorization.access.principalId,
          caption: input.caption,
          uploaderName: input.uploaderName,
          storagePath: reservation.storagePath,
          deduped: reservation.deduped,
        },
      });
    } finally {
      await releaseMediaRecordLock(mutationLock);
    }
  },
);

/** @type {(...args: any[]) => any} */
const deleteGroupPhoto = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    const photoId = resolveTrimmedString(req.body?.photoId);
    if (!tourId || !isValidFirebaseKey(tourId) || !photoId || !isValidFirebaseKey(photoId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId });
    if (!authorization) return null;
    const recordRef = admin.database().ref(`group_tour_photos/${tourId}/${photoId}`);
    const snapshot = await recordRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, reason: 'NOT_FOUND' });
    const record = snapshot.val() || {};
    if (authorization.access.role !== 'admin' && record.userId !== authorization.access.principalId) {
      return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    }
    const deletion = await deleteOwnedGroupPhotoRecord({
      db: admin.database(),
      bucket: admin.storage().bucket(),
      tourId,
      photoId,
      trustedOwnerKeys: [record.userId],
    });
    if (deletion.reason === 'NOT_OWNER') return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    return res.status(200).json({ success: true });
  },
);

/** @param {unknown} value @param {number} maxLength */
const isValidBoundedFirebaseKey = (value, maxLength) => (
  typeof value === 'string' && value.length <= maxLength && isValidFirebaseKey(value)
);

/** @param {any} body */
const normalizeGroupPhotoChatRequest = (body) => {
  const input = {
    tourId: normalizeTourKeyForComparison(body?.tourId),
    photoId: resolveTrimmedString(body?.photoId),
    messageId: resolveTrimmedString(body?.messageId),
    caption: resolveTrimmedString(body?.caption) || '',
    senderName: resolveTrimmedString(body?.senderName) || 'Tour Member',
    clientCreatedAt: Number(body?.clientCreatedAt),
  };
  if (!isValidBoundedFirebaseKey(input.tourId, 768)
    || !isValidBoundedFirebaseKey(input.photoId, 768)
    || !isValidBoundedFirebaseKey(input.messageId, 160)
    || input.caption.length > 500 || input.senderName.length > 100
    || !Number.isFinite(input.clientCreatedAt) || input.clientCreatedAt <= 0) return null;
  return input;
};

/** @param {{ input: any, principalId: string, role: string, serverTimestamp: any }} options */
const buildGroupPhotoChatMessageRecord = ({ input, principalId, role, serverTimestamp }) => ({
  schemaVersion: 2,
  text: input.caption,
  senderName: input.senderName,
  senderId: principalId,
  senderStableId: principalId,
  senderType: role === 'assigned_driver' ? 'driver' : 'passenger',
  timestamp: serverTimestamp,
  clientCreatedAt: input.clientCreatedAt,
  isDriver: role === 'assigned_driver',
  status: 'sent',
  type: 'image',
  idempotencyKey: input.messageId,
  photoId: input.photoId,
});

/** @param {any} message @param {string} messageId */
const buildGroupPhotoChatResponseMessage = (message, messageId) => ({ ...message, id: messageId });

/** @type {(...args: any[]) => any} */
const createGroupPhotoChatMessage = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizeGroupPhotoChatRequest(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const { tourId, photoId, messageId, caption, senderName, clientCreatedAt } = input;
    const authorization = await authorizeGroupMediaRequest({ req, res, tourId });
    if (!authorization) return null;
    const photoSnapshot = await admin.database().ref(`group_tour_photos/${tourId}/${photoId}`).once('value');
    if (!photoSnapshot.exists()) return res.status(404).json({ success: false, reason: 'PHOTO_NOT_FOUND' });
    const message = buildGroupPhotoChatMessageRecord({
      input: { caption, senderName, clientCreatedAt, messageId, photoId },
      principalId: authorization.access.principalId,
      role: authorization.access.role,
      serverTimestamp: admin.database.ServerValue.TIMESTAMP,
    });
    const messageRef = admin.database().ref(`chats/${tourId}/messages/${messageId}`);
    let conflict = false;
    const transaction = await messageRef.transaction(/** @param {any} current */ (current) => {
      if (!current) return message;
      if (current.idempotencyKey === messageId && current.photoId === photoId
        && current.senderId === authorization.access.principalId) return current;
      conflict = true;
      return;
    });
    if (conflict || !transaction.committed) {
      return res.status(409).json({ success: false, reason: 'IDEMPOTENCY_CONFLICT' });
    }
    return res.status(200).json({
      success: true,
      message: buildGroupPhotoChatResponseMessage(transaction.snapshot.val(), messageId),
    });
  },
);


module.exports = {
  acquireMediaRecordLock,
  buildGroupPhotoChatMessageRecord,
  buildGroupPhotoChatResponseMessage,
  createGroupPhotoChatMessage,
  deleteGroupPhoto,
  deleteOwnedGroupPhotoRecord,
  extensionForGroupPhotoContentType,
  normalizeGroupPhotoUploadMetadata,
  mediaRecordFingerprint,
  readStorageObjectGeneration,
  reserveGroupPhotoRecord,
  releaseMediaRecordLock,
  resolveGroupPhotoMedia,
  uploadGroupPhoto,
};
