const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const PROJECT_ID = 'demo-llt-passenger-trip';
const uid = 'synthetic-trip-user';
const principal = `pax_v2_${'a'.repeat(32)}`;
const session = `sess_v1_${'b'.repeat(32)}`;
let env; let url;
const read = (user, suffix) => env.authenticatedContext(user).database(url).ref(`passenger_trip_signals/v1/${suffix}`).get();
const seed = async (patch = {}) => env.withSecurityRulesDisabled(async (context) => {
  const now = Date.now();
  await context.database(url).ref().set({
    app_sessions: { [uid]: { schemaVersion: 1, authUid: uid, principalType: 'passenger', principalId: principal,
      sessionId: session, tourId: 'TRIP_1', status: 'active', expiresAtMs: now + 60000 } },
    users: { [uid]: { principalType: 'passenger', stablePassengerId: principal, identityVersion: 'pax_v2', bookingRef: 'TEST123' } },
    passenger_identity_security: { TEST123: { passengerPrincipalId: principal, authorizedAuthUid: uid } },
    bookings: { TEST123: { tourId: 'TRIP_1' }, OTHER: { tourId: 'TRIP_2' } },
    tours: { TRIP_1: { participants: { [uid]: { schemaVersion: 2, userId: uid, principalId: principal,
      sessionId: session, sessionExpiresAtMs: now + 60000 } } } },
    passenger_trip_signals: { v1: { bookings: { TEST123: { schemaVersion: 1, booking: 1 }, OTHER: { booking: 1 } },
      tours: { TRIP_1: { schemaVersion: 1, tour: 1, itinerary: 1 }, TRIP_2: { tour: 1 } } } },
  });
  if (Object.keys(patch).length) await context.database(url).ref().update(patch);
});
test.before(async () => {
  const hostValue = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!hostValue) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST is required; rules verification was not run');
  const [host, port] = hostValue.split(':');
  url = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, database: { host, port: Number(port),
    rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8') } });
});
test.after(async () => env?.cleanup());
test('active bound passenger reads own exact signals, including missing bootstrap records', async () => {
  await seed();
  await assertSucceeds(read(uid, 'bookings/TEST123')); await assertSucceeds(read(uid, 'tours/TRIP_1'));
  await env.withSecurityRulesDisabled((context) => context.database(url).ref('passenger_trip_signals/v1/tours/TRIP_1').remove());
  await assertSucceeds(read(uid, 'tours/TRIP_1'));
});
test('parent enumeration, unrelated users/scopes and client writes remain denied', async () => {
  await seed();
  for (const suffix of ['', 'bookings', 'tours', 'bookings/OTHER', 'tours/TRIP_2']) await assertFails(read(uid, suffix));
  await assertFails(read('other-user', 'bookings/TEST123'));
  const db = env.authenticatedContext(uid).database(url);
  await assertFails(db.ref('passenger_trip_signals/v1/bookings/TEST123/booking').set(0));
  await assertFails(db.ref('passenger_trip_signals/v1/tours/TRIP_1').remove());
  await assertFails(db.ref('bookings/TEST123').get()); await assertFails(db.ref('tours/TRIP_1').get());
});
test('expired, replaced, reassociated, locked and deleted sessions cannot read signals', async () => {
  for (const patch of [
    { [`app_sessions/${uid}/expiresAtMs`]: 1 },
    { [`tours/TRIP_1/participants/${uid}/sessionId`]: `sess_v1_${'c'.repeat(32)}` },
    { 'bookings/TEST123/tourId': 'TRIP_2' },
    { 'passenger_identity_security/TEST123/authorizedAuthUid': 'another' },
    { 'passenger_identity_security/TEST123/loginLocked': true },
    { [`account_deletion_active/v1/${uid}`]: { job: 'synthetic' } },
  ]) { await seed(patch); await assertFails(read(uid, 'bookings/TEST123')); await assertFails(read(uid, 'tours/TRIP_1')); }
});
