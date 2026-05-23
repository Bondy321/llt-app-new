const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCanonicalIdentity,
  isRealtimeKeySegment,
  resolveAuthScopedUserId,
  resolveRealtimeActorId,
  toRealtimeKeySegment,
} = require('../services/identityService');

test('resolveAuthScopedUserId prefers canonical auth UID over principal identity', () => {
  const canonicalIdentity = getCanonicalIdentity({
    authUser: { uid: 'auth-uid-1' },
    bookingData: {
      id: 'BKG-123',
      stablePassengerId: 'stable-passenger-1',
    },
  });

  assert.equal(canonicalIdentity.principalId, 'stable-passenger-1');
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
