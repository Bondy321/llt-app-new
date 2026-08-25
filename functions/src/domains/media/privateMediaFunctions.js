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
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('../notifications/notificationPolicy');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

const PRIVATE_PHOTO_CACHE_CONTROL_HEADER = 'private,no-store';
const onRequestWithResult = /** @type {any} */ (onRequest);

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
    const reservation = await reservePrivatePhotoRecord({
      db: admin.database(),
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
    const paths = [record.storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
      .filter((path) => isPrivateMediaPathForRecord({ path, tourId, ownerKey: access.principalId }));
    await Promise.all(paths.map((path) => admin.storage().bucket().file(path).delete({ ignoreNotFound: true })));
    await recordRef.remove();
    return res.status(200).json({ success: true, alreadyDeleted: false });
  },
);


module.exports = {
  deletePrivatePhoto,
  normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord,
  resolvePrivatePhotoMedia,
  uploadPrivatePhoto,
};
