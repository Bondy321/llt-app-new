const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCanonicalIdentity,
  isOpaquePassengerId,
  isRealtimeKeySegment,
  resolveAuthScopedUserId,
  resolveChatStatusActorId,
  resolveRealtimeActorId,
  toRealtimeKeySegment,
} = require('../services/identityService');

test('resolveAuthScopedUserId prefers canonical auth UID over principal identity', () => {
  const canonicalIdentity = getCanonicalIdentity({
    authUser: { uid: 'auth-uid-1' },
    bookingData: {
      id: 'BKG-123',
      stablePassengerId: 'pax_v2_0123456789abcdef0123456789abcdef',
    },
  });

  assert.equal(canonicalIdentity.principalId, 'pax_v2_0123456789abcdef0123456789abcdef');
  assert.equal(resolveAuthScopedUserId({ canonicalIdentity, authUser: { uid: 'fallback-uid' } }), 'auth-uid-1');
});

test('resolveAuthScopedUserId falls back to auth user UID when canonical identity is missing', () => {
  assert.equal(
    resolveAuthScopedUserId({
      canonicalIdentity: null,
      authUser: { uid: 'auth-uid-2' },
    }),
    'auth-uid-2'
  );
});

test('resolveAuthScopedUserId returns null when no authenticated UID is available', () => {
  assert.equal(
    resolveAuthScopedUserId({
      canonicalIdentity: { principalId: 'driver:D-BONDY', principalType: 'driver' },
      authUser: null,
    }),
    null
  );
});

test('toRealtimeKeySegment encodes email-style passenger principals for database paths', () => {
  const stablePassengerId = 'pax_v1:T123659:msandreayoung@yahoo.co.uk';

  assert.equal(isRealtimeKeySegment(stablePassengerId), false);
  assert.equal(
    toRealtimeKeySegment(stablePassengerId),
    'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk'
  );
});

test('resolveRealtimeActorId prefers auth UID and falls back to encoded principal key', () => {
  assert.equal(
    resolveRealtimeActorId({
      authUid: 'firebase-auth-uid',
      principalId: 'pax_v1:T123659:msandreayoung@yahoo.co.uk',
    }),
    'firebase-auth-uid'
  );

  assert.equal(
    resolveRealtimeActorId({
      authUid: null,
      principalId: 'pax_v1:T123659:msandreayoung@yahoo.co.uk',
    }),
    'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk'
  );
});

test('chat status identity uses the exact app-session principal instead of the auth UID', () => {
  const principalId = `pax_v2_${'c'.repeat(32)}`;
  assert.equal(resolveRealtimeActorId({ authUid: 'firebase-auth-uid', principalId }), 'firebase-auth-uid');
  assert.equal(resolveChatStatusActorId({
    sessionScope: { authUid: 'firebase-auth-uid', principalId },
  }), principalId);
  assert.equal(resolveChatStatusActorId({
    sessionScope: { authUid: 'firebase-auth-uid', principalId: 'unsafe/principal' },
  }), null);
});

test('canonical passenger identity accepts only opaque server-issued v2 principals', () => {
  const opaqueId = 'pax_v2_fedcba9876543210fedcba9876543210';
  assert.equal(isOpaquePassengerId(opaqueId), true);
  assert.equal(isOpaquePassengerId('pax_v1:BOOKING:person@example.com'), false);
  assert.equal(getCanonicalIdentity({
    authUser: { uid: 'auth-uid' },
    bookingData: { stablePassengerId: opaqueId },
  }).principalId, opaqueId);
  assert.equal(getCanonicalIdentity({
    authUser: { uid: 'auth-uid' },
    bookingData: { stablePassengerId: 'pax_v1:BOOKING:person@example.com' },
  }).principalId, 'auth-uid');
});
