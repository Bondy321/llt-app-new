const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChatStatusProjection,
} = require('../functions/lib/chatPresenceProjection');

const leaf = (appSessionId, timestamp, expiresAtMs = 10_000) => ({
  schemaVersion: 2,
  authUid: `uid_${appSessionId}`,
  appSessionId,
  actorKey: 'passenger-one',
  principalId: 'passenger-one',
  principalType: 'passenger',
  tourId: 'TOUR_1',
  scope: 'group',
  name: 'Alex',
  isDriver: false,
  timestamp,
  expiresAtMs,
});

test('presence and typing aggregation remain active while any valid device leaf exists', () => {
  const a = leaf('app_a', 100);
  const b = leaf('app_b', 200);
  const presence = buildChatStatusProjection({ records: [a, b], statusType: 'presence', nowMs: 300 });
  const typing = buildChatStatusProjection({ records: [a, b], statusType: 'typing', nowMs: 300 });
  assert.equal(presence.online, true);
  assert.equal(presence.lastSeen, 200);
  assert.equal(typing.timestamp, 200);

  const afterAEnds = buildChatStatusProjection({ records: [b], statusType: 'presence', nowMs: 300 });
  assert.equal(afterAEnds.online, true);
});

test('expired leaves cannot keep aggregate presence or typing active', () => {
  const expired = leaf('app_a', 100, 200);
  assert.equal(buildChatStatusProjection({ records: [expired], statusType: 'typing', nowMs: 300 }), null);
  assert.equal(buildChatStatusProjection({ records: [expired], statusType: 'presence', nowMs: 300 }), null);
});
