#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CHILDREN_PER_PARENT = 500;

const readArg = (argv, name) => (argv.find((arg) => arg.startsWith(`--${name}=`)) || '')
  .slice(name.length + 3)
  .trim();

const parseArgs = (argv = []) => {
  const parsedLimit = Number(readArg(argv, 'limit'));
  return {
    apply: argv.includes('--apply'),
    projectId: readArg(argv, 'project'),
    databaseURL: readArg(argv, 'database-url'),
    confirmProject: readArg(argv, 'confirm-project'),
    backupPath: readArg(argv, 'backup'),
    cutoverConfirmation: readArg(argv, 'cutover'),
    afterTour: readArg(argv, 'after-tour'),
    afterUid: readArg(argv, 'after-uid'),
    afterBooking: readArg(argv, 'after-booking'),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT,
  };
};

const compareKeys = (left, right) => left.localeCompare(right);

const readKeyPage = async ({ ref, after, limit }) => {
  let query = ref.orderByKey();
  if (after) query = query.startAt(after);
  const snapshot = await query.limitToFirst(limit + (after ? 2 : 1)).once('value');
  const entries = Object.entries(snapshot.val() || {})
    .filter(([key]) => !after || compareKeys(key, after) > 0)
    .sort(([left], [right]) => compareKeys(left, right));
  const page = entries.slice(0, limit);
  return {
    entries: page,
    nextCursor: entries.length > limit && page.length ? page.at(-1)[0] : null,
  };
};

const boundedChildren = (value) => Object.entries(value || {}).slice(0, MAX_CHILDREN_PER_PARENT);

const inventoryLegacySessionState = async ({ db, options }) => {
  const [tourPage, userPage, bookingPage] = await Promise.all([
    readKeyPage({ ref: db.ref('tours'), after: options.afterTour, limit: options.limit }),
    readKeyPage({ ref: db.ref('users'), after: options.afterUid, limit: options.limit }),
    readKeyPage({ ref: db.ref('booking_access_grants'), after: options.afterBooking, limit: options.limit }),
  ]);
  const uidTours = new Map();
  const participantRows = [];
  const tourGrantRows = [];
  const truncatedParents = [];

  for (const [tourId, tour] of tourPage.entries) {
    const participants = Object.entries(tour?.participants || {});
    if (participants.length > MAX_CHILDREN_PER_PARENT) truncatedParents.push(`tours/${tourId}/participants`);
    for (const [authUid, record] of participants.slice(0, MAX_CHILDREN_PER_PARENT)) {
      participantRows.push({ tourId, authUid, record });
      if (!uidTours.has(authUid)) uidTours.set(authUid, new Set());
      uidTours.get(authUid).add(tourId);
    }
    const grantSnapshot = await db.ref(`tour_access_grants/${tourId}`)
      .orderByKey().limitToFirst(MAX_CHILDREN_PER_PARENT + 1).once('value');
    const grants = Object.entries(grantSnapshot.val() || {});
    if (grants.length > MAX_CHILDREN_PER_PARENT) truncatedParents.push(`tour_access_grants/${tourId}`);
    grants.slice(0, MAX_CHILDREN_PER_PARENT).forEach(([authUid, record]) => {
      tourGrantRows.push({ tourId, authUid, record });
    });
  }

  const bookingGrantRows = [];
  for (const [bookingRef, grants] of bookingPage.entries) {
    const children = Object.entries(grants || {});
    if (children.length > MAX_CHILDREN_PER_PARENT) truncatedParents.push(`booking_access_grants/${bookingRef}`);
    children.slice(0, MAX_CHILDREN_PER_PARENT).forEach(([authUid, record]) => {
      bookingGrantRows.push({ bookingRef, authUid, record });
    });
  }

  const users = userPage.entries.map(([authUid, profile]) => ({ authUid, profile: profile || {} }));
  const invalidParticipants = participantRows.filter(({ authUid, record }) => !record
    || record.schemaVersion !== 2
    || record.userId !== authUid
    || typeof record.sessionId !== 'string'
    || !/^sess_v1_[a-f0-9]{32}$/.test(record.sessionId));
  const activeSessionSnapshot = await db.ref('app_sessions')
    .orderByChild('expiresAtMs').startAt(Date.now() + 1).limitToFirst(MAX_CHILDREN_PER_PARENT).once('value');
  const activeSessions = activeSessionSnapshot.val() || {};
  const participantUids = new Set(participantRows.map((row) => row.authUid));
  const inferredOnlyUids = [...participantUids].filter((uid) => !activeSessions[uid]);

  return {
    pages: { tours: tourPage, users: userPage, bookings: bookingPage },
    participantRows,
    tourGrantRows,
    bookingGrantRows,
    users,
    activeSessions,
    invalidParticipants,
    inferredOnlyUids,
    multiTourUids: [...uidTours.entries()]
      .filter(([, tours]) => tours.size > 1)
      .map(([authUid, tours]) => ({ authUid, tours: [...tours].sort() })),
    driverAuthMappings: users.filter(({ profile }) => profile.driverId).map(({ authUid, profile }) => ({
      authUid,
      driverId: profile.driverId,
      assignedTourId: profile.driverAssignedTourId || null,
    })),
    pushTokenUids: users.filter(({ profile }) => typeof profile.pushToken === 'string').map(({ authUid }) => authUid),
    truncatedParents,
  };
};

const buildCutoverUpdates = (inventory) => {
  const updates = {};
  inventory.participantRows.forEach(({ tourId, authUid }) => {
    updates[`tours/${tourId}/participants/${authUid}`] = null;
  });
  inventory.tourGrantRows.forEach(({ tourId, authUid }) => {
    updates[`tour_access_grants/${tourId}/${authUid}`] = null;
  });
  inventory.bookingGrantRows.forEach(({ bookingRef, authUid }) => {
    updates[`booking_access_grants/${bookingRef}/${authUid}`] = null;
  });
  inventory.pushTokenUids.forEach((authUid) => {
    updates[`users/${authUid}/pushToken`] = null;
    updates[`users/${authUid}/pushTokenStatus`] = 'UNAVAILABLE';
    updates[`users/${authUid}/pushTokenInvalidReason`] = 'SECURE_RELOGIN_REQUIRED';
  });
  return updates;
};

const writeBackup = ({ backupPath, projectId, inventory, updates }) => {
  if (!backupPath) throw new Error('--backup=<path> is required for --apply');
  const resolved = path.resolve(backupPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify({
    schemaVersion: 1,
    migration: 'app_sessions_secure_relogin_cutover',
    projectId,
    createdAt: new Date().toISOString(),
    inventory,
    updatePaths: Object.keys(updates),
  }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return resolved;
};

const summarize = (inventory, options) => ({
  apply: options.apply,
  participantRows: inventory.participantRows.length,
  invalidParticipantRows: inventory.invalidParticipants.length,
  tourAccessGrants: inventory.tourGrantRows.length,
  bookingAccessGrants: inventory.bookingGrantRows.length,
  activeDriverAuthMappings: inventory.driverAuthMappings.length,
  pushTokens: inventory.pushTokenUids.length,
  multiTourUids: inventory.multiTourUids.length,
  sessionsNotSafelyInferable: inventory.inferredOnlyUids.length,
  trustedSessionsCreated: 0,
  truncatedParents: inventory.truncatedParents,
  continuation: {
    afterTour: inventory.pages.tours.nextCursor,
    afterUid: inventory.pages.users.nextCursor,
    afterBooking: inventory.pages.bookings.nextCursor,
  },
});

const run = async ({ admin, options }) => {
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (options.apply) {
    if (!projectId || options.confirmProject !== projectId) {
      throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
    }
    if (options.cutoverConfirmation !== 'FORCE_SECURE_RELOGIN') {
      throw new Error('Refusing apply: pass --cutover=FORCE_SECURE_RELOGIN during the approved maintenance window');
    }
  }
  const db = admin.database();
  const inventory = await inventoryLegacySessionState({ db, options });
  const result = summarize(inventory, options);
  if (!options.apply) return result;
  if (inventory.truncatedParents.length) {
    throw new Error(`Refusing apply because child bounds were reached: ${inventory.truncatedParents.join(', ')}`);
  }
  const updates = buildCutoverUpdates(inventory);
  const backupPath = writeBackup({ backupPath: options.backupPath, projectId, inventory, updates });
  if (Object.keys(updates).length) await db.ref().update(updates);

  const remaining = [];
  for (const [updatePath, expectedValue] of Object.entries(updates)) {
    const snapshot = await db.ref(updatePath).once('value');
    const matches = expectedValue === null
      ? !snapshot.exists()
      : JSON.stringify(snapshot.val()) === JSON.stringify(expectedValue);
    if (!matches) remaining.push(updatePath);
  }
  return {
    ...result,
    backupPath,
    updatePathCount: Object.keys(updates).length,
    postRunAudit: { remainingPaths: remaining.length, passed: remaining.length === 0 },
  };
};

const closeAdminApps = async (admin) => {
  const apps = Array.isArray(admin?.apps) ? admin.apps.filter(Boolean) : [];
  await Promise.all(apps.map((app) => (
    typeof app.delete === 'function' ? app.delete() : Promise.resolve()
  )));
};

const main = async ({ admin, argv = process.argv.slice(2) }) => {
  const options = parseArgs(argv);
  const projectId = options.projectId || process.env.GCLOUD_PROJECT || 'loch-lomond-travel';
  if (!admin.apps.length) admin.initializeApp({
    projectId,
    databaseURL: options.databaseURL
      || process.env.FIREBASE_DATABASE_URL
      || `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
  });
  try {
    const result = await run({ admin, options });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeAdminApps(admin);
  }
};

if (require.main === module) {
  const admin = require('firebase-admin');
  main({ admin }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCutoverUpdates,
  closeAdminApps,
  inventoryLegacySessionState,
  main,
  parseArgs,
  readKeyPage,
  run,
  summarize,
  writeBackup,
};
