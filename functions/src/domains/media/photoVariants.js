'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { createPhotoVariantBuffers } = require('../../infrastructure/storage/mediaProcessor');

const PHOTO_CACHE_CONTROL_HEADER = 'private,max-age=300,no-transform';

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

  try {
    const sourceFile = resolvedBucket.file(objectPath);
    const [sourceBuffer] = await sourceFile.download();
    const [sourceObjectMetadata] = await sourceFile.getMetadata();
    if (visibility === 'private') await hardenPrivateSourceObjectMetadata(sourceFile, sourceObjectMetadata);
    else await hardenGroupSourceObjectMetadata(sourceFile);
    const { viewerBuffer, thumbnailBuffer } = await createPhotoVariantBuffers(sourceBuffer);
    await Promise.all([
      resolvedBucket.file(viewerPath).save(viewerBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: buildVariantObjectMetadata(visibility, 'viewer'),
        },
      }),
      resolvedBucket.file(thumbnailPath).save(thumbnailBuffer, {
        metadata: {
          contentType: "image/jpeg",
          cacheControl: PHOTO_CACHE_CONTROL_HEADER,
          metadata: buildVariantObjectMetadata(visibility, 'thumbnail'),
        },
      }),
    ]);

    await resolvedDbRoot.child(photoId).update({
      viewerUrl: null,
      viewerStoragePath: viewerPath,
      thumbnailUrl: null,
      thumbnailStoragePath: thumbnailPath,
      variantStatus: "ready",
      variantUpdatedAt: Date.now(),
      variantError: null,
    });

    return { status: "ready", photoId, viewerPath, thumbnailPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Variant generation failed';
    await resolvedDbRoot.child(photoId).update({
      variantStatus: "failed",
      variantUpdatedAt: Date.now(),
      variantError: errorMessage,
    });

    return {
      status: "failed",
      photoId,
      error: errorMessage,
    };
  }
};

/**
 * Verifies that an admin broadcast is legitimate by checking the senderUid.
 * Rejects messages that claim admin status without a verified non-anonymous auth UID.
 */

module.exports = {
  buildPhotoCollectionPath,
  buildPhotoVariantPaths,
  generatePhotoVariantsForRecord,
  hardenGroupSourceObjectMetadata,
  hardenPrivateSourceObjectMetadata,
  parseSourcePhotoPath,
};
