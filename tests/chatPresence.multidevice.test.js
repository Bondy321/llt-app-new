const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setOnlinePresence,
  setTypingStatus,
} = require('../services/chatService');

function createDb() {
  const values = new Map();
  const disconnects = new Map();
  return {
    values,
    async disconnect(path) { await disconnects.get(path)?.(); },
    ref(path) {
      return {
        async set(value) { values.set(path, structuredClone(value)); },
        async remove() { values.delete(path); },
        async update(value) { values.set(path, { ...(values.get(path) || {}), ...structuredClone(value) }); },
        async once() {
          const value = values.get(path);
          return { exists: () => value != null, val: () => structuredClone(value ?? null) };
        },
        onDisconnect() {
          return {
            async remove() { disconnects.set(path, async () => values.delete(path)); },
            async update(value) { disconnects.set(path, async () => values.set(path, structuredClone(value))); },
            async cancel() { disconnects.delete(path); },
          };
        },
      };
    },
  };
}

const PASSENGER_PRINCIPAL = `pax_v2_${'c'.repeat(32)}`;

const options = (sessionId, authUid) => ({
  scope: 'group',
  sessionScope: {
    authUid,
    sessionId,
    principalId: PASSENGER_PRINCIPAL,
    role: 'passenger',
    tourId: 'TOUR_1',
  },
  now: () => 1_000,
});

const APP_SESSION_A = 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APP_SESSION_B = 'sess_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('presence disconnect and typing clear remove only one device session leaf', async () => {
  const db = createDb();
  for (const [sessionId, authUid] of [[APP_SESSION_A, 'uid_a'], [APP_SESSION_B, 'uid_b']]) {
    assert.notEqual(authUid, PASSENGER_PRINCIPAL);
    assert.equal((await setOnlinePresence('TOUR_1', PASSENGER_PRINCIPAL, 'Alex', true, false, db, options(sessionId, authUid))).success, true);
    assert.equal((await setTypingStatus('TOUR_1', PASSENGER_PRINCIPAL, 'Alex', true, false, db, options(sessionId, authUid))).success, true);
  }

  const presenceA = `chat_presence_sessions/group/${APP_SESSION_A}`;
  const presenceB = `chat_presence_sessions/group/${APP_SESSION_B}`;
  const typingA = `chat_typing_sessions/group/${APP_SESSION_A}`;
  const typingB = `chat_typing_sessions/group/${APP_SESSION_B}`;
  await db.disconnect(presenceA);
  await setTypingStatus('TOUR_1', PASSENGER_PRINCIPAL, 'Alex', false, false, db, options(APP_SESSION_A, 'uid_a'));

  assert.equal(db.values.has(presenceA), false);
  assert.equal(db.values.get(presenceB).authUid, 'uid_b');
  assert.equal(db.values.has(typingA), false);
  assert.equal(db.values.get(typingB).appSessionId, APP_SESSION_B);
});

test('chat status rejects the auth UID when it differs from the app-session principal', async () => {
  const db = createDb();
  const result = await setOnlinePresence(
    'TOUR_1',
    'uid_a',
    'Alex',
    true,
    false,
    db,
    options(APP_SESSION_A, 'uid_a'),
  );
  assert.equal(result.success, false);
  assert.equal(db.values.size, 0);
});
