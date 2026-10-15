'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
  isPassengerDeviceAuthorized,
} = require('../functions/lib/passengerIdentity');
const {
  buildDatabaseMigration,
  containsLegacyIdentity,
  listStorageMoves,
} = require('../functions/lib/passengerIdentityMigration');

const OPAQUE_ID = 'pax_v2_0123456789abcdef0123456789abcdef';
const LEGACY_ID = 'pax_v1:ABC123:person@example.com';
const LEGACY_KEY = 'pax_v1:ABC123:person@example_2E_com';

test('server identity issuer stores a random opaque identity without credentials', async () => {
  let stored = null;
  const securityRef = {
    async transaction(updater) {
      stored = updater(stored);
      return { committed: true, snapshot: { val: () => stored } };
    },
  };
  const result = await ensureOpaquePassengerIdentity({
    securityRef,
    createId: () => OPAQUE_ID,
    nowMs: 123,
  });
  assert.equal(result.passengerPrincipalId, OPAQUE_ID);
  assert.equal(isOpaquePassengerId(result.passengerPrincipalId), true);
  assert.equal(result.passengerPrincipalId.includes('ABC123'), false);
  assert.equal(result.passengerPrincipalId.includes('person'), false);
  assert.equal(stored.passengerIdentityVersion, 'pax_v2');
  assert.equal(stored.bookingRef, undefined);
  assert.equal(stored.email, undefined);
});

test('security updates bind only the server-issued identity and remove legacy bindings and email copies', () => {
  const updates = buildPassengerIdentitySecurityUpdates({
    authUid: 'auth-1',
    bookingRef: 'ABC123',
    tourId: 'TOUR_1',
    passengerPrincipalId: OPAQUE_ID,
    previousProfile: { stablePassengerId: LEGACY_ID, stablePassengerKey: LEGACY_KEY },
    nowMs: 123,
  });
  assert.equal(updates['users/auth-1/stablePassengerId'], OPAQUE_ID);
  assert.equal(updates['users/auth-1/normalizedPassengerEmail'], null);
  assert.equal(updates[`identity_bindings/${OPAQUE_ID}/auth-1`], true);
  assert.equal(updates[`identity_bindings/${LEGACY_ID}/auth-1`], null);
  assert.equal(updates[`identity_bindings_meta/${LEGACY_KEY}`], null);
  assert.deepEqual(updates[`identity_bindings_meta/${OPAQUE_ID}`], {
    identityVersion: 'pax_v2', lastSeenAt: 123,
  });
});

test('verified second phone is added without replacing legacy authority, principal or history', async () => {
  let stored = { passengerPrincipalId: OPAQUE_ID, authorizedAuthUid: 'victim-auth' };
  const securityRef = {
    async transaction(updater) {
      const next = updater(stored);
      if (next === undefined) return { committed: false, snapshot: { val: () => stored } };
      stored = next;
      return { committed: true, snapshot: { val: () => stored } };
    },
  };
  await authorizePassengerLoginDevice({ securityRef, authUid: 'second-phone' });
  assert.equal(stored.authorizedAuthUid, 'victim-auth');
  assert.equal(stored.deviceAuthorizationVersion, 2);
  assert.deepEqual(stored.authorizedAuthUids, { 'victim-auth': true, 'second-phone': true });
  assert.equal(stored.passengerPrincipalId, OPAQUE_ID);
  assert.equal(isPassengerDeviceAuthorized(stored, 'victim-auth'), true);
  assert.equal(isPassengerDeviceAuthorized(stored, 'second-phone'), true);
  assert.equal(isPassengerDeviceAuthorized(stored, 'unverified-phone'), false);
  const first = JSON.stringify(stored);
  await authorizePassengerLoginDevice({ securityRef, authUid: 'second-phone' });
  assert.equal(JSON.stringify(stored), first, 'repeat admission must not churn existing device state');
});

test('versioned membership fails closed and legacy authority cannot bypass explicit map withdrawal', () => {
  const legacy = { authorizedAuthUid: 'old-phone' };
  assert.equal(isPassengerDeviceAuthorized(legacy, 'old-phone'), true);
  assert.equal(isPassengerDeviceAuthorized(legacy, 'new-phone'), false);
  for (const value of [undefined, null, false, 'true', 1]) {
    const current = { ...legacy, deviceAuthorizationVersion: 2, authorizedAuthUids: { 'old-phone': value, 'new-phone': true } };
    assert.equal(isPassengerDeviceAuthorized(current, 'old-phone'), false);
    assert.equal(isPassengerDeviceAuthorized(current, 'new-phone'), true);
  }
  for (const deviceAuthorizationVersion of [0, 1, 3, '2', false]) {
    assert.equal(isPassengerDeviceAuthorized({ ...legacy, deviceAuthorizationVersion, authorizedAuthUids: { 'old-phone': true } }, 'old-phone'), false);
  }
  assert.equal(isPassengerDeviceAuthorized({ ...legacy, loginLocked: true }, 'old-phone'), false);
  assert.equal(isPassengerDeviceAuthorized({ deviceAuthorizationVersion: 2, authorizedAuthUids: ['old-phone'] }, 'old-phone'), false);
  assert.equal(isPassengerDeviceAuthorized({ ...legacy, authorizedAuthUid: 'bad/key' }, 'bad/key'), false);
});

test('device admission retains migration locks and rejects malformed authorization versions without rewriting', async () => {
  for (const record of [
    { passengerPrincipalId: OPAQUE_ID, loginLocked: true },
    { passengerPrincipalId: OPAQUE_ID, deviceAuthorizationVersion: 3 },
    { passengerPrincipalId: OPAQUE_ID, deviceAuthorizationVersion: 2, authorizedAuthUids: 'malformed' },
  ]) {
    let stored = structuredClone(record);
    const securityRef = { async transaction(update) {
      const next = update(stored);
      if (next === undefined) return { committed: false, snapshot: { val: () => stored } };
      stored = next;
      return { committed: true, snapshot: { val: () => stored } };
    } };
    await assert.rejects(authorizePassengerLoginDevice({ securityRef, authUid: 'new-phone' }),
      error => error.code === (record.loginLocked ? 'REAUTHORIZE_REQUIRED' : 'IDENTITY_INCOMPLETE'));
    assert.deepEqual(stored, record);
  }
});

test('migration rewrites all exposed identity surfaces and invalidates passenger grants', () => {
  const snapshot = {
    booking_identities: {
      ABC123: { bookingRef: 'ABC123', email: 'person@example.com', tourId: 'TOUR_1' },
    },
    users: {
      'auth-1': {
        bookingRef: 'ABC123',
        normalizedPassengerEmail: 'person@example.com',
        stablePassengerId: LEGACY_ID,
        stablePassengerKey: LEGACY_KEY,
        privatePhotoOwnerId: LEGACY_ID,
        privatePhotoOwnerKey: LEGACY_KEY,
      },
    },
    identity_bindings: { [LEGACY_KEY]: { 'auth-1': true } },
    identity_bindings_meta: { [LEGACY_KEY]: { bookingRef: 'ABC123', normalizedPassengerEmail: 'person@example.com' } },
    chats: {
      TOUR_1: {
        messages: { m1: { senderId: LEGACY_ID, senderStableId: LEGACY_ID } },
        reactions: { wave: { [LEGACY_KEY]: true } },
        presence: { [LEGACY_KEY]: { online: true } },
      },
    },
    private_tour_photos: {
      TOUR_1: {
        [LEGACY_KEY]: {
          p1: {
            userId: LEGACY_ID,
            storagePath: `private_tour_photos/TOUR_1/${LEGACY_KEY}/source.jpg`,
          },
        },
      },
    },
    content_reports: { r1: { reporterId: LEGACY_ID, contentOwnerId: LEGACY_ID } },
    notification_read_state: { TOUR_1: { [LEGACY_KEY]: { notice: 1 } } },
    tour_access_grants: { TOUR_1: { 'auth-1': { expiresAtMs: 999 } } },
    booking_access_grants: { ABC123: { 'auth-1': { expiresAtMs: 999 } } },
  };
  const plan = buildDatabaseMigration({ snapshot, createId: () => OPAQUE_ID, nowMs: 123 });
  assert.deepEqual(plan.legacyRemaining, []);
  assert.equal(plan.next.chats.TOUR_1.messages.m1.senderId, OPAQUE_ID);
  assert.equal(plan.next.private_tour_photos.TOUR_1[OPAQUE_ID].p1.userId, OPAQUE_ID);
  assert.equal(plan.next.notification_read_state.TOUR_1[OPAQUE_ID].notice, 1);
  assert.equal(plan.next.users['auth-1'].normalizedPassengerEmail, undefined);
  assert.equal(plan.next.passenger_identity_security.ABC123.authorizedAuthUid, 'auth-1');
  assert.equal(plan.next.passenger_identity_security.ABC123.passengerPrincipalId, OPAQUE_ID);
  assert.equal(plan.next.booking_identities.ABC123.authorizedAuthUid, undefined);
  assert.equal(plan.next.booking_identities.ABC123.passengerPrincipalId, undefined);
  assert.equal(plan.securityRecordCount, 1);
  assert.equal(plan.bookingSecurityResidueCount, 0);
  assert.equal(plan.next.tour_access_grants, null);
  assert.equal(plan.next.booking_access_grants, null);
  assert.equal(containsLegacyIdentity(plan.next.chats), false);

  assert.deepEqual(listStorageMoves({
    files: [
      `private_tour_photos/TOUR_1/${LEGACY_KEY}/source.jpg`,
      'group_tour_photos/TOUR_1/123_pax_v1_ABC123_person_example.com.jpg',
    ],
    aliasMap: plan.aliasMap,
  }), [
    {
      source: `private_tour_photos/TOUR_1/${LEGACY_KEY}/source.jpg`,
      destination: `private_tour_photos/TOUR_1/${OPAQUE_ID}/source.jpg`,
    },
    {
      source: 'group_tour_photos/TOUR_1/123_pax_v1_ABC123_person_example.com.jpg',
      destination: `group_tour_photos/TOUR_1/123_${OPAQUE_ID}.jpg`,
    },
  ]);
});

test('migration locks ambiguous legacy bookings instead of trusting several existing identities', () => {
  const plan = buildDatabaseMigration({
    snapshot: {
      booking_identities: { ABC123: { bookingRef: 'ABC123', email: 'person@example.com' } },
      users: {
        first: { bookingRef: 'ABC123', stablePassengerId: LEGACY_ID },
        second: { bookingRef: 'ABC123', stablePassengerId: LEGACY_ID },
      },
    },
    createId: () => OPAQUE_ID,
  });
  assert.equal(plan.next.passenger_identity_security.ABC123.loginLocked, true);
  assert.equal(plan.next.passenger_identity_security.ABC123.loginLockReason, 'ambiguous_legacy_bindings');
  assert.equal(plan.next.passenger_identity_security.ABC123.authorizedAuthUid, undefined);
  assert.equal(plan.lockedBookingCount, 1);
});

test('migration is idempotent once opaque identities are present', () => {
  const snapshot = {
    booking_identities: {
      ABC123: {
        bookingRef: 'ABC123', email: 'person@example.com', tourId: 'TOUR_1',
      },
    },
    passenger_identity_security: {
      ABC123: {
        passengerPrincipalId: OPAQUE_ID,
        passengerIdentityVersion: 'pax_v2',
        authorizedAuthUid: 'auth-1',
      },
    },
    users: { 'auth-1': { stablePassengerId: OPAQUE_ID, identityVersion: 'pax_v2' } },
  };
  const plan = buildDatabaseMigration({ snapshot, createId: () => { throw new Error('must not rotate'); } });
  assert.equal(plan.next.passenger_identity_security.ABC123.passengerPrincipalId, OPAQUE_ID);
  assert.equal(plan.next.passenger_identity_security.ABC123.authorizedAuthUid, 'auth-1');
  assert.deepEqual(plan.legacyRemaining, []);
});

test('booking credential refreshes cannot overwrite the separated security record', () => {
  const snapshot = {
    booking_identities: {
      ABC123: { bookingRef: 'ABC123', email: 'new@example.com', tourId: 'TOUR_2' },
    },
    passenger_identity_security: {
      ABC123: {
        passengerPrincipalId: OPAQUE_ID,
        passengerIdentityVersion: 'pax_v2',
        passengerIdentityIssuedAtMs: 100,
        authorizedAuthUid: 'victim-auth',
        loginDeviceBoundAtMs: 101,
      },
    },
  };
  const plan = buildDatabaseMigration({ snapshot, createId: () => { throw new Error('must not rotate'); } });
  assert.equal(plan.next.booking_identities.ABC123.email, 'new@example.com');
  assert.equal(plan.next.booking_identities.ABC123.passengerPrincipalId, undefined);
  assert.equal(plan.next.passenger_identity_security.ABC123.passengerPrincipalId, OPAQUE_ID);
  assert.equal(plan.next.passenger_identity_security.ABC123.authorizedAuthUid, 'victim-auth');
  assert.equal(plan.next.passenger_identity_security.ABC123.loginDeviceBoundAtMs, 101);
});

test('migration replay preserves versioned multi-phone authorization and explicit withdrawals without rotation', () => {
  const security = {
    passengerPrincipalId: OPAQUE_ID, passengerIdentityVersion: 'pax_v2',
    passengerIdentityIssuedAtMs: 100, deviceAuthorizationVersion: 2,
    authorizedAuthUid: 'withdrawn-first-phone',
    authorizedAuthUids: { 'withdrawn-first-phone': false, 'second-phone': true, 'third-phone': true },
    loginDeviceBoundAtMs: 101, loginLocked: false,
  };
  const snapshot = {
    booking_identities: { ABC123: { bookingRef: 'ABC123', email: 'synthetic@example.test', tourId: 'TOUR_1' } },
    passenger_identity_security: { ABC123: structuredClone(security) },
    users: {
      'second-phone': { bookingRef: 'ABC123', stablePassengerId: OPAQUE_ID, identityVersion: 'pax_v2' },
      'third-phone': { bookingRef: 'ABC123', stablePassengerId: OPAQUE_ID, identityVersion: 'pax_v2' },
    },
    chats: { TOUR_1: { messages: { synthetic: { senderId: OPAQUE_ID, text: 'Preserved' } } } },
  };
  const before = structuredClone(snapshot);
  const createId = () => { throw Error('Existing multi-phone principal must never rotate'); };
  const first = buildDatabaseMigration({ snapshot, createId, nowMs: 123 });
  const second = buildDatabaseMigration({ snapshot: first.next, createId, nowMs: 456 });
  assert.deepEqual(first.next.passenger_identity_security.ABC123, security);
  assert.deepEqual(second.next.passenger_identity_security.ABC123, security);
  assert.deepEqual(first.next.chats, snapshot.chats);
  assert.equal(isPassengerDeviceAuthorized(first.next.passenger_identity_security.ABC123, 'withdrawn-first-phone'), false);
  assert.equal(isPassengerDeviceAuthorized(first.next.passenger_identity_security.ABC123, 'second-phone'), true);
  assert.equal(isPassengerDeviceAuthorized(first.next.passenger_identity_security.ABC123, 'third-phone'), true);
  assert.deepEqual(snapshot, before, 'planning cannot mutate its input snapshot');
});

test('versioned migration with no remaining authorized devices never reactivates a retained legacy scalar', () => {
  for (const membership of [undefined, null, {}]) {
    const security = { passengerPrincipalId: OPAQUE_ID, passengerIdentityVersion: 'pax_v2',
      deviceAuthorizationVersion: 2, authorizedAuthUid: 'withdrawn-phone',
      ...(membership !== undefined ? { authorizedAuthUids: membership } : {}) };
    const plan = buildDatabaseMigration({ snapshot: {
      booking_identities: { ABC123: { bookingRef: 'ABC123', email: 'synthetic@example.test' } },
      passenger_identity_security: { ABC123: security },
      users: { first: { bookingRef: 'ABC123' }, second: { bookingRef: 'ABC123' } },
    }, createId: () => { throw Error('Must preserve principal'); } });
    assert.deepEqual(plan.next.passenger_identity_security.ABC123, security);
    assert.equal(isPassengerDeviceAuthorized(plan.next.passenger_identity_security.ABC123, 'withdrawn-phone'), false);
    assert.equal(plan.lockedBookingCount, 0, 'explicit versioned membership is not ambiguous legacy evidence');
  }
});

test('migration rejects unknown or malformed multi-phone authorization before producing a plan', () => {
  const valid = { passengerPrincipalId: OPAQUE_ID, passengerIdentityVersion: 'pax_v2',
    deviceAuthorizationVersion: 2, authorizedAuthUids: { 'synthetic-phone': true } };
  for (const changes of [
    { deviceAuthorizationVersion: 3 }, { deviceAuthorizationVersion: '2' },
    { deviceAuthorizationVersion: null }, { passengerPrincipalId: LEGACY_ID },
    { passengerPrincipalId: ` ${OPAQUE_ID}` }, { passengerIdentityVersion: 'pax_v1' },
    { authorizedAuthUids: [] }, { authorizedAuthUids: 'malformed' },
    { authorizedAuthUids: { 'synthetic-phone': 'true' } },
    { authorizedAuthUids: { 'synthetic-phone': 1 } },
    { authorizedAuthUids: { 'bad/key': true } },
    { authorizedAuthUids: { ['x'.repeat(129)]: true } },
    { authorizedAuthUid: 'bad/key' }, { loginLocked: 'true' },
  ]) {
    const snapshot = { booking_identities: { ABC123: { bookingRef: 'ABC123', email: 'synthetic@example.test' } },
      passenger_identity_security: { ABC123: { ...valid, ...changes } } };
    const before = structuredClone(snapshot);
    assert.throws(() => buildDatabaseMigration({ snapshot,
      createId: () => { throw Error('Must not guess a replacement principal'); } }),
    { code: 'MIGRATION_DEVICE_AUTHORIZATION_INVALID' });
    assert.deepEqual(snapshot, before);
  }
});

test('migration refuses credential-source multi-phone authority instead of copying or silently dropping it', () => {
  const snapshot = { booking_identities: { ABC123: {
    bookingRef: 'ABC123', email: 'synthetic@example.test', passengerPrincipalId: OPAQUE_ID,
    deviceAuthorizationVersion: 2, authorizedAuthUids: { 'synthetic-phone': true },
  } } };
  assert.throws(() => buildDatabaseMigration({ snapshot }), { code: 'MIGRATION_DEVICE_AUTHORIZATION_INVALID' });
});
