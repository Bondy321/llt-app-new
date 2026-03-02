#!/usr/bin/env node

/**
 * One-off migration utility:
 * Normalize legacy string values under
 * /tour_manifests/*/assigned_driver_codes/* into canonical object payloads.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

const toCanonicalPayload = ({ tourId, tourCode, assignedBy = 'migration_script' }) => ({
  tourId,
  tourCode,
  assignedAt: new Date().toISOString(),
  assignedBy,
});

const run = async () => {
  const manifestsSnap = await db.ref('tour_manifests').once('value');
  const manifests = manifestsSnap.val() || {};
  const updates = {};
  let scanned = 0;
  let migrated = 0;

  for (const [tourId, manifest] of Object.entries(manifests)) {
    const driverCodes = manifest?.assigned_driver_codes || {};
    const fallbackTourCode = manifest?.tourCode || tourId.replace(/_/g, ' ');

    for (const [driverId, value] of Object.entries(driverCodes)) {
      scanned += 1;

      if (!value || typeof value !== 'string') {
        continue;
      }

      updates[`tour_manifests/${tourId}/assigned_driver_codes/${driverId}`] = toCanonicalPayload({
        tourId,
        tourCode: fallbackTourCode,
      });
      migrated += 1;
    }
  }

  if (migrated > 0) {
    await db.ref().update(updates);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ scanned, migrated }, null, 2));
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
