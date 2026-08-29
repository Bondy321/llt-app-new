'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { createPhotoVariantBuffers } = require('../../infrastructure/storage/mediaProcessor');
const {
  acquireMediaRecordLock,
  mediaRecordFingerprint,
  releaseMediaRecordLock,
} = require('./groupMediaFunctions');

const PHOTO_CACHE_CONTROL_HEADER = 'private,max-age=300,no-transform';

/** @type {(...args: any[]) => Promise<any>} */
const cleanupCreatedPhotoVariants = async (createdVariants) => {
  const failures = [];
  for (const created of createdVariants) {
    let generation = created.generation;
    if (!generation && typeof created.file?.getMetadata === 'function') {
      try {
        const [metadata] = await created.file.getMetadata();
        generation = metadata?.generation || null;
      } catch (error) {
        if (Number(error?.code) === 404) continue;
        failures.push(error);
        continue;
      }
    }
    if (!generation || typeof created.file?.delete !== 'function') continue;
    try {
      await created.file.delete({ ignoreNotFound: true, ifGenerationMatch: String(generation) });
    } catch (error) {
      // A 412 means a successor generation now owns the deterministic path;
      // never delete it without an exact generation match.
      if (![404, 412].includes(Number(error?.code))) failures.push(error);
    }
  }
  return { cleaned: failures.length === 0, failureCount: failures.length };
};

/** @param {string} visibility @param {string} sourceRole */
const buildVariantObjectMetadata = (visibility, sourceRole) => ({
  visibility: visibility === 'private' ? 'private' : 'group',
  sourceRole,
});

/** @type {(...args: any[]) => any} */
const parseSourcePhotoPath = (objectPath = "") => {
  const groupMatch = objectPath.match(/^group_tour_photos\/([^/]+)\/([^/]+)$/);
  if (groupMatch) {
    return {
      visibility: "group",
      tourId: groupMatch[1],
      ownerKey: null,
      filename: groupMatch[2],
    };
  }

  const privateMatch = objectPath.match(/^private_tour_photos\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (privateMatch) {
    return {
      visibility: "private",
      tourId: privateMatch[1],
      ownerKey: privateMatch[2],
      filename: privateMatch[3],
    };
  }

  return null;
};

/** @type {(...args: any[]) => any} */
const buildPhotoCollectionPath = ({ visibility, tourId, ownerKey }) => {
  if (visibility === "private") {
    return `private_tour_photos/${tourId}/${ownerKey}`;
  }
  return `group_tour_photos/${tourId}`;
};

/** @type {(...args: any[]) => any} */
const buildPhotoVariantPaths = ({ visibility, tourId, ownerKey, filename }) => {
  const extensionlessName = filename.replace(/\.[^/.]+$/, "");
  const viewerPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/viewers/${extensionlessName}_viewer.jpg`
    : `group_tour_photos/${tourId}/viewers/${extensionlessName}_viewer.jpg`;
  const thumbnailPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/thumbnails/${extensionlessName}_thumb.jpg`
    : `group_tour_photos/${tourId}/thumbnails/${extensionlessName}_thumb.jpg`;

  return { viewerPath, thumbnailPath };
};

/** @type {(...args: any[]) => Promise<any>} */
const hardenPrivateSourceObjectMetadata = async (sourceFile, suppliedObjectMetadata = null) => {
  const objectMetadata = suppliedObjectMetadata || (await sourceFile.getMetadata())[0];
  const current = objectMetadata?.metadata || {};
  await sourceFile.setMetadata({
    metadata: {
      ...(typeof current.authUid === 'string' && current.authUid ? { authUid: current.authUid } : {}),
      visibility: 'private',
      sourceRole: 'source',
      firebaseStorageDownloadTokens: null,
    },
  });
};

/** @type {(...args: any[]) => Promise<any>} */
const hardenGroupSourceObjectMetadata = async (sourceFile) => {
  await sourceFile.setMetadata({
    metadata: {
      visibility: 'group',
      sourceRole: 'source',
      firebaseStorageDownloadTokens: null,
    },
  });
};

/** @type {(...args: any[]) => Promise<any>} */
// eslint-disable-next-line complexity -- exact generation cleanup covers every partial Storage failure boundary
const generatePhotoVariantsForRecord = async (options) => {
  const {
    bucketName, visibility, tourId, photoId, photoRecord, dryRun, storageBucket, dbRoot,
  } = options;
  const ownerKey = options.ownerKey === undefined ? null : options.ownerKey;
  const objectPath = typeof photoRecord?.storagePath === "string" ? photoRecord.storagePath : "";
  if (!bucketName || !objectPath || !photoId || !tourId) {
    return { status: "skipped", reason: "missing-required-fields" };
  }

  const filename = objectPath.split("/").pop();
  if (!filename) {
    return { status: "skipped", reason: "missing-filename" };
  }

  const { viewerPath, thumbnailPath } = buildPhotoVariantPaths({
    visibility,
    tourId,
    ownerKey,
    filename,
  });

  if (dryRun) {
    return {
      status: "dry-run",
      photoId,
      objectPath,
      viewerPath,
      thumbnailPath,
    };
  }

  const resolvedDbRoot = dbRoot || admin.database().ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
  const resolvedBucket = storageBucket || admin.storage().bucket(bucketName);
  const resolvedDatabase = options.database || (!dbRoot ? admin.database() : null);
  const acquireLock = options.acquireMediaRecordLockFn || acquireMediaRecordLock;
  const releaseLock = options.releaseMediaRecordLockFn || releaseMediaRecordLock;
  if (!resolvedDatabase && !options.acquireMediaRecordLockFn) {
    throw new Error('Variant generation requires a media-lock database');
  }
  const lock = await acquireLock({
    db: resolvedDatabase,
    visibility,
    tourId,
    ownerKey,
    photoId,
  });
  if (!lock?.acquired) return { status: 'retry', reason: 'media-mutation-in-progress', photoId };
  const recordRef = resolvedDbRoot.child(photoId);
  let baselineFingerprint = null;
  const createdVariants = [];

  try {
    const currentSnapshot = await recordRef.once('value');
    const currentRecord = currentSnapshot.val();
    if (!currentSnapshot.exists() || !currentRecord || currentRecord._serverDeletion?.status === 'deleting'
      || currentRecord.storagePath !== objectPath) {
      return { status: 'skipped', reason: 'record-changed', photoId };
    }
    baselineFingerprint = mediaRecordFingerprint(currentRecord);
    // Publish deterministic target paths before the first external write. If
    // the process dies after a Storage save, deletion can still discover and
    // generation-capture every possible variant under the same record lock.
    const targets = await recordRef.transaction((current) => {
      if (!current || current._serverDeletion?.status === 'deleting'
        || mediaRecordFingerprint(current) !== baselineFingerprint) return undefined;
      return {
        ...current,
        viewerStoragePath: viewerPath,
        thumbnailStoragePath: thumbnailPath,
        variantStatus: 'processing',
        variantUpdatedAt: Date.now(),
        variantError: null,
      };
    }, undefined, false);
    if (!targets?.committed) return { status: 'skipped', reason: 'record-changed', photoId };
    baselineFingerprint = mediaRecordFingerprint(targets.snapshot.val());
    const sourceFile = resolvedBucket.file(objectPath);
    const [sourceBuffer] = await sourceFile.download();
    const [sourceObjectMetadata] = await sourceFile.getMetadata();
    if (visibility === 'private') await hardenPrivateSourceObjectMetadata(sourceFile, sourceObjectMetadata);
    else await hardenGroupSourceObjectMetadata(sourceFile);
    const { viewerBuffer, thumbnailBuffer } = await createPhotoVariantBuffers(sourceBuffer);
    for (const [path, buffer, sourceRole] of [
      [viewerPath, viewerBuffer, 'viewer'],
      [thumbnailPath, thumbnailBuffer, 'thumbnail'],
    ]) {
      const variantFile = resolvedBucket.file(path);
      await variantFile.save(buffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: buildVariantObjectMetadata(visibility, sourceRole),
        },
      });
      const createdVariant = { file: variantFile, generation: null };
      createdVariants.push(createdVariant);
      const [variantMetadata] = typeof variantFile.getMetadata === 'function'
        ? await variantFile.getMetadata()
        : [null];
      createdVariant.generation = variantMetadata?.generation || null;
    }

    const update = await recordRef.transaction((current) => {
      if (!current || current._serverDeletion?.status === 'deleting'
        || mediaRecordFingerprint(current) !== baselineFingerprint) return undefined;
      return {
        ...current,
        viewerUrl: null,
        viewerStoragePath: viewerPath,
        thumbnailUrl: null,
        thumbnailStoragePath: thumbnailPath,
        variantStatus: 'ready',
        variantUpdatedAt: Date.now(),
        variantError: null,
      };
    }, undefined, false);
    if (!update?.committed) {
      await cleanupCreatedPhotoVariants(createdVariants);
      return { status: 'skipped', reason: 'record-changed', photoId };
    }

    return { status: "ready", photoId, viewerPath, thumbnailPath };
  } catch (error) {
    await cleanupCreatedPhotoVariants(createdVariants);
    const errorCode = typeof error?.code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/u.test(error.code)
      ? error.code
      : 'VARIANT_GENERATION_FAILED';
    await recordRef.transaction((current) => {
      if (!current || current._serverDeletion?.status === 'deleting'
        || !baselineFingerprint || mediaRecordFingerprint(current) !== baselineFingerprint) return undefined;
      return {
        ...current,
        // Retain the deterministic paths even if cleanup itself was
        // unavailable, so later trusted deletion can discover both objects.
        viewerStoragePath: viewerPath,
        thumbnailStoragePath: thumbnailPath,
        variantStatus: 'failed',
        variantUpdatedAt: Date.now(),
        variantError: errorCode,
      };
    }, undefined, false);

    return {
      status: "failed",
      photoId,
      error: errorCode,
    };
  } finally {
    await releaseLock(lock);
  }
};

/**
 * Verifies that an admin broadcast is legitimate by checking the senderUid.
 * Rejects messages that claim admin status without a verified non-anonymous auth UID.
 */

module.exports = {
  buildPhotoCollectionPath,
  buildPhotoVariantPaths,
  cleanupCreatedPhotoVariants,
  generatePhotoVariantsForRecord,
  hardenGroupSourceObjectMetadata,
  hardenPrivateSourceObjectMetadata,
  parseSourcePhotoPath,
};
