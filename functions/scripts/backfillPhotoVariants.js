#!/usr/bin/env node

const {
  isPlainObject,
  parseBooleanFlag,
  parsePositiveInteger,
  trimString,
} = require('./scriptUtils');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const VALID_VISIBILITIES = new Set(['all', 'group', 'private']);

const loadFirebaseAdmin = () => {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin;
};

const loadGeneratePhotoVariantsForRecord = () => {
  const { __testables } = require('../index');
  return __testables.generatePhotoVariantsForRecord;
};

const parseArgs = (argv = []) => {
  const options = {
    dryRun: true,
    limit: DEFAULT_LIMIT,
    visibility: 'all',
    tourId: null,
    ownerKey: null,
    afterCursor: null,
    retryFailed: true,
    refreshGroupOwnership: false,
    allowFullScan: false,
  };

  argv.forEach((arg) => {
    if (arg === '--apply') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--dry-run=')) {
      const raw = arg.slice('--dry-run='.length).trim().toLowerCase();
      options.dryRun = !['false', '0', 'no'].includes(raw);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(arg.slice('--limit='.length), {
        defaultValue: DEFAULT_LIMIT,
        max: MAX_LIMIT,
      });
    } else if (arg.startsWith('--visibility=')) {
      const visibility = arg.slice('--visibility='.length);
      if (VALID_VISIBILITIES.has(visibility)) {
        options.visibility = visibility;
      }
    } else if (arg.startsWith('--tourId=')) {
      options.tourId = trimString(arg.slice('--tourId='.length));
    } else if (arg.startsWith('--ownerKey=')) {
      options.ownerKey = trimString(arg.slice('--ownerKey='.length));
    } else if (arg.startsWith('--after=')) {
      options.afterCursor = trimString(arg.slice('--after='.length));
    }
  });

  options.retryFailed = parseBooleanFlag(argv, 'retry-failed', options.retryFailed);
  options.refreshGroupOwnership = parseBooleanFlag(argv, 'refresh-group-ownership', options.refreshGroupOwnership);
  options.allowFullScan = parseBooleanFlag(argv, 'allow-full-scan', options.allowFullScan);

  return options;
};

const getConfiguredBucketName = (admin) => {
  try {
    const config = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : {};
    if (config.storageBucket) return config.storageBucket;
  } catch {
    // Fall through to Admin SDK default bucket.
  }

  const bucket = admin.storage().bucket();
  return bucket?.name || null;
};

const shouldBackfill = (photo, { retryFailed, force = false }) => {
  if (!isPlainObject(photo)) return false;
  if (!trimString(photo.storagePath)) return false;
  if (force) return true;
  if (!trimString(photo.viewerUrl) || !trimString(photo.thumbnailUrl)) return true;
  return retryFailed && photo.variantStatus === 'failed';
};

const compareKeys = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const collectGroupCandidates = async ({ db, tourId, remaining, retryFailed, refreshGroupOwnership, afterCursor }) => {
  if (remaining <= 0) return { candidates: [], scannedPhotos: 0 };

  const rootPath = tourId ? `group_tour_photos/${tourId}` : 'group_tour_photos';
  let rootRef = db.ref(rootPath);
  if (refreshGroupOwnership) {
    rootRef = rootRef.orderByKey();
    if (afterCursor) rootRef = rootRef.startAt(afterCursor);
    rootRef = rootRef.limitToFirst(remaining + (afterCursor ? 2 : 1));
  }
  const snapshot = await rootRef.once('value');
  const value = snapshot.val() || {};
  const candidates = [];
  let scannedPhotos = 0;

  if (refreshGroupOwnership) {
    const unseen = Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .filter(([photoId]) => !afterCursor || compareKeys(photoId, afterCursor) > 0);
    const page = unseen.slice(0, remaining);
    page.forEach(([photoId, photoRecord]) => {
      scannedPhotos += 1;
      if (shouldBackfill(photoRecord, { retryFailed, force: true })) {
        candidates.push({ visibility: 'group', tourId, ownerKey: null, photoId, photoRecord });
      }
    });
    return {
      candidates,
      scannedPhotos,
      nextCursor: unseen.length > remaining && page.length ? page.at(-1)[0] : null,
    };
  }

  const tours = tourId ? { [tourId]: value } : value;
  Object.entries(tours).some(([currentTourId, photosById]) => {
    Object.entries(photosById || {}).some(([photoId, photoRecord]) => {
      scannedPhotos += 1;
      if (shouldBackfill(photoRecord, { retryFailed, force: refreshGroupOwnership })) {
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

  return { candidates, scannedPhotos, nextCursor: null };
};

const collectPrivateCandidates = async ({ db, tourId, ownerKey, remaining, retryFailed }) => {
  if (remaining <= 0) return { candidates: [], scannedPhotos: 0 };

  const rootPath = tourId
    ? (ownerKey ? `private_tour_photos/${tourId}/${ownerKey}` : `private_tour_photos/${tourId}`)
    : 'private_tour_photos';
  const snapshot = await db.ref(rootPath).once('value');
  const value = snapshot.val() || {};
  const candidates = [];
  let scannedPhotos = 0;

  const tours = tourId ? { [tourId]: ownerKey ? { [ownerKey]: value } : value } : value;
  Object.entries(tours).some(([currentTourId, ownersByKey]) => {
    Object.entries(ownersByKey || {}).some(([currentOwnerKey, photosById]) => {
      Object.entries(photosById || {}).some(([photoId, photoRecord]) => {
        scannedPhotos += 1;
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

  return { candidates, scannedPhotos };
};

const collectCandidates = async (options, deps = {}) => {
  const db = deps.db;
  const candidates = [];
  const scan = { groupPhotos: 0, privatePhotos: 0 };
  let nextCursor = null;

  if (options.visibility === 'all' || options.visibility === 'group') {
    const groupResult = await collectGroupCandidates({
      db,
      tourId: options.tourId,
      remaining: options.limit - candidates.length,
      retryFailed: options.retryFailed,
      refreshGroupOwnership: options.refreshGroupOwnership,
      afterCursor: options.afterCursor,
    });
    candidates.push(...groupResult.candidates);
    scan.groupPhotos += groupResult.scannedPhotos;
    nextCursor = groupResult.nextCursor || null;
  }

  if (candidates.length < options.limit && (options.visibility === 'all' || options.visibility === 'private')) {
    const privateResult = await collectPrivateCandidates({
      db,
      tourId: options.tourId,
      ownerKey: options.ownerKey,
      remaining: options.limit - candidates.length,
      retryFailed: options.retryFailed,
    });
    candidates.push(...privateResult.candidates);
    scan.privatePhotos += privateResult.scannedPhotos;
  }

  return {
    candidates: candidates.slice(0, options.limit),
    scan,
    nextCursor,
  };
};

const validateOptions = (options = {}) => {
  if (options.ownerKey && !options.tourId) {
    throw new Error('--ownerKey requires --tourId so the private owner path is unambiguous');
  }

  if (options.ownerKey && options.visibility === 'group') {
    throw new Error('--ownerKey can only be used with --visibility=private or --visibility=all');
  }

  if (options.refreshGroupOwnership && (!options.tourId || options.visibility !== 'group')) {
    throw new Error('--refresh-group-ownership requires --visibility=group and an exact --tourId');
  }

  if (options.afterCursor && !options.refreshGroupOwnership) {
    throw new Error('--after is supported only with --refresh-group-ownership');
  }

  if (options.dryRun === false && !options.allowFullScan && !options.tourId) {
    throw new Error('Refusing to apply a photo variant backfill across all tours without --tourId or --allow-full-scan');
  }
};

const run = async (options = {}, deps = {}) => {
  const dryRun = options.dryRun !== false;
  const resolvedOptions = {
    ...parseArgs([]),
    ...options,
    dryRun,
  };
  validateOptions(resolvedOptions);

  const generatePhotoVariantsForRecord = deps.generatePhotoVariantsForRecord || loadGeneratePhotoVariantsForRecord();
  const admin = deps.admin || loadFirebaseAdmin();
  const db = deps.db || admin.database();
  const bucketName = deps.bucketName || getConfiguredBucketName(admin);
  if (!bucketName) {
    throw new Error('Could not resolve Firebase Storage bucket name');
  }

  const { candidates, scan, nextCursor } = await collectCandidates(resolvedOptions, { db });
  const results = [];

  for (const candidate of candidates) {
    const result = await generatePhotoVariantsForRecord({
      bucketName,
      dryRun,
      ...candidate,
    });
    results.push({
      visibility: candidate.visibility,
      tourId: candidate.tourId,
      ownerKey: candidate.ownerKey,
      photoId: candidate.photoId,
      result,
    });
  }

  const summary = results.reduce((acc, item) => {
    const status = item.result?.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    success: true,
    mode: dryRun ? 'dry-run' : 'apply',
    bucketName,
    candidateCount: candidates.length,
    limit: resolvedOptions.limit,
    visibility: resolvedOptions.visibility,
    tourId: resolvedOptions.tourId,
    ownerKey: resolvedOptions.ownerKey,
    retryFailed: resolvedOptions.retryFailed,
    refreshGroupOwnership: resolvedOptions.refreshGroupOwnership,
    nextCursor,
    scan,
    summary,
    results,
  };
};

const main = async (argv = process.argv.slice(2), deps = {}) => {
  const options = parseArgs(argv);
  const result = await run(options, deps);

  console.log(JSON.stringify({
    mode: result.mode,
    bucketName: result.bucketName,
    candidateCount: result.candidateCount,
    limit: result.limit,
    visibility: result.visibility,
    tourId: result.tourId,
    ownerKey: result.ownerKey,
    retryFailed: result.retryFailed,
    refreshGroupOwnership: result.refreshGroupOwnership,
    nextCursor: result.nextCursor,
    scan: result.scan,
  }));
  result.results.forEach((item) => {
    console.log(JSON.stringify(item));
  });
  console.log(JSON.stringify({ summary: result.summary }));
  return result;
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  collectCandidates,
  collectGroupCandidates,
  collectPrivateCandidates,
  main,
  parseArgs,
  run,
  shouldBackfill,
  validateOptions,
};
