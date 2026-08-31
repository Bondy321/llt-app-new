'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  GROUP_MEDIA_ALLOWED_TYPES,
  GROUP_MEDIA_MAX_UPLOAD_BYTES,
  isPrivateMediaPathForRecord,
  normalizePrivateMediaRequest,
  PRIVATE_MEDIA_URL_TTL_MS,
  readPrivateMediaRecords,
  signPrivateMediaRecords,
} = require('./mediaAccess');
const {
  extensionForGroupPhotoContentType,
  normalizeGroupPhotoUploadMetadata,
} = require('./mediaUploadMetadata');
const {
  acquireMediaRecordLock,
  mediaRecordFingerprint,
  readStorageObjectGeneration,
  releaseMediaRecordLock,
} = require('./groupMediaFunctions');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('../../infrastructure/validation/stringNormalization');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

const PRIVATE_PHOTO_CACHE_CONTROL_HEADER = 'private,no-store';
const onRequestWithResult = /** @type {any} */ (onRequest);

const deletePrivateStorageObjectIgnoringMissing = async (bucket, path, expectedGeneration) => {
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
    const code = /** @type {{ code?: unknown }} */ (error || {}).code;
    if (code === 412 || code === '412') {
      const changed = /** @type {Error & { code?: string }} */ (new Error('Storage object changed'));
      changed.code = 'MEDIA_OBJECT_CHANGED';
      throw changed;
    }
    if (code !== 404 && code !== '404') throw error;
    return false;
  }
};

/**
 * Deletes only an exact private-photo record owned by a trusted private owner.
 * @param {{ db: any, bucket: any, tourId: string, ownerKey: string, photoId: string, trustedOwnerKeys: string[], assertCanDelete?: (() => Promise<any>) }} options
 */
const deleteOwnedPrivatePhotoRecordUnlocked = async ({
  db, bucket, tourId, ownerKey, photoId, trustedOwnerKeys, assertCanDelete = null,
// eslint-disable-next-line complexity -- exact owner/path comparison intentionally fails closed at each field
}) => {
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(ownerKey) || !isValidFirebaseKey(photoId)) {
    throw new Error('Invalid private photo key');
  }
  const owners = new Set((Array.isArray(trustedOwnerKeys) ? trustedOwnerKeys : []).filter(isValidFirebaseKey));
  if (!owners.has(ownerKey)) throw new Error('Trusted private photo owner is required');
  const recordRef = db.ref(`private_tour_photos/${tourId}/${ownerKey}/${photoId}`);
  const snapshot = await recordRef.once('value');
  if (!snapshot.exists()) return { deleted: false, alreadyDeleted: true, storageObjectsRemoved: 0 };
  const observed = snapshot.val() || {};
  if (!owners.has(observed.userId) || observed.userId !== ownerKey) {
    return { deleted: false, alreadyDeleted: false, reason: 'NOT_OWNER' };
  }
  const captured = {
    userId: observed.userId,
    storagePath: observed.storagePath ?? null,
    viewerStoragePath: observed.viewerStoragePath ?? null,
    thumbnailStoragePath: observed.thumbnailStoragePath ?? null,
  };
  const capturedPaths = [captured.storagePath, captured.viewerStoragePath, captured.thumbnailStoragePath];
  if (capturedPaths.some((path) => path !== null
    && !isPrivateMediaPathForRecord({ path, tourId, ownerKey }))) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Private photo path is invalid'));
    error.code = 'MEDIA_PATH_INVALID';
    throw error;
  }
  const fingerprint = mediaRecordFingerprint(observed);
  const existingClaim = observed._serverDeletion?.status === 'deleting'
    ? observed._serverDeletion
    : null;
  if (existingClaim && (existingClaim.recordFingerprint !== fingerprint
    || !existingClaim.generations || typeof existingClaim.generations !== 'object')) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Private photo claim changed'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  const generations = existingClaim?.generations || {};
  if (!existingClaim) {
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
  }
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
    const error = /** @type {Error & { code?: string }} */ (new Error('Private photo claim changed'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  const paths = [...new Set(capturedPaths.filter((path) => path !== null))];
  for (const path of paths) {
    if (assertCanDelete) await assertCanDelete();
    const field = ['storagePath', 'viewerStoragePath', 'thumbnailStoragePath']
      .find((candidate) => captured[candidate] === path);
    await deletePrivateStorageObjectIgnoringMissing(bucket, path, generations[field]);
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
    const error = /** @type {Error & { code?: string }} */ (new Error('Private photo changed during deletion'));
    error.code = 'MEDIA_RECORD_CHANGED';
    throw error;
  }
  return { deleted: true, alreadyDeleted: false, storageObjectsRemoved: paths.length };
};

const deleteOwnedPrivatePhotoRecord = async (options) => {
  const lock = await acquireMediaRecordLock({
    db: options.db,
    visibility: 'private',
    tourId: options.tourId,
    ownerKey: options.ownerKey,
    photoId: options.photoId,
  });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Private photo mutation in progress'));
    error.code = 'MEDIA_MUTATION_IN_PROGRESS';
    throw error;
  }
  try {
    return await deleteOwnedPrivatePhotoRecordUnlocked(options);
  } finally {
    await releaseMediaRecordLock(lock);
  }
};

/** @type {(...args: any[]) => any} */
const resolvePrivatePhotoMedia = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const input = normalizePrivateMediaRequest(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: input.tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed || access.principalId !== input.ownerKey) {
      return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    }
    const records = await readPrivateMediaRecords({ db: admin.database(), ...input });
    if (Object.keys(records).length === 0) return res.status(404).json({ success: false, reason: 'NOT_FOUND' });
    const bucket = admin.storage().bucket();
    const expires = Date.now() + PRIVATE_MEDIA_URL_TTL_MS;
    const media = await signPrivateMediaRecords({ bucket, input, records, expires });
    return res.status(200).json({ success: true, expiresAtMs: expires, media });
  },
);

/** @type {(...args: any[]) => any} */
const normalizePrivatePhotoUploadMetadata = (rawHeader) => {
  const input = normalizeGroupPhotoUploadMetadata(rawHeader);
  return input ? { ...input, uploaderName: undefined } : null;
};

/** @type {(...args: any[]) => Promise<any>} */
const reservePrivatePhotoRecord = async ({ db, input, principalId, contentType, fileSize, nowMs = Date.now() }) => {
  const photoId = toRealtimeKeySegment(input.idempotencyKey);
  const extension = extensionForGroupPhotoContentType(contentType);
  const storagePath = `private_tour_photos/${input.tourId}/${principalId}/${photoId}.${extension}`;
  const recordRef = db.ref(`private_tour_photos/${input.tourId}/${principalId}/${photoId}`);
  let conflict = false;
  let deduped = false;
  const result = await recordRef.transaction(/** @param {any} current */ (current) => {
    if (current) {
      if (current._serverDeletion?.status === 'deleting') {
        conflict = true;
        return undefined;
      }
      if (current.idempotencyKey === input.idempotencyKey && current.userId === principalId
        && current.storagePath === storagePath) {
        deduped = true;
        return current;
      }
      conflict = true;
      return undefined;
    }
    return {
      userId: principalId,
      caption: input.caption,
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
const uploadPrivatePhoto = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 60, memory: '512MiB', cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const input = normalizePrivatePhotoUploadMetadata(req.headers['x-private-photo-metadata']);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: input.tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed) return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    const contentType = resolveTrimmedString(req.headers['content-type'])?.toLowerCase();
    const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!body || body.length < 1 || body.length > GROUP_MEDIA_MAX_UPLOAD_BYTES
      || !GROUP_MEDIA_ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({ success: false, reason: 'INVALID_IMAGE' });
    }
    const db = admin.database();
    const photoId = toRealtimeKeySegment(input.idempotencyKey);
    const mutationLock = await acquireMediaRecordLock({
      db,
      visibility: 'private',
      tourId: input.tourId,
      ownerKey: access.principalId,
      photoId,
    });
    if (!mutationLock.acquired) {
      return res.status(409).json({ success: false, reason: 'MEDIA_MUTATION_IN_PROGRESS' });
    }
    try {
      const reservation = await reservePrivatePhotoRecord({
        db,
        input,
        principalId: access.principalId,
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
            cacheControl: PRIVATE_PHOTO_CACHE_CONTROL_HEADER,
            metadata: { visibility: 'private', sourceRole: 'source' },
          },
        });
      }
      return res.status(200).json({
        success: true,
        photo: {
          id: reservation.photoId,
          userId: access.principalId,
          caption: input.caption,
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
const deletePrivatePhoto = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: true },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    res.set('Cache-Control', 'private,no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    const photoId = resolveTrimmedString(req.body?.photoId);
    if (!tourId || !isValidFirebaseKey(tourId) || !photoId || !isValidFirebaseKey(photoId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }
    const requestAuth = await authorizeAppSessionMobileRequest({ req, res });
    if (!requestAuth) return null;
    const access = await verifyActiveAppSession({
      db: admin.database(),
      authUid: requestAuth.uid,
      expectedTourId: tourId,
      expectedRole: 'passenger',
    });
    if (!access.allowed) return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
    const recordRef = admin.database().ref(`private_tour_photos/${tourId}/${access.principalId}/${photoId}`);
    const snapshot = await recordRef.once('value');
    if (!snapshot.exists()) return res.status(200).json({ success: true, alreadyDeleted: true });
    const record = snapshot.val() || {};
    if (record.userId !== access.principalId) {
      return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    }
    const deletion = await deleteOwnedPrivatePhotoRecord({
      db: admin.database(),
      bucket: admin.storage().bucket(),
      tourId,
      ownerKey: access.principalId,
      photoId,
      trustedOwnerKeys: [access.principalId],
    });
    if (deletion.reason === 'NOT_OWNER') return res.status(403).json({ success: false, reason: 'NOT_OWNER' });
    return res.status(200).json({ success: true, alreadyDeleted: deletion.alreadyDeleted });
  },
);


module.exports = {
  deletePrivatePhoto,
  deleteOwnedPrivatePhotoRecord,
  normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord,
  resolvePrivatePhotoMedia,
  uploadPrivatePhoto,
};
