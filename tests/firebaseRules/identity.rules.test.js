const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizePassengerLoginDevice } = require('../../functions/lib/passengerIdentity');
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

test('cold server credential transaction loads an existing identity before binding the first device', async () => {
  const credentialPath = 'passenger_identity_security/COLD_LOGIN';
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(credentialPath).set({
      passengerPrincipalId: STABLE_ID, passengerIdentityVersion: 'pax_v2',
    });
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const ref = context.database(dbUrl).ref(credentialPath);
    const seen = [];
    const result = await authorizePassengerLoginDevice({
      authUid: USER_UID,
      securityRef: { transaction: (update) => ref.transaction((current) => {
        seen.push(current);
        return update(current);
      }) },
    });
    assert.equal(seen[0], null, 'fresh SDK connection has no cached security record');
    assert.equal(result.authorizedAuthUid, USER_UID);
    assert.equal(result.passengerPrincipalId, STABLE_ID);
    assert.equal((await ref.once('value')).val().authorizedAuthUid, USER_UID);
  });
});

test('cold credential checks preserve same-device access and reject missing, malformed, locked or other-device records', async () => {
  for (const [name, record, reason] of [
    ['same', { passengerPrincipalId: STABLE_ID, authorizedAuthUid: USER_UID }, null],
    ['missing', null, 'IDENTITY_INCOMPLETE'],
    ['malformed', { passengerPrincipalId: 'invalid' }, 'IDENTITY_INCOMPLETE'],
    ['locked', { passengerPrincipalId: STABLE_ID, loginLocked: true }, 'REAUTHORIZE_REQUIRED'],
    ['other', { passengerPrincipalId: STABLE_ID, authorizedAuthUid: 'another-device' }, 'REAUTHORIZE_REQUIRED'],
  ]) {
    const credentialPath = `passenger_identity_security/COLD_${name}`;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.database(dbUrl).ref(credentialPath).set(record);
    });
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const ref = context.database(dbUrl).ref(credentialPath);
      const login = () => authorizePassengerLoginDevice({ securityRef: ref, authUid: USER_UID });
      if (reason) await assert.rejects(login, (error) => error.code === reason, name);
      else assert.equal((await login()).authorizedAuthUid, USER_UID);
      assert.deepEqual((await ref.once('value')).val(), record, `${name} must not rewrite security state`);
    });
  }
});

test('concurrent cold device logins bind only one winner without replacing its identity', async () => {
  const credentialPath = 'passenger_identity_security/COLD_RACE';
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(credentialPath).set({ passengerPrincipalId: STABLE_ID });
  });
  const outcomes = await Promise.allSettled(['device-a', 'device-b'].map(async (authUid) => {
    let identity;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      identity = await authorizePassengerLoginDevice({
        securityRef: context.database(dbUrl).ref(credentialPath), authUid,
      });
    });
    return identity;
  }));
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'REAUTHORIZE_REQUIRED');
  const winner = outcomes.find((result) => result.status === 'fulfilled').value;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    assert.deepEqual((await context.database(dbUrl).ref(credentialPath).once('value')).val(), winner);
    assert.equal(winner.passengerPrincipalId, STABLE_ID);
  });
});

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
