const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-app-session-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const AUTH_UID = 'passenger-session-user';
const OTHER_UID = 'other-session-user';
const DRIVER_UID = 'driver-session-user';
const DRIVER_ID = 'D-SESSION';
const TOUR_ID = 'TOUR_SESSION';
const PRINCIPAL_ID = `pax_v2_${'1'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'2'.repeat(32)}`;
const DRIVER_SESSION_ID = `sess_v1_${'3'.repeat(32)}`;
const NOW = Date.now();
const EXPIRES = NOW + (60 * 60 * 1000);

const parseHost = () => {
  const [host, portText] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  return { host, port: Number(portText), databaseURL: `http://${host}:${portText}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
let testEnv;
let dbUrl;
const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const passengerSession = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  authUid: AUTH_UID,
  principalId: PRINCIPAL_ID,
  principalType: 'passenger',
  tourId: TOUR_ID,
  status: 'active',
  issuedAtMs: NOW,
  lastAuthenticatedAtMs: NOW,
  expiresAtMs: EXPIRES,
  sessionRevision: 1,
};

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
});

test.beforeEach(async () => {
  await testEnv.clearDatabase();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      [`app_sessions/${AUTH_UID}`]: passengerSession,
      [`users/${AUTH_UID}`]: {
        principalType: 'passenger',
        stablePassengerId: PRINCIPAL_ID,
        stablePassengerKey: PRINCIPAL_ID,
        privatePhotoOwnerId: PRINCIPAL_ID,
        privatePhotoOwnerKey: PRINCIPAL_ID,
        identityVersion: 'pax_v2',
        bookingRef: 'BOOK-SESSION',
      },
      [`tours/${TOUR_ID}`]: {
        name: 'Session tour',
        isActive: true,
        participants: {
          [AUTH_UID]: {
            schemaVersion: 2,
            userId: AUTH_UID,
            principalId: PRINCIPAL_ID,
            sessionId: SESSION_ID,
            sessionExpiresAtMs: EXPIRES,
            joinedAtMs: NOW,
            lastAuthenticatedAtMs: NOW,
          },
        },
      },
      [`group_tour_photos/${TOUR_ID}/photo-1`]: {
        userId: PRINCIPAL_ID,
        storagePath: `group_tour_photos/${TOUR_ID}/photo-1.jpg`,
        timestamp: NOW,
      },
      [`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}/private-1`]: {
        userId: PRINCIPAL_ID,
        storagePath: `private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}/private-1.jpg`,
        timestamp: NOW,
      },
      [`users/${DRIVER_UID}`]: {
        principalType: 'driver',
        driverId: DRIVER_ID,
        driverPrincipalId: `driver:${DRIVER_ID}`,
        driverAssignedTourId: TOUR_ID,
      },
      [`drivers/${DRIVER_ID}`]: { authUid: DRIVER_UID, currentTourId: TOUR_ID, name: 'Driver' },
      [`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`]: true,
      [`bookings/BOOK-SESSION`]: { tourId: TOUR_ID },
      [`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`]: { status: 'PENDING' },
      [`app_sessions/${DRIVER_UID}`]: {
        schemaVersion: 1,
        sessionId: DRIVER_SESSION_ID,
        authUid: DRIVER_UID,
        principalId: `driver:${DRIVER_ID}`,
        principalType: 'driver',
        tourId: TOUR_ID,
        driverId: DRIVER_ID,
        status: 'active',
        issuedAtMs: NOW,
        lastAuthenticatedAtMs: NOW,
        expiresAtMs: EXPIRES,
        sessionRevision: 1,
      },
      'driver_tour_packs/departure-1': {
        tourId: TOUR_ID,
        expiresAtMs: EXPIRES,
        revision: 1,
      },
    });
  });
});

test.after(async () => { if (testEnv) await testEnv.cleanup(); });

test('active passenger session can read tour and photo metadata and write ephemeral chat state', async () => {
  const db = dbFor(AUTH_UID);
  await assertSucceeds(db.ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(db.ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/itinerary`).get());
  await assertSucceeds(db.ref(`group_tour_photos/${TOUR_ID}`).get());
  await assertSucceeds(db.ref(`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}`).get());
  await assertSucceeds(db.ref(`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`).get());
  await assertSucceeds(db.ref(`chats/${TOUR_ID}/typing/${PRINCIPAL_ID}`).set({ name: 'Passenger', timestamp: NOW }));
  await assertSucceeds(db.ref(`chats/${TOUR_ID}/presence/${PRINCIPAL_ID}`).set({
    name: 'Passenger', lastSeen: NOW, online: true,
  }));
});

test('the same still-authenticated token loses every sensitive path when its app session is removed', async () => {
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(`app_sessions/${AUTH_UID}`).remove());
  const db = dbFor(AUTH_UID);
  await assertSucceeds(db.ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(db.ref(`tours/${TOUR_ID}`).get());
  await assertFails(db.ref(`group_tour_photos/${TOUR_ID}`).get());
  await assertFails(db.ref(`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}`).get());
  await assertFails(db.ref(`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`).get());
  await assertFails(db.ref(`logs/${AUTH_UID}/session/probe`).set({ message: 'stale' }));
  await assertFails(db.ref(`chats/${TOUR_ID}/typing/${PRINCIPAL_ID}`).set({ name: 'Stale', timestamp: NOW }));
  await assertFails(db.ref(`chats/${TOUR_ID}/presence/${PRINCIPAL_ID}`).set({ name: 'Stale', lastSeen: NOW, online: true }));
});

test('stale membership and stale assignment alone grant no access', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    await db.ref(`app_sessions/${AUTH_UID}`).remove();
    await db.ref(`app_sessions/${DRIVER_UID}`).remove();
  });
  await assertFails(dbFor(AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
});

test('session records are server-owned, self-readable only, and admin-readable', async () => {
  await assertFails(dbFor(OTHER_UID).ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(dbFor(AUTH_UID).ref(`app_sessions/${AUTH_UID}/status`).set('active'));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`app_sessions/${AUTH_UID}`).get());
});

test('assigned driver needs the matching active session for operational access', async () => {
  await assertSucceeds(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(`app_sessions/${DRIVER_UID}/expiresAtMs`).set(NOW - 1));
  await assertFails(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
});
