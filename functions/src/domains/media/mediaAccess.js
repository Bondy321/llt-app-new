'use strict';

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { enforceGroupMediaAppCheck } = require('../../infrastructure/auth/appCheckGate');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
} = require('../notifications/notificationPolicy');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PRIVATE_MEDIA_BATCH_LIMIT = 50;
const PRIVATE_MEDIA_URL_TTL_MS = 5 * 60 * 1000;
const GROUP_MEDIA_BATCH_LIMIT = 50;
const GROUP_MEDIA_URL_TTL_MS = 5 * 60 * 1000;
const GROUP_MEDIA_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const GROUP_MEDIA_ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic']);

/** @type {(...args: any[]) => any} */
const normalizePrivateMediaRequest = (body = {}) => {
  const tourId = normalizeTourKeyForComparison(body.tourId);
  const ownerKey = resolveTrimmedString(body.ownerKey);
  const photoIds = Array.isArray(body.photoIds)
    ? [...new Set(body.photoIds.map(resolveTrimmedString).filter(Boolean))]
    : [];
  if (!tourId || !ownerKey || !isValidFirebaseKey(ownerKey) || photoIds.length < 1
    || photoIds.length > PRIVATE_MEDIA_BATCH_LIMIT || photoIds.some((id) => !isValidFirebaseKey(id))) {
    return null;
  }
  return { tourId, ownerKey, photoIds };
};

/** @type {(...args: any[]) => any} */
const isPrivateMediaPathForRecord = ({ path, tourId, ownerKey }) => {
  const normalized = resolveTrimmedString(path);
  return Boolean(normalized && normalized.startsWith(`private_tour_photos/${tourId}/${ownerKey}/`)
    && !normalized.includes('..'));
};

const PRIVATE_MEDIA_READ_CONCURRENCY = 8;
/** @type {(...args: any[]) => Promise<any>} */
const readPrivateMediaRecords = async ({ db, tourId, ownerKey, photoIds, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  /** @type {Record<string, any>} */
  const records = {};
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, photoIds.length) }, async () => {
    while (nextIndex < photoIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const photoId = photoIds[index];
      if (!photoId) continue;
      const snapshot = await db.ref(`private_tour_photos/${tourId}/${ownerKey}/${photoId}`).once('value');
      if (snapshot.exists()) records[photoId] = snapshot.val();
    }
  });
  await Promise.all(workers);
  return records;
};

/** @type {(...args: any[]) => Promise<any>} */
const signPrivateMediaRecords = async ({
  bucket,
  input,
  records,
  expires,
  concurrency = PRIVATE_MEDIA_READ_CONCURRENCY,
}) => {
  /** @type {Record<string, any>} */
  const media = {};
  const tasks = input.photoIds.flatMap(/** @param {string} photoId */ (photoId) => {
    const record = records[photoId];
    if (!record) return [];
    const fields = [
      ['sourceUrl', record.storagePath],
      ['viewerUrl', record.viewerStoragePath],
      ['thumbnailUrl', record.thumbnailStoragePath],
    ];
    return fields
      .filter(([, objectPath]) => isPrivateMediaPathForRecord({ path: objectPath, ...input }))
      .map(([field, objectPath]) => ({ photoId, field, objectPath }));
  });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const [url] = await bucket.file(task.objectPath).getSignedUrl({ action: 'read', expires });
      if (!media[task.photoId]) media[task.photoId] = {};
      media[task.photoId][task.field] = url;
    }
  });
  await Promise.all(workers);
  return media;
};

/** @type {(...args: any[]) => Promise<any>} */
const verifyCurrentTourPhotoAccess = async ({ db, authUid, tourId }) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(tourId)) {
    return { allowed: false, reason: 'INVALID_INPUT' };
  }
  const [tourSnapshot, adminSnapshot] = await Promise.all([
    db.ref(`tours/${tourId}`).once('value'),
    db.ref(`admin_users/${authUid}`).once('value'),
  ]);
  if (!tourSnapshot.exists()) return { allowed: false, reason: 'NOT_FOUND' };
  if (authUid === OPERATIONS_ADMIN_UID || adminSnapshot.val() === true) {
    return { allowed: true, role: 'admin', principalId: authUid };
  }
  const access = await verifyActiveAppSession({ db, authUid, expectedTourId: tourId });
  if (!access.allowed) return { allowed: false, reason: access.reason };
  return {
    allowed: true,
    role: access.role === 'driver' ? 'assigned_driver' : 'passenger',
    principalId: access.principalId,
    driverId: access.driverId,
    session: access.session,
  };
};

/** @type {(...args: any[]) => any} */
const normalizeGroupMediaRequest = (body = {}) => {
  const tourId = normalizeTourKeyForComparison(body.tourId);
  const photoIds = Array.isArray(body.photoIds)
    ? [...new Set(body.photoIds.map(resolveTrimmedString).filter(Boolean))]
    : [];
  if (!tourId || !isValidFirebaseKey(tourId) || photoIds.length < 1
    || photoIds.length > GROUP_MEDIA_BATCH_LIMIT || photoIds.some((id) => !isValidFirebaseKey(id))) {
    return null;
  }
  return { tourId, photoIds };
};

/** @type {(...args: any[]) => any} */
const isGroupMediaPathForRecord = ({ path, tourId }) => {
  const normalized = resolveTrimmedString(path);
  return Boolean(normalized && normalized.startsWith(`group_tour_photos/${tourId}/`)
    && !normalized.includes('..'));
};

/** @type {(...args: any[]) => Promise<any>} */
const readGroupMediaRecords = async ({ db, tourId, photoIds, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  /** @type {Record<string, any>} */
  const records = {};
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, photoIds.length) }, async () => {
    while (nextIndex < photoIds.length) {
      const photoId = photoIds[nextIndex];
      nextIndex += 1;
      const snapshot = await db.ref(`group_tour_photos/${tourId}/${photoId}`).once('value');
      if (snapshot.exists()) records[photoId] = snapshot.val();
    }
  });
  await Promise.all(workers);
  return records;
};

/** @type {(...args: any[]) => Promise<any>} */
const signGroupMediaRecords = async ({ bucket, input, records, expires, concurrency = PRIVATE_MEDIA_READ_CONCURRENCY }) => {
  /** @type {Record<string, any>} */
  const media = {};
  const tasks = input.photoIds.flatMap(/** @param {string} photoId */ (photoId) => {
    const record = records[photoId];
    if (!record) return [];
    return [
      ['sourceUrl', record.storagePath],
      ['viewerUrl', record.viewerStoragePath],
      ['thumbnailUrl', record.thumbnailStoragePath],
    ].filter(([, objectPath]) => isGroupMediaPathForRecord({ path: objectPath, tourId: input.tourId }))
      .map(([field, objectPath]) => ({ photoId, field, objectPath }));
  });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const [url] = await bucket.file(task.objectPath).getSignedUrl({ action: 'read', expires });
      if (!media[task.photoId]) media[task.photoId] = {};
      media[task.photoId][task.field] = url;
    }
  });
  await Promise.all(workers);
  return media;
};


module.exports = {
  enforceGroupMediaAppCheck,
  GROUP_MEDIA_ALLOWED_TYPES,
  GROUP_MEDIA_MAX_UPLOAD_BYTES,
  GROUP_MEDIA_URL_TTL_MS,
  isGroupMediaPathForRecord,
  isPrivateMediaPathForRecord,
  normalizeGroupMediaRequest,
  normalizePrivateMediaRequest,
  PRIVATE_MEDIA_URL_TTL_MS,
  readGroupMediaRecords,
  readPrivateMediaRecords,
  signGroupMediaRecords,
  signPrivateMediaRecords,
  verifyCurrentTourPhotoAccess,
};
