#!/usr/bin/env node

/**
 * One-off migration utility:
 * Copies legacy private photo owner nodes keyed by bookingRef to stable passenger IDs.
 *
 * Source: private_tour_photos/{tourId}/{bookingRef}
 * Target: private_tour_photos/{tourId}/{stablePassengerId}
 *
 * Mapping source:
 * users/{uid}/stablePassengerId + users/{uid}/bookingRef|privatePhotoOwnerId
 *
 * Flags:
 * --dry-run=true|false (default: true)
 * --delete-legacy=true|false (default: false)
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

const readBooleanArg = (flag, defaultValue) => {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!raw) return defaultValue;
  return raw.split('=')[1] === 'true';
};

const collectOwnerMappings = (users = {}) => {
  const mapping = new Map();

  Object.values(users).forEach((profile) => {
    const stablePassengerId = typeof profile?.stablePassengerId === 'string'
      ? profile.stablePassengerId.trim()
      : '';

    if (!stablePassengerId) {
      return;
    }

    const candidates = [profile?.bookingRef, profile?.privatePhotoOwnerId]
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);

    for (const legacyOwnerId of candidates) {
      if (!mapping.has(legacyOwnerId)) {
        mapping.set(legacyOwnerId, stablePassengerId);
      }
    }
  });

  return mapping;
};

const run = async () => {
  const dryRun = readBooleanArg('--dry-run', true);
  const deleteLegacy = readBooleanArg('--delete-legacy', false);

  const [usersSnap, photosSnap] = await Promise.all([
    db.ref('users').once('value'),
    db.ref('private_tour_photos').once('value'),
  ]);

  const users = usersSnap.val() || {};
  const privatePhotos = photosSnap.val() || {};
  const legacyToStableOwner = collectOwnerMappings(users);

  const updates = {};
  let scannedOwners = 0;
  let copiedOwners = 0;
  let copiedPhotos = 0;
  let skippedAlreadyMigrated = 0;
  let skippedWithoutMapping = 0;

  for (const [tourId, ownerTree] of Object.entries(privatePhotos)) {
    for (const [legacyOwnerId, payload] of Object.entries(ownerTree || {})) {
      scannedOwners += 1;

      const stableOwnerId = legacyToStableOwner.get(legacyOwnerId);
      if (!stableOwnerId) {
        skippedWithoutMapping += 1;
        continue;
      }

      if (legacyOwnerId === stableOwnerId) {
        skippedAlreadyMigrated += 1;
        continue;
      }

      const targetPath = `private_tour_photos/${tourId}/${stableOwnerId}`;
      const targetSnap = await db.ref(targetPath).once('value');
      const existingTarget = targetSnap.val() || {};
      const mergedTarget = { ...existingTarget, ...(payload || {}) };
      const incomingPhotoCount = Object.keys(payload || {}).length;

      updates[targetPath] = mergedTarget;

      if (deleteLegacy) {
        updates[`private_tour_photos/${tourId}/${legacyOwnerId}`] = null;
      }

      copiedOwners += 1;
      copiedPhotos += incomingPhotoCount;
    }
  }

  if (!dryRun && Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  const result = {
    success: true,
    dryRun,
    deleteLegacy,
    scannedOwners,
    copiedOwners,
    copiedPhotos,
    skippedAlreadyMigrated,
    skippedWithoutMapping,
    updatesPrepared: Object.keys(updates).length,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Private photo owner migration failed:', error);
  process.exitCode = 1;
});
