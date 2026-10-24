'use strict';

// @ts-check

const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { admin } = require('../../bootstrap/firebaseAdmin');
const {
  buildPhotoCollectionPath, generatePhotoVariantsForRecord, parseSourcePhotoPath,
} = require('./photoVariants');

/** @type {(...args: any[]) => Promise<any>} */
const findPhotoRecordByStoragePath = async ({
  dbRoot,
  objectPath,
  maxAttempts = 5,
  wait = (/** @type {number} */ delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await dbRoot
      .orderByChild('storagePath')
      .equalTo(objectPath)
      .once('value');
    const [photoId, photoRecord] = Object.entries(snapshot.val() || {})[0] || [];
    if (photoId && photoRecord?.storagePath === objectPath) return { photoId, photoRecord };
    if (attempt < maxAttempts - 1) await wait(Math.min(250 * (2 ** attempt), 2_000));
  }
  return null;
};

/** @type {(...args: any[]) => boolean} */
const isPhotoVariantRecordReady = ({ visibility: _visibility, photoRecord }) => {
  if (photoRecord?.variantStatus !== "ready") return false;
  return Boolean(photoRecord.viewerStoragePath && photoRecord.thumbnailStoragePath);
};

/** @type {(...args: any[]) => Promise<boolean>} */
const ensureUploadPublished = async ({ database, metadata, objectPath, bucketName, dependencies }) => {
    if (metadata.uploadOperationId && metadata.authUid) {
      const operation = (await database.ref(`media_upload_operations/${metadata.authUid}/${metadata.uploadOperationId}`).once('value')).val();
      if (!operation || operation.storagePath !== objectPath) throw new Error('Media upload operation unavailable');
      if (operation.state !== 'committed') {
        if (Number(operation.expiresAtMs) > Date.now() && !['cancelled', 'cleaned'].includes(operation.state)) {
          throw Object.assign(new Error('Media publication is pending'), { code: 'PHOTO_VARIANT_RETRY' });
        }
        if (Number(operation.expiresAtMs) > Date.now()) throw new Error('Cancelled media upload is draining');
        const { cleanupMediaUploadOperation } = require('./mediaUploadCleanup');
        await cleanupMediaUploadOperation({ db: database, bucket: dependencies.bucket || admin.storage().bucket(bucketName),
          authUid: metadata.authUid, operationId: metadata.uploadOperationId });
        return false;
      }
    }
    return true;
};

/** @type {(...args: any[]) => any} */
const parseVariantSourceEvent = event => {
    const objectData = event.data || {};
    const bucketName = objectData.bucket;
    const objectPath = objectData.name || "";
    const metadata = objectData.metadata || {};

    if (!bucketName || !objectPath) {
      return null;
    }

    if (metadata.cancelled === 'true' || (metadata.sourceRole && metadata.sourceRole !== 'source')) return null;
    if (metadata.variant && metadata.variant !== "source") {
      return null;
    }

    const parsed = parseSourcePhotoPath(objectPath);
    if (!parsed) {
      return null;
    }

    const { tourId, visibility, ownerKey } = parsed;
    if (!tourId) {
      return null;
    }

    return { bucketName, objectPath, metadata, tourId, visibility, ownerKey };
};

/** @param {any} event */
const processPhotoVariantObject = async (event, dependencies = {}) => {
    const source = parseVariantSourceEvent(event);
    if (!source) return null;
    const { bucketName, objectPath, metadata, tourId, visibility, ownerKey } = source;
    const database = dependencies.database || admin.database();
    if (!await ensureUploadPublished({ database, metadata, objectPath, bucketName, dependencies })) return null;
    const findRecord = dependencies.findPhotoRecordByStoragePathFn || findPhotoRecordByStoragePath;
    const generateVariants = dependencies.generatePhotoVariantsForRecordFn || generatePhotoVariantsForRecord;
    const dbRoot = database.ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
    const match = await findRecord({ dbRoot, objectPath });
    if (!match) return null;
    const { photoId, photoRecord } = match;
    if (photoRecord._upload && photoRecord._upload.status !== 'complete') {
      throw Object.assign(new Error('Media publication is pending'), { code: 'PHOTO_VARIANT_RETRY' });
    }
    if (isPhotoVariantRecordReady({ visibility, photoRecord })) {
      return null;
    }

    const outcome = await generateVariants({
      bucketName,
      visibility,
      tourId,
      ownerKey,
      photoId,
      photoRecord: {
        ...photoRecord,
        storagePath: objectPath,
      },
    });
    if (outcome?.status === 'retry') {
      const error = /** @type {Error & { code?: string }} */ (
        new Error('Photo variant generation is contended')
      );
      error.code = 'PHOTO_VARIANT_RETRY';
      throw error;
    }

    return null;
  };

const generatePhotoVariants = onObjectFinalized(
  {
    // Storage triggers must run in the same region as the bucket.
    // We keep this trigger in us-east1 to match Firebase free-tier bucket location.
    region: "us-east1",
    maxInstances: 10,
    timeoutSeconds: 120,
    memory: '512MiB',
    concurrency: 2,
    retry: true,
  },
  processPhotoVariantObject,
);
/**
 * Trigger: When the itinerary is published, updated, or withdrawn.
 * Enhanced with validation, better error handling, and performance tracking
 */

module.exports = { generatePhotoVariants, findPhotoRecordByStoragePath, isPhotoVariantRecordReady, processPhotoVariantObject };
