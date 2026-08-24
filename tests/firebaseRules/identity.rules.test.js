const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { toRealtimeKeySegment } = require('../../services/identityService');
const { passengerAuthorityUpdates } = require('./sessionFixtures');

const PROJECT_ID = 'demo-llt-identity-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const USER_UID = 'passenger-auth-identity-1';
const BOOKING_REF = 'T123456';
const EMAIL = 'traveller@example.com';
const STABLE_ID = 'pax_v2_0123456789abcdef0123456789abcdef';
const STABLE_KEY = toRealtimeKeySegment(STABLE_ID);

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(`booking_access_grants/${BOOKING_REF}/${USER_UID}`).set({
      bookingRef: BOOKING_REF,
      tourId: 'TOUR_1',
      expiresAtMs: Date.now() + 60_000,
    });
    await context.database(dbUrl).ref('drivers/D-CLAIMED').set({
      authUid: 'another-driver-auth',
    });
    await context.database(dbUrl).ref(`users/${USER_UID}`).set({
      stablePassengerId: STABLE_ID,
      stablePassengerKey: STABLE_KEY,
      privatePhotoOwnerId: STABLE_ID,
      privatePhotoOwnerKey: STABLE_KEY,
      privatePhotoOwnerType: 'opaque_passenger',
      identityVersion: 'pax_v2',
      bookingRef: BOOKING_REF,
      principalType: 'passenger',
    });
    await context.database(dbUrl).ref(`identity_bindings/${STABLE_KEY}/${USER_UID}`).set(true);
    await context.database(dbUrl).ref().update(passengerAuthorityUpdates({
      uid: USER_UID, tourId: 'TOUR_1', principalId: STABLE_ID, bookingRef: BOOKING_REF,
    }));
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('passenger identity profile is server-owned and an existing binding is owner-removable only', async () => {
  const db = dbFor(USER_UID);
  await assertSucceeds(db.ref(`users/${USER_UID}`).get());
  await assertFails(db.ref(`users/${USER_UID}/stablePassengerId`).set('pax_v2_fedcba9876543210fedcba9876543210'));
  await assertSucceeds(db.ref(`identity_bindings/${STABLE_KEY}/${USER_UID}`).set(null));
  await assertFails(db.ref(`identity_bindings/${STABLE_KEY}/${USER_UID}`).set(true));
});

test('passenger login security records cannot be read, created, or reassigned by clients', async () => {
  const passenger = dbFor(USER_UID);
  const attacker = dbFor('attacker-auth');
  await assertFails(passenger.ref(`passenger_identity_security/${BOOKING_REF}`).get());
  await assertFails(passenger.ref(`passenger_identity_security/${BOOKING_REF}/authorizedAuthUid`).set(USER_UID));
  await assertFails(attacker.ref(`passenger_identity_security/${BOOKING_REF}`).get());
});

test('verified access grants reject passenger email credential copies', async () => {
  const now = Date.now();
  const grant = {
    source: 'verifyPassengerLogin',
    bookingRef: BOOKING_REF,
    tourId: 'TOUR_1',
    grantedAt: new Date(now).toISOString(),
    grantedAtMs: now,
    expiresAtMs: now + 60_000,
  };
  const adminDb = dbFor(ADMIN_UID);
  await assertSucceeds(adminDb.ref(`booking_access_grants/${BOOKING_REF}/safe-auth`).set(grant));
  await assertFails(adminDb.ref(`booking_access_grants/${BOOKING_REF}/leaky-auth`).set({
    ...grant,
    normalizedPassengerEmail: EMAIL,
  }));
  await assertFails(adminDb.ref('tour_access_grants/TOUR_1/leaky-auth').set({
    ...grant,
    normalizedPassengerEmail: EMAIL,
  }));
});

test('authenticated client cannot forge a passenger or driver identity', async () => {
  const attacker = dbFor('attacker-auth');
  const forgedId = `pax_v1:${BOOKING_REF}:${EMAIL}`;
  const forgedKey = toRealtimeKeySegment(forgedId);
  await assertFails(attacker.ref('users/attacker-auth').set({
    stablePassengerId: forgedId,
    stablePassengerKey: forgedKey,
    privatePhotoOwnerId: forgedId,
    privatePhotoOwnerKey: forgedKey,
    identityVersion: 'pax_v2',
    bookingRef: BOOKING_REF,
    normalizedPassengerEmail: EMAIL,
  }));
  await assertFails(attacker.ref(`identity_bindings/${forgedKey}/attacker-auth`).set(true));
  await assertFails(attacker.ref('users/attacker-auth').set({
    driverId: 'D-CLAIMED',
    driverPrincipalId: 'driver:D-CLAIMED',
    principalType: 'driver',
  }));
});

test('verified passenger cannot bind an arbitrary identity path', async () => {
  await assertFails(dbFor(USER_UID).ref('identity_bindings/pax_v2_fedcba9876543210fedcba9876543210/passenger-auth-identity-1').set(true));
});
