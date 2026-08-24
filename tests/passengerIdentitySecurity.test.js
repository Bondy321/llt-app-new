'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
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

test('device-bound login credential prevents the exposed booking pair being replayed on another auth identity', async () => {
  let stored = { passengerPrincipalId: OPAQUE_ID, authorizedAuthUid: 'victim-auth' };
  const securityRef = {
    async transaction(updater) {
      const next = updater(stored);
      if (next === undefined) return { committed: false, snapshot: { val: () => stored } };
      stored = next;
      return { committed: true, snapshot: { val: () => stored } };
    },
  };
  await assert.rejects(
    () => authorizePassengerLoginDevice({
      securityRef, authUid: 'attacker-auth',
    }),
    (error) => error.code === 'REAUTHORIZE_REQUIRED',
  );
  assert.equal(stored.authorizedAuthUid, 'victim-auth');
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
