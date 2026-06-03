#!/usr/bin/env node

/**
 * Maintenance utility:
 * Normalizes legacy string values under
 * tour_manifests/{tourId}/assigned_driver_codes/{driverId}
 * into canonical object payloads.
 *
 * Defaults to dry-run. Use --apply after reviewing the summary.
 */

const {
  getOptionValue,
  isPlainObject,
  parseBooleanFlag,
  parsePositiveInteger,
  trimString,
} = require('./scriptUtils');

const DEFAULT_ASSIGNED_BY = 'migration_script';

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
    tourId: trimString(getOptionValue(argv, 'tourId')),
    driverId: trimString(getOptionValue(argv, 'driverId'))?.toUpperCase() || null,
    limit: parsePositiveInteger(getOptionValue(argv, 'limit'), { defaultValue: null, max: 5000 }),
    assignedAt: trimString(getOptionValue(argv, 'assignedAt')),
    assignedBy: trimString(getOptionValue(argv, 'assignedBy')) || DEFAULT_ASSIGNED_BY,
    allowFullScan: parseBooleanFlag(argv, 'allow-full-scan', false),
  };
};

const resolveTourCode = ({ legacyValue, manifest, tourId, driverId }) => {
  const manifestTourCode = trimString(manifest?.tourCode);
  if (manifestTourCode) return manifestTourCode;

  const legacyTourCode = trimString(legacyValue);
  if (legacyTourCode && legacyTourCode.toUpperCase() !== driverId.toUpperCase()) {
    return legacyTourCode;
  }

  return tourId.replace(/_/g, ' ');
};

const toCanonicalPayload = ({
  driverId,
  tourId,
  tourCode,
  assignedAt,
  assignedBy = DEFAULT_ASSIGNED_BY,
}) => ({
  driverId,
  tourId,
  tourCode,
  assignedAt,
  assignedBy,
});

const buildAssignedDriverCodeUpdatePlan = (manifests = {}, options = {}) => {
  const assignedAt = trimString(options.assignedAt) || new Date().toISOString();
  const assignedBy = trimString(options.assignedBy) || DEFAULT_ASSIGNED_BY;
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const targetTourId = trimString(options.tourId);
  const targetDriverId = trimString(options.driverId)?.toUpperCase() || null;
  const updates = {};
  const samplePaths = [];
  let scanned = 0;
  let migrated = 0;
  let skippedNonLegacy = 0;
  let skippedByFilter = 0;

  for (const [tourId, manifest] of Object.entries(manifests || {})) {
    if (targetTourId && tourId !== targetTourId) {
      skippedByFilter += 1;
      continue;
    }

    const driverCodes = isPlainObject(manifest?.assigned_driver_codes)
      ? manifest.assigned_driver_codes
      : {};

    for (const [driverId, value] of Object.entries(driverCodes)) {
      if (targetDriverId && driverId.toUpperCase() !== targetDriverId) {
        skippedByFilter += 1;
        continue;
      }

      scanned += 1;
      if (limit !== null && migrated >= limit) {
        skippedByFilter += 1;
        continue;
      }

      if (typeof value !== 'string' || !value.trim()) {
        skippedNonLegacy += 1;
        continue;
      }

      const path = `tour_manifests/${tourId}/assigned_driver_codes/${driverId}`;
      updates[path] = toCanonicalPayload({
        driverId,
        tourId,
        tourCode: resolveTourCode({ legacyValue: value, manifest, tourId, driverId }),
        assignedAt,
        assignedBy,
      });
      migrated += 1;

      if (samplePaths.length < 10) {
        samplePaths.push(path);
      }
    }
  }

  return {
    updates,
    summary: {
      scanned,
      migrated,
      skippedNonLegacy,
      skippedByFilter,
      updatesPrepared: Object.keys(updates).length,
      samplePaths,
    },
  };
};

const validateOptions = (options = {}) => {
  if (options.dryRun === false && !options.allowFullScan && !options.tourId) {
    throw new Error('Refusing to apply assigned driver code migration across all tours without --tourId or --allow-full-scan');
  }
};

const run = async (options = {}, deps = {}) => {
  const dryRun = options.dryRun !== false;
  validateOptions({ ...options, dryRun });

  const admin = deps.admin || loadFirebaseAdmin();
  const db = deps.db || admin.database();
  const manifestsSnap = await db.ref('tour_manifests').once('value');
  const manifests = manifestsSnap.val() || {};
  const { updates, summary } = buildAssignedDriverCodeUpdatePlan(manifests, options);

  if (!dryRun && Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return {
    success: true,
    mode: dryRun ? 'dry-run' : 'apply',
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
    console.error('Assigned driver code migration failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildAssignedDriverCodeUpdatePlan,
  main,
  parseArgs,
  resolveTourCode,
  run,
  toCanonicalPayload,
  validateOptions,
};
