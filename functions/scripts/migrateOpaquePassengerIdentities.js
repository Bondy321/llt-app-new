#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  BOOKING_SECURITY_FIELDS,
  REWRITE_ROOTS,
  buildDatabaseMigration,
  containsLegacyIdentity,
  listStorageMoves,
} = require('../lib/passengerIdentityMigration');

const MIGRATION_ROOTS = [...new Set([
  'booking_identities',
  'passenger_identity_security',
  'users',
  'identity_bindings',
  'identity_bindings_meta',
  'tour_access_grants',
  'booking_access_grants',
  ...REWRITE_ROOTS,
])];

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  projectId: (argv.find((arg) => arg.startsWith('--project=')) || '').slice(10),
  databaseURL: (argv.find((arg) => arg.startsWith('--database-url=')) || '').slice(15),
  storageBucket: (argv.find((arg) => arg.startsWith('--storage-bucket=')) || '').slice(17),
  confirmProject: (argv.find((arg) => arg.startsWith('--confirm-project=')) || '').slice(18),
  backupPath: (argv.find((arg) => arg.startsWith('--backup=')) || '').slice(9),
});

const ensureBackup = ({ backupPath, artifact }) => {
  if (!backupPath) throw new Error('--backup=<path> is required for --apply');
  const resolved = path.resolve(backupPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(artifact), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return resolved;
};

const updateAuthSecurity = async ({ admin, users, passengerIdentitySecurity = {} }) => {
  let updated = 0;
  let missing = 0;
  let revoked = 0;
  for (const [authUid, profile] of Object.entries(users || {})) {
    if (profile?.identityVersion !== 'pax_v2') continue;
    try {
      const authUser = await admin.auth().getUser(authUid);
      await admin.auth().setCustomUserClaims(authUid, {
        ...(authUser.customClaims || {}),
        privatePhotoOwnerKey: profile.privatePhotoOwnerKey,
        passengerIdentityVersion: 'pax_v2',
      });
      const securityRecord = passengerIdentitySecurity[profile.bookingRef];
      if (securityRecord?.loginLocked === true) {
        await admin.auth().revokeRefreshTokens(authUid);
        revoked += 1;
      }
      updated += 1;
    } catch (error) {
      if (error?.code === 'auth/user-not-found') {
        missing += 1;
        continue;
      }
      throw error;
    }
  }
  return { updated, missing, revoked };
};

const copyPrivateStorageObjects = async ({ bucket, moves }) => {
  let copied = 0;
  for (const move of moves) {
    const destination = bucket.file(move.destination);
    const [exists] = await destination.exists();
    if (!exists) {
      await bucket.file(move.source).copy(destination);
      copied += 1;
    }
  }
  return copied;
};

const deleteLegacyStorageObjects = async ({ bucket, moves }) => {
  let deleted = 0;
  for (const move of moves) {
    await bucket.file(move.source).delete({ ignoreNotFound: true });
    deleted += 1;
  }
  return deleted;
};

const readMigrationSnapshot = async (db) => {
  const entries = [];
  for (const root of MIGRATION_ROOTS) {
    const snapshot = await db.ref(root).once('value');
    entries.push([root, snapshot.val()]);
  }
  return Object.fromEntries(entries);
};

const run = async ({ admin, options }) => {
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (options.apply && (!projectId || options.confirmProject !== projectId)) {
    throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
  }

  const db = admin.database();
  console.error('Reading bounded identity-bearing database roots...');
  const source = await readMigrationSnapshot(db);
  const plan = buildDatabaseMigration({ snapshot: source });
  if (plan.legacyRemaining.length > 0) {
    throw new Error(`Migration plan still contains legacy identities in: ${plan.legacyRemaining.join(', ')}`);
  }
  if (plan.bookingSecurityResidueCount > 0 || plan.securityRecordCount !== Object.keys(plan.identities).length) {
    throw new Error('Migration plan did not fully isolate passenger identity security records');
  }

  const bucket = admin.storage().bucket();
  console.error('Inventorying group and private photo objects...');
  const [[privateFiles], [groupFiles]] = await Promise.all([
    bucket.getFiles({ prefix: 'private_tour_photos/' }),
    bucket.getFiles({ prefix: 'group_tour_photos/' }),
  ]);
  const files = [...privateFiles, ...groupFiles];
  const storageMoves = listStorageMoves({ files, aliasMap: plan.aliasMap });
  const summary = {
    apply: options.apply,
    projectId,
    bookingIdentityCount: Object.keys(plan.identities).length,
    aliasCount: plan.aliasMap.size,
    discoveredLegacyIdentityCount: plan.discoveredLegacyIdentityCount,
    affectedAuthUserCount: plan.affectedAuthUids.length,
    lockedBookingCount: plan.lockedBookingCount,
    securityRecordCount: plan.securityRecordCount,
    bookingSecurityResidueCount: plan.bookingSecurityResidueCount,
    storageMoveCount: storageMoves.length,
  };
  if (!options.apply) return summary;

  const backupPath = ensureBackup({
    backupPath: options.backupPath,
    artifact: {
      version: 1,
      projectId,
      createdAt: new Date().toISOString(),
      database: source,
      identityAliases: Object.fromEntries(plan.aliasMap),
      storageMoves,
    },
  });
  const copiedStorageObjects = await copyPrivateStorageObjects({ bucket, moves: storageMoves });
  console.error('Applying one atomic multi-root database migration...');
  await db.ref().update(Object.fromEntries(MIGRATION_ROOTS.map((root) => [root, plan.next[root] ?? null])));
  const committedPlan = plan;
  const auditSnapshot = await readMigrationSnapshot(db);
  const legacyAfterApply = [
    ...REWRITE_ROOTS.filter((root) => containsLegacyIdentity(auditSnapshot[root])),
    ...['users', 'identity_bindings', 'identity_bindings_meta']
      .filter((root) => containsLegacyIdentity(auditSnapshot[root])),
  ];
  if (legacyAfterApply.length > 0) {
    throw new Error(`Post-migration audit found legacy identities in: ${legacyAfterApply.join(', ')}`);
  }
  const committedSecurityCount = Object.keys(auditSnapshot.passenger_identity_security || {}).length;
  const committedBookingSecurityResidueCount = Object.values(auditSnapshot.booking_identities || {})
    .filter((identity) => BOOKING_SECURITY_FIELDS.some((field) => identity?.[field] !== undefined)).length;
  if (committedSecurityCount !== plan.securityRecordCount || committedBookingSecurityResidueCount > 0) {
    throw new Error('Post-migration audit found incomplete passenger security isolation');
  }
  const auth = await updateAuthSecurity({
    admin,
    users: committedPlan.next.users,
    passengerIdentitySecurity: committedPlan.next.passenger_identity_security,
  });
  const deletedLegacyStorageObjects = await deleteLegacyStorageObjects({ bucket, moves: storageMoves });
  return {
    ...summary,
    backupPath,
    copiedStorageObjects,
    deletedLegacyStorageObjects,
    auth,
  };
};

if (require.main === module) {
  const admin = require('firebase-admin');
  const options = parseArgs(process.argv.slice(2));
  const projectId = options.projectId || process.env.GCLOUD_PROJECT || 'loch-lomond-travel';
  if (!admin.apps.length) admin.initializeApp({
    projectId,
    databaseURL: options.databaseURL
      || process.env.FIREBASE_DATABASE_URL
      || `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
    storageBucket: options.storageBucket
      || process.env.FIREBASE_STORAGE_BUCKET
      || `${projectId}.firebasestorage.app`,
  });
  run({ admin, options })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = {
  copyPrivateStorageObjects,
  deleteLegacyStorageObjects,
  ensureBackup,
  parseArgs,
  run,
  updateAuthSecurity,
  readMigrationSnapshot,
};
