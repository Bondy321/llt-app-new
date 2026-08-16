const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { toRealtimeKeySegment } = require('../../services/identityService');

const PROJECT_ID = 'demo-llt-identity-rules';
const USER_UID = 'passenger-auth-identity-1';
const BOOKING_REF = 'T123456';
const EMAIL = 'traveller@example.com';
const STABLE_ID = `pax_v1:${BOOKING_REF}:${EMAIL}`;
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
      normalizedPassengerEmail: EMAIL,
      expiresAtMs: Date.now() + 60_000,
    });
    await context.database(dbUrl).ref('drivers/D-CLAIMED').set({
      authUid: 'another-driver-auth',
    });
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('verified passenger can persist only the canonical granted identity and binding', async () => {
  const db = dbFor(USER_UID);
  await assertSucceeds(db.ref().update({
    [`users/${USER_UID}/stablePassengerId`]: STABLE_ID,
    [`users/${USER_UID}/stablePassengerKey`]: STABLE_KEY,
    [`users/${USER_UID}/privatePhotoOwnerId`]: STABLE_ID,
    [`users/${USER_UID}/privatePhotoOwnerKey`]: STABLE_KEY,
    [`users/${USER_UID}/privatePhotoOwnerType`]: 'stable_passenger',
    [`users/${USER_UID}/identityVersion`]: 'pax_v1',
    [`users/${USER_UID}/bookingRef`]: BOOKING_REF,
    [`users/${USER_UID}/normalizedPassengerEmail`]: EMAIL,
    [`users/${USER_UID}/principalType`]: 'passenger',
  }));
  await assertSucceeds(db.ref(`identity_bindings/${STABLE_KEY}/${USER_UID}`).set(true));
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
    identityVersion: 'pax_v1',
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
  await assertFails(dbFor(USER_UID).ref(`identity_bindings/${toRealtimeKeySegment('pax_v1:OTHER:other@example.com')}/${USER_UID}`).set(true));
});
