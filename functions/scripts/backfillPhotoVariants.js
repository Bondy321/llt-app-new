#!/usr/bin/env node

const admin = require('firebase-admin');
const { __testables } = require('../index');

const DEFAULT_LIMIT = 50;

const parseArgs = (argv = []) => {
  const options = {
    dryRun: true,
    limit: DEFAULT_LIMIT,
    visibility: 'all',
    tourId: null,
    ownerKey: null,
    retryFailed: true,
  };

  argv.forEach((arg) => {
    if (arg === '--apply') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-retry-failed') {
      options.retryFailed = false;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.min(parsed, 500);
      }
    } else if (arg.startsWith('--visibility=')) {
      const visibility = arg.slice('--visibility='.length);
      if (['all', 'group', 'private'].includes(visibility)) {
        options.visibility = visibility;
      }
    } else if (arg.startsWith('--tourId=')) {
      options.tourId = arg.slice('--tourId='.length) || null;
    } else if (arg.startsWith('--ownerKey=')) {
      options.ownerKey = arg.slice('--ownerKey='.length) || null;
    }
  });

  return options;
};

const getConfiguredBucketName = () => {
  try {
    const config = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : {};
    if (config.storageBucket) return config.storageBucket;
  } catch {
    // Fall through to Admin SDK default bucket.
  }

  const bucket = admin.storage().bucket();
  return bucket?.name || null;
};

const shouldBackfill = (photo, { retryFailed }) => {
  if (!photo || typeof photo !== 'object') return false;
  if (!photo.storagePath) return false;
  if (!photo.viewerUrl || !photo.thumbnailUrl) return true;
  return retryFailed && photo.variantStatus === 'failed';
};

const collectGroupCandidates = async ({ tourId, remaining, retryFailed }) => {
  const rootPath = tourId ? `group_tour_photos/${tourId}` : 'group_tour_photos';
  const snapshot = await admin.database().ref(rootPath).once('value');
  const value = snapshot.val() || {};
  const candidates = [];

  const tours = tourId ? { [tourId]: value } : value;
  Object.entries(tours).some(([currentTourId, photosById]) => {
    Object.entries(photosById || {}).some(([photoId, photoRecord]) => {
      if (shouldBackfill(photoRecord, { retryFailed })) {
        candidates.push({
          visibility: 'group',
          tourId: currentTourId,
          ownerKey: null,
          photoId,
          photoRecord,
        });
      }
      return candidates.length >= remaining;
    });
    return candidates.length >= remaining;
  });

  return candidates;
};

const collectPrivateCandidates = async ({ tourId, ownerKey, remaining, retryFailed }) => {
  const rootPath = tourId
    ? (ownerKey ? `private_tour_photos/${tourId}/${ownerKey}` : `private_tour_photos/${tourId}`)
    : 'private_tour_photos';
  const snapshot = await admin.database().ref(rootPath).once('value');
  const value = snapshot.val() || {};
  const candidates = [];

  const tours = tourId ? { [tourId]: ownerKey ? { [ownerKey]: value } : value } : value;
  Object.entries(tours).some(([currentTourId, ownersByKey]) => {
    Object.entries(ownersByKey || {}).some(([currentOwnerKey, photosById]) => {
      Object.entries(photosById || {}).some(([photoId, photoRecord]) => {
        if (shouldBackfill(photoRecord, { retryFailed })) {
          candidates.push({
            visibility: 'private',
            tourId: currentTourId,
            ownerKey: currentOwnerKey,
            photoId,
            photoRecord,
          });
        }
        return candidates.length >= remaining;
      });
      return candidates.length >= remaining;
    });
    return candidates.length >= remaining;
  });

  return candidates;
};

const collectCandidates = async (options) => {
  const candidates = [];

  if (options.visibility === 'all' || options.visibility === 'group') {
    candidates.push(...await collectGroupCandidates({
      tourId: options.tourId,
      remaining: options.limit - candidates.length,
      retryFailed: options.retryFailed,
    }));
  }

  if (candidates.length < options.limit && (options.visibility === 'all' || options.visibility === 'private')) {
    candidates.push(...await collectPrivateCandidates({
      tourId: options.tourId,
      ownerKey: options.ownerKey,
      remaining: options.limit - candidates.length,
      retryFailed: options.retryFailed,
    }));
  }

  return candidates.slice(0, options.limit);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const bucketName = getConfiguredBucketName();
  if (!bucketName) {
    throw new Error('Could not resolve Firebase Storage bucket name');
  }

  const candidates = await collectCandidates(options);
  console.log(JSON.stringify({
    mode: options.dryRun ? 'dry-run' : 'apply',
    bucketName,
    candidateCount: candidates.length,
    limit: options.limit,
  }));

  const results = [];
  for (const candidate of candidates) {
    const result = await __testables.generatePhotoVariantsForRecord({
      bucketName,
      dryRun: options.dryRun,
      ...candidate,
    });
    results.push({ ...candidate, photoRecord: undefined, result });
    console.log(JSON.stringify({
      visibility: candidate.visibility,
      tourId: candidate.tourId,
      ownerKey: candidate.ownerKey,
      photoId: candidate.photoId,
      result,
    }));
  }

  const summary = results.reduce((acc, item) => {
    const status = item.result?.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ summary }));
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
