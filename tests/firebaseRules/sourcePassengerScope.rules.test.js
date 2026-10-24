'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { passengerAuthorityUpdates, driverAuthorityUpdates, passengerIdFor, sessionIdFor } = require('./sessionFixtures');

const PROJECT_ID = 'demo-llt-source-passenger-scope';
const UID = 'source-passenger';
const DRIVER_UID = 'source-scope-driver';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const BOOKING = 'SOURCE-SCOPE-BOOKING';
const OLD = 'SOURCE_OLD';
const NEXT = 'SOURCE_NEXT';
const PRINCIPAL = passengerIdFor(UID);
const SID = sessionIdFor(UID);
const REVISION = 'a'.repeat(64);
const PASSENGER = `srcpax_v1_${'b'.repeat(64)}`;
let env; let databaseUrl;
const client = (uid = UID) => env.authenticatedContext(uid, uid === ADMIN_UID
  ? { firebase: { sign_in_second_factor: 'totp' } } : {}).database(databaseUrl);
const allow = (operation, key) => assertSucceeds(operation).catch(error => {
  error.message = `${key}: ${error.message}`;
  throw error;
});
const adminWrite = patch => env.withSecurityRulesDisabled(context => context.database(databaseUrl).ref().update(patch));
const readValue = async key => {
  let value;
  await env.withSecurityRulesDisabled(async context => { value = (await context.database(databaseUrl).ref(key).get()).val(); });
  return value;
};
const message = id => ({ senderId: UID, senderStableId: PRINCIPAL, senderName: 'Synthetic passenger',
  text: 'Synthetic retained message', timestamp: Date.now(), isDriver: false, status: 'sent', idempotencyKey: id });
const boarding = { status: 'PENDING', rosterRevision: REVISION,
  passengerIdsJson: JSON.stringify([PASSENGER]), passengerStatusCodes: 'P' };
const live = () => ({ schemaVersion: 2, userId: UID, isSharing: true, lastUpdate: { '.sv': 'timestamp' },
  clientUpdatedAtMs: Date.now(), coords: { latitude: 56, longitude: -4, accuracy: 12 } });
const rawStatus = (tourId, kind) => ({ schemaVersion: 2, actorKey: PRINCIPAL, appSessionId: SID, authUid: UID,
  principalId: PRINCIPAL, principalType: 'passenger', tourId, tourActorKey: `${tourId}|${PRINCIPAL}`,
  scope: 'group', name: 'Synthetic passenger', isDriver: false, timestamp: { '.sv': 'timestamp' },
  expiresAtMs: Date.now() + (kind === 'typing' ? 10000 : 300000) });
const report = tourId => ({ schemaVersion: 1, reportId: `scope_report_${tourId}`, tourId,
  contentType: 'chat_message', contentId: 'seeded', chatScope: 'group', reason: 'harassment', status: 'open',
  reporterId: UID, reporterAuthUid: UID, reporterName: 'Synthetic passenger', contentOwnerId: UID,
  contentOwnerName: 'Synthetic passenger', contentPreview: 'Synthetic retained message',
  sourcePath: `chats/${tourId}/messages/seeded`, details: '', createdAt: new Date().toISOString(),
  createdAtMs: Date.now(), updatedAt: new Date().toISOString(), updatedAtMs: Date.now() });

const readPaths = tourId => [
  `passenger_trip_signals/v1/bookings/${BOOKING}`, `passenger_trip_signals/v1/tours/${tourId}`,
  `tour_manifests/${tourId}/bookings/${BOOKING}`, `tours/${tourId}/driverLocation`,
  `tours/${tourId}/participants/${UID}`, `tours/${tourId}/itinerary`, `tours/${tourId}/liveTracking/${UID}`,
  `chats/${tourId}`, `group_tour_photos/${tourId}`, `private_tour_photos/${tourId}/${PRINCIPAL}`,
  `broadcasts/${tourId}`, `tour_notifications/${tourId}`, `notification_read_state/${tourId}/${PRINCIPAL}`,
  `content_reports/seeded_report_${tourId}`,
  `tour_access_grants/${tourId}/${UID}`, `booking_access_grants/${BOOKING}/${UID}`,
];
const writes = tourId => [
  [`tour_manifests/${tourId}/bookings/${BOOKING}`, boarding],
  [`tours/${tourId}/liveTracking/${UID}`, live()],
  [`chats/${tourId}/messages/new_${tourId}`, message(`new_${tourId}`)],
  [`chats/${tourId}/messages/seeded/reactions/like/${PRINCIPAL}`, true],
  [`chats/${tourId}/lastRead/${PRINCIPAL}`, Date.now()],
  [`chat_presence_sessions/group/${SID}`, rawStatus(tourId, 'presence')],
  [`chat_typing_sessions/group/${SID}`, rawStatus(tourId, 'typing')],
  ...['group_tour_photos', `private_tour_photos`].flatMap(root => {
    const photo = root === 'group_tour_photos' ? `${root}/${tourId}/owned` : `${root}/${tourId}/${PRINCIPAL}/owned`;
    return [[`${photo}/caption`, 'Synthetic caption'], [`${photo}/captionUpdatedAt`, Date.now()],
      [`${photo}/captionEditedBy`, PRINCIPAL]];
  }),
  [`content_reports/scope_report_${tourId}`, report(tourId)],
  [`notification_read_state/${tourId}/${PRINCIPAL}/notice`, Date.now()],
  [`notification_read_migration_requests/${tourId}/${UID}`, { version: 1, principalId: PRINCIPAL, requestedAtMs: Date.now() }],
];

const seed = async () => {
  await env.clearDatabase();
  const now = Date.now();
  const profile = passengerAuthorityUpdates({ uid: UID, tourId: OLD, principalId: PRINCIPAL, bookingRef: BOOKING, nowMs: now });
  const content = {};
  for (const tourId of [OLD, NEXT]) {
    Object.assign(content, {
      [`tours/${tourId}/isActive`]: true,
      [`tours/${tourId}/driverLocation`]: { latitude: 56, longitude: -4, timestamp: now },
      [`tours/${tourId}/itinerary`]: 'Synthetic itinerary',
      [`tours/${tourId}/liveTracking/${UID}`]: live(),
      [`tour_manifests/${tourId}/bookings/${BOOKING}`]: boarding,
      [`chats/${tourId}/messages/seeded`]: { ...message('seeded'), reactions: { like: { [PRINCIPAL]: true } } },
      [`chats/${tourId}/lastRead/${PRINCIPAL}`]: now,
      [`group_tour_photos/${tourId}/owned`]: { userId: PRINCIPAL, caption: 'Original caption',
        captionUpdatedAt: now, captionEditedBy: PRINCIPAL, timestamp: now,
        storagePath: `group_tour_photos/${tourId}/owned.jpg` },
      [`private_tour_photos/${tourId}/${PRINCIPAL}/owned`]: { userId: PRINCIPAL, caption: 'Original caption',
        captionUpdatedAt: now, captionEditedBy: PRINCIPAL, timestamp: now,
        storagePath: `private_tour_photos/${tourId}/${PRINCIPAL}/owned.jpg` },
      [`broadcasts/${tourId}/announcement`]: { message: 'Synthetic announcement' },
      [`tour_notifications/${tourId}/notice`]: { message: 'Synthetic notice' },
      [`notification_read_state/${tourId}/${PRINCIPAL}/notice`]: now,
      [`passenger_trip_signals/v1/tours/${tourId}`]: { tour: 1 },
      [`content_reports/seeded_report_${tourId}`]: { ...report(tourId), reportId: `seeded_report_${tourId}` },
      [`tour_access_grants/${tourId}/${UID}`]: { source: 'verifyPassengerLogin', bookingRef: BOOKING, tourId,
        grantedAt: new Date(now).toISOString(), grantedAtMs: now, expiresAtMs: now + 3600000 },
    });
  }
  await adminWrite({ ...content, ...profile,
    ...driverAuthorityUpdates({ uid: DRIVER_UID, driverId: 'D-SOURCE-SCOPE', tourId: OLD, nowMs: now }),
    [`passenger_identity_security/${BOOKING}/passengerIdentityVersion`]: 'pax_v2',
    [`passenger_trip_signals/v1/bookings/${BOOKING}`]: { booking: 1 },
    [`booking_access_grants/${BOOKING}/${UID}`]: { source: 'verifyPassengerLogin', bookingRef: BOOKING, tourId: OLD,
      grantedAt: new Date(now).toISOString(), grantedAtMs: now, expiresAtMs: now + 3600000 },
    [`bookings/${BOOKING}`]: { tourId: OLD, loginEligible: true,
      sourceRoster: { schemaVersion: 1, state: 'active', revision: REVISION, passengerIds: [PASSENGER],
        passengerCount: 1, passengerIdsJson: JSON.stringify([PASSENGER]) } },
  });
};
test.before(async () => {
  const hostValue = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  assert.match(hostValue || '', /^127\.0\.0\.1:\d+$/);
  const [host, port] = hostValue.split(':');
  databaseUrl = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, database: { host, port: Number(port),
    rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8') } });
});
test.beforeEach(seed);
test.after(async () => env?.cleanup());

test('the active canonical source passenger can use every inventoried native read/write boundary', async () => {
  const db = client();
  for (const key of readPaths(OLD)) await allow(db.ref(key).get(), key);
  for (const [key, value] of writes(OLD)) await allow(db.ref(key).set(value), key);
  for (const key of [`chats/${OLD}/messages/seeded`, `chats/${OLD}/lastRead/${PRINCIPAL}`,
    `chat_presence_sessions/group/${SID}`, `chat_typing_sessions/group/${SID}`, `tours/${OLD}/liveTracking/${UID}`]) {
    await assertSucceeds(db.ref(key).remove());
  }
});

test('current source authority does not restore retired direct chat projections or client account deletion', async () => {
  const db = client();
  await assertSucceeds(db.ref(`chat_presence_sessions/group/${SID}`).set(rawStatus(OLD, 'presence')));
  await assertFails(db.ref(`chats/${OLD}/presence/${PRINCIPAL}`).set({ online: true, lastSeen: Date.now() }));
  await assertFails(db.ref(`chats/${OLD}/typing/${PRINCIPAL}`).set({ name: 'Passenger', timestamp: Date.now() }));
  await assertFails(db.ref(`users/${UID}`).remove());
});

for (const [name, patch] of [
  ['tour transfer', { [`bookings/${BOOKING}/tourId`]: NEXT }],
  ['source absence', { [`bookings/${BOOKING}/sourceRoster/state`]: 'not_in_report' }],
  ['missing source email', { [`bookings/${BOOKING}/loginEligible`]: false }],
  ['manual booking without email', { [`bookings/${BOOKING}/sourceRoster`]: null,
    [`bookings/${BOOKING}/source`]: 'web-admin-manual', [`bookings/${BOOKING}/loginEligible`]: false }],
]) test(`${name} denies retained old-session reads, writes and deletes without removing old runtime`, async () => {
  const db = client();
  // Populate every mutable leaf first so delete tests exercise real existing data.
  for (const [key, value] of writes(OLD)) await allow(db.ref(key).set(value), key);
  const oldChat = await readValue(`chats/${OLD}`);
  const oldParticipant = await readValue(`tours/${OLD}/participants/${UID}`);
  const oldManifest = await readValue(`tour_manifests/${OLD}/bookings/${BOOKING}`);
  await adminWrite(patch);
  for (const key of readPaths(OLD)) await assertFails(db.ref(key).get());
  for (const [key, value] of writes(OLD)) {
    await assertFails(db.ref(key).set(value));
    await assertFails(db.ref(key).remove());
  }
  assert.deepEqual(await readValue(`chats/${OLD}`), oldChat);
  assert.deepEqual(await readValue(`tours/${OLD}/participants/${UID}`), oldParticipant);
  assert.deepEqual(await readValue(`tour_manifests/${OLD}/bookings/${BOOKING}`), oldManifest);
  // Direct deletion is retired. Even trusted removal must not turn a missing
  // profile into a no-source legacy fallback and restore former tour access.
  await assertFails(db.ref(`users/${UID}`).remove());
  await adminWrite({ [`users/${UID}`]: null });
  await assertFails(db.ref(`chats/${OLD}`).get());
  await assertFails(db.ref(`chats/${OLD}/messages/seeded`).remove());
});

test('fresh destination authority restores native scope and cannot mutate retained source-tour history', async () => {
  const db = client();
  await adminWrite({ [`bookings/${BOOKING}/tourId`]: NEXT,
    [`booking_access_grants/${BOOKING}/${UID}/tourId`]: NEXT,
    ...passengerAuthorityUpdates({ uid: UID, tourId: NEXT, principalId: PRINCIPAL, bookingRef: BOOKING }) });
  for (const key of readPaths(NEXT)) await allow(db.ref(key).get(), key);
  for (const [key, value] of writes(NEXT)) await allow(db.ref(key).set(value), key);
  await assertFails(db.ref(`chats/${OLD}`).get());
  await assertFails(db.ref(`chats/${OLD}/messages/seeded`).remove());
  await assertFails(db.ref(`group_tour_photos/${OLD}/owned/caption`).set('Changed history'));
});

test('legacy/manual bookings retain established passenger behavior and transferred source rows do not restrict drivers/admins', async () => {
  await adminWrite({ [`bookings/${BOOKING}/sourceRoster`]: null, [`bookings/${BOOKING}/loginEligible`]: true,
    [`bookings/${BOOKING}/source`]: 'web-admin-manual' });
  await assertSucceeds(client().ref(`chats/${OLD}`).get());
  await assertSucceeds(client().ref(`chats/${OLD}/messages/new_legacy`).set(message('new_legacy')));
  await adminWrite({ [`bookings/${BOOKING}/sourceRoster`]: { schemaVersion: 1, state: 'active' },
    [`bookings/${BOOKING}/tourId`]: NEXT });
  await assertSucceeds(client(DRIVER_UID).ref(`chats/${OLD}`).get());
  await assertSucceeds(client(DRIVER_UID).ref(`tours/${OLD}/itinerary`).set({ title: 'Driver retains operational access' }));
  await assertSucceeds(client(ADMIN_UID).ref(`chats/${OLD}`).get());
  await assertSucceeds(client(ADMIN_UID).ref(`chats/${OLD}/messages/seeded`).remove());
});

test('source booking reference bounds accept legal keys and deny path/control/length corruption', async () => {
  const source = await readValue(`bookings/${BOOKING}`);
  const security = await readValue(`passenger_identity_security/${BOOKING}`);
  const db = client();
  for (const ref of ['T123UF-ABC', 'SOURCE_U_F123', 'SOURCE 12 UF', 'SOURCE:123', 'A'.repeat(160)]) {
    await adminWrite({ [`bookings/${ref}`]: source, [`passenger_identity_security/${ref}`]: security, [`users/${UID}/bookingRef`]: ref });
    await allow(db.ref(`chats/${OLD}`).get(), `valid reference ${JSON.stringify(ref)}`);
  }
  // A legal RTDB key over the application bound must still fail when its source
  // record exists, so this cannot pass merely because a malformed path is absent.
  const longRef = 'A'.repeat(161);
  await adminWrite({ [`bookings/${longRef}`]: source, [`passenger_identity_security/${longRef}`]: security, [`users/${UID}/bookingRef`]: longRef });
  await assertFails(db.ref(`chats/${OLD}`).get());
  // A slash can address a real nested record. It must not confer source scope.
  await adminWrite({ 'bookings/BAD/KEY': source, 'passenger_identity_security/BAD/KEY': security, [`users/${UID}/bookingRef`]: 'BAD/KEY' });
  await assertFails(db.ref(`chats/${OLD}`).get());
  for (const ref of ['BAD.KEY', 'BAD#KEY', 'BAD$KEY', 'BAD[KEY', 'BAD]KEY', 'BAD\u0001KEY', 'BAD\u007fKEY']) {
    await adminWrite({ [`users/${UID}/bookingRef`]: ref });
    await assertFails(db.ref(`chats/${OLD}`).get());
  }
});

test('legacy fallback cannot bypass missing profiles, revoked sessions or malformed references without a source node', async () => {
  for (const patch of [
    { [`users/${UID}`]: null },
    { [`app_sessions/${UID}/status`]: 'revoked' },
    { [`users/${UID}/bookingRef`]: null },
    { [`users/${UID}/bookingRef`]: 'BAD/KEY' },
    { [`app_sessions/${UID}/principalId`]: `pax_v2_${'c'.repeat(32)}` },
  ]) {
    await seed();
    await adminWrite({ [`bookings/${BOOKING}/sourceRoster`]: null, ...patch });
    await assertFails(client().ref(`chats/${OLD}`).get());
    await assertFails(client().ref(`chats/${OLD}/messages/seeded`).remove());
    assert.ok(await readValue(`chats/${OLD}/messages/seeded`));
  }
});
