#!/usr/bin/env node

/**
 * Maintenance utility:
 * Copies legacy private photo owner nodes keyed by bookingRef/privatePhotoOwnerId
 * to stable passenger owner buckets.
 *
 * Source: private_tour_photos/{tourId}/{legacyOwnerId}
 * Target: private_tour_photos/{tourId}/{stablePassengerKey}
 *
 * Defaults to dry-run. Use --apply after reviewing the summary.
 */

const {
  getOptionValue,
  isPlainObject,
  parseBooleanFlag,
  parsePositiveInteger,
  toRealtimeKeySegment,
  trimString,
} = require('./scriptUtils');

const RESERVED_PRIVATE_PHOTO_CHILDREN = new Set(['thumbnails', 'viewers']);
const PHOTO_IDENTITY_FIELDS = ['idempotencyKey', 'storagePath', 'sourceUrl', 'url', 'fullUrl'];

const loadFirebaseAdmin = () => {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin;
};

const parseArgs = (argv = []) => {
  const dryRunFlag = getOptionValue(argv, 'dry-run');
  let dryRun = true;

  if (argv.includes('--apply')) {
    dryRun = false;
  } else if (argv.includes('--dry-run')) {
    dryRun = true;
  } else if (dryRunFlag !== null) {
    dryRun = !['false', '0', 'no'].includes(dryRunFlag.trim().toLowerCase());
  }

  return {
    dryRun,
    deleteLegacy: parseBooleanFlag(argv, 'delete-legacy', false),
    allowFullScan: parseBooleanFlag(argv, 'allow-full-scan', false),
    tourId: trimString(getOptionValue(argv, 'tourId')),
    ownerKey: trimString(getOptionValue(argv, 'ownerKey')),
    limit: parsePositiveInteger(getOptionValue(argv, 'limit'), { defaultValue: null, max: 5000 }),
  };
};

const addMappingCandidate = (mapping, ambiguous, legacyOwnerId, stableOwner) => {
  const candidate = trimString(legacyOwnerId);
  if (!candidate || ambiguous.has(candidate)) return;

  const existing = mapping.get(candidate);
  if (!existing) {
    mapping.set(candidate, stableOwner);
    return;
  }

  if (existing.stableOwnerKey === stableOwner.stableOwnerKey) {
    return;
  }

  mapping.delete(candidate);
  ambiguous.set(candidate, [existing, stableOwner]);
};

const collectOwnerMappings = (users = {}) => {
  const mapping = new Map();
  const ambiguous = new Map();

  Object.values(users || {}).forEach((profile) => {
    const stablePassengerId = trimString(profile?.stablePassengerId);

    if (!stablePassengerId) {
      return;
    }

    const stableOwnerKey = toRealtimeKeySegment(stablePassengerId);
    if (!stableOwnerKey) {
      return;
    }

    const stableOwner = { stablePassengerId, stableOwnerKey };
    const bookingRef = trimString(profile?.bookingRef);
    const privatePhotoOwnerId = trimString(profile?.privatePhotoOwnerId);
    const privatePhotoOwnerKey = trimString(profile?.privatePhotoOwnerKey);
    const candidates = [
      bookingRef,
      bookingRef?.toUpperCase(),
      privatePhotoOwnerId,
      privatePhotoOwnerKey,
      stablePassengerId,
      stableOwnerKey,
    ];

    candidates.forEach((candidate) => {
      addMappingCandidate(mapping, ambiguous, candidate, stableOwner);
    });
  });

  return { mapping, ambiguous };
};

const normalizePrivatePhotoRecord = (photo = {}, stablePassengerId) => ({
  ...photo,
  userId: stablePassengerId,
});

const recordsReferToSamePhoto = (left = {}, right = {}) => (
  PHOTO_IDENTITY_FIELDS.some((field) => {
    const leftValue = trimString(left?.[field]);
    const rightValue = trimString(right?.[field]);
    return Boolean(leftValue && rightValue && leftValue === rightValue);
  })
);

const buildPrivatePhotoOwnerMigrationPlan = (users = {}, privatePhotos = {}, options = {}) => {
  const { mapping, ambiguous } = collectOwnerMappings(users);
  const targetTourId = trimString(options.tourId);
  const targetOwnerKey = trimString(options.ownerKey);
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const updates = {};
  const samplePaths = [];
  let scannedOwners = 0;
  let copiedOwners = 0;
  let copiedPhotos = 0;
  let skippedAlreadyMigrated = 0;
  let skippedWithoutMapping = 0;
  let skippedAmbiguousMapping = 0;
  let skippedReservedChildren = 0;
  let skippedMalformedPhotos = 0;
  let skippedExistingPhotos = 0;
  let conflictPhotos = 0;
  let deleteLegacyPrepared = 0;

  for (const [tourId, ownerTree] of Object.entries(privatePhotos || {})) {
    if (targetTourId && tourId !== targetTourId) continue;

    for (const [legacyOwnerId, payload] of Object.entries(ownerTree || {})) {
      if (targetOwnerKey && legacyOwnerId !== targetOwnerKey) continue;
      if (limit !== null && copiedOwners >= limit) continue;

      scannedOwners += 1;

      if (ambiguous.has(legacyOwnerId)) {
        skippedAmbiguousMapping += 1;
        continue;
      }

      const stableOwner = mapping.get(legacyOwnerId);
      if (!stableOwner) {
        skippedWithoutMapping += 1;
        continue;
      }

      const { stablePassengerId, stableOwnerKey } = stableOwner;

      if (legacyOwnerId === stableOwnerKey) {
        skippedAlreadyMigrated += 1;
        continue;
      }

      if (!isPlainObject(payload)) {
        skippedMalformedPhotos += 1;
        continue;
      }

      const targetPath = `private_tour_photos/${tourId}/${stableOwnerKey}`;
      const targetPayload = isPlainObject(ownerTree?.[stableOwnerKey])
        ? { ...ownerTree[stableOwnerKey] }
        : {};
      let ownerCopiedPhotos = 0;
      let ownerConflicts = 0;
      let ownerSkippedReserved = 0;
      let ownerSkippedMalformed = 0;

      for (const [photoId, photo] of Object.entries(payload || {})) {
        if (RESERVED_PRIVATE_PHOTO_CHILDREN.has(photoId)) {
          skippedReservedChildren += 1;
          ownerSkippedReserved += 1;
          continue;
        }

        if (!isPlainObject(photo)) {
          skippedMalformedPhotos += 1;
          ownerSkippedMalformed += 1;
          continue;
        }

        const normalizedPhoto = normalizePrivatePhotoRecord(photo, stablePassengerId);
        const existingPhoto = targetPayload[photoId];

        if (existingPhoto !== undefined) {
          if (isPlainObject(existingPhoto) && recordsReferToSamePhoto(existingPhoto, normalizedPhoto)) {
            skippedExistingPhotos += 1;
            continue;
          }

          conflictPhotos += 1;
          ownerConflicts += 1;
          continue;
        }

        targetPayload[photoId] = normalizedPhoto;
        copiedPhotos += 1;
        ownerCopiedPhotos += 1;
      }

      if (ownerCopiedPhotos > 0) {
        updates[targetPath] = targetPayload;
        copiedOwners += 1;

        if (samplePaths.length < 10) {
          samplePaths.push(targetPath);
        }
      }

      if (
        options.deleteLegacy
        && ownerConflicts === 0
        && ownerSkippedReserved === 0
        && ownerSkippedMalformed === 0
      ) {
        updates[`private_tour_photos/${tourId}/${legacyOwnerId}`] = null;
        deleteLegacyPrepared += 1;
      }
    }
  }

  return {
    updates,
    summary: {
      scannedOwners,
      copiedOwners,
      copiedPhotos,
      skippedAlreadyMigrated,
      skippedWithoutMapping,
      skippedAmbiguousMapping,
      skippedReservedChildren,
      skippedMalformedPhotos,
      skippedExistingPhotos,
      conflictPhotos,
      deleteLegacyPrepared,
      ambiguousMappingCount: ambiguous.size,
      updatesPrepared: Object.keys(updates).length,
      samplePaths,
    },
  };
};

const validateOptions = (options = {}) => {
  if (options.ownerKey && !options.tourId) {
    throw new Error('--ownerKey requires --tourId so the private owner path is unambiguous');
  }

  if (options.dryRun === false && !options.allowFullScan && !options.tourId) {
    throw new Error('Refusing to apply across all private photo owners without --tourId or --allow-full-scan');
  }
};

const run = async (options = {}, deps = {}) => {
  const dryRun = options.dryRun !== false;
  validateOptions({ ...options, dryRun });

  const admin = deps.admin || loadFirebaseAdmin();
  const db = deps.db || admin.database();
  const photosPath = options.tourId
    ? `private_tour_photos/${options.tourId}`
    : 'private_tour_photos';

  const [usersSnap, photosSnap] = await Promise.all([
    db.ref('users').once('value'),
    db.ref(photosPath).once('value'),
  ]);

  const users = usersSnap.val() || {};
  const scopedPhotos = options.tourId
    ? { [options.tourId]: photosSnap.val() || {} }
    : photosSnap.val() || {};
  const { updates, summary } = buildPrivatePhotoOwnerMigrationPlan(users, scopedPhotos, options);

  if (!dryRun && Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return {
    success: true,
    mode: dryRun ? 'dry-run' : 'apply',
    deleteLegacy: Boolean(options.deleteLegacy),
    ...summary,
  };
};

const main = async (argv = process.argv.slice(2), deps = {}) => {
  const options = parseArgs(argv);
  const result = await run(options, deps);
  console.log(JSON.stringify(result, null, 2));
  return result;
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Private photo owner migration failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPrivatePhotoOwnerMigrationPlan,
  collectOwnerMappings,
  main,
  normalizePrivatePhotoRecord,
  parseArgs,
  recordsReferToSamePhoto,
  run,
};
