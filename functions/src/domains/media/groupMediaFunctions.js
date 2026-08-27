'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
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
const onRequestWithResult = /** @type {any} */ (onRequest);

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
    const reservation = await reserveGroupPhotoRecord({
      db: admin.database(),
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
    const paths = [record.storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
      .filter((path) => isGroupMediaPathForRecord({ path, tourId }));
    await Promise.all(paths.map(async (path) => {
      try {
        await admin.storage().bucket().file(path).delete();
      } catch (error) {
        const details = /** @type {{ code?: unknown }} */ (error || {});
        if (details.code !== 404) throw error;
      }
    }));
    await recordRef.remove();
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
  buildGroupPhotoChatMessageRecord,
  buildGroupPhotoChatResponseMessage,
  createGroupPhotoChatMessage,
  deleteGroupPhoto,
  extensionForGroupPhotoContentType,
  normalizeGroupPhotoUploadMetadata,
  reserveGroupPhotoRecord,
  resolveGroupPhotoMedia,
  uploadGroupPhoto,
};
