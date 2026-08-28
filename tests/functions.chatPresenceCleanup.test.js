'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanupExpiredChatStatusSessions,
} = require('../functions/lib/chatPresenceProjection');

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function createDatabase(initialState, beforeTransaction = null) {
  const state = structuredClone(initialState);
  const parts = (value = '') => value.split('/').filter(Boolean);
  const read = (target = '') => parts(target).reduce((node, key) => node?.[key], state);
  const write = (target, value) => {
    const keys = parts(target);
    let cursor = state;
    for (const key of keys.slice(0, -1)) {
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    }
    if (value === null) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = clone(value);
  };
  const snapshot = (value) => ({ val: () => clone(value ?? null), exists: () => value != null });
  return {
    state,
    ref(target = '') {
      const query = { endAt: Infinity, limit: Infinity };
      const ref = {
        orderByChild() { return ref; },
        endAt(value) { query.endAt = value; return ref; },
        limitToFirst(value) { query.limit = value; return ref; },
        async get() {
          const value = read(target);
          if (!value || typeof value !== 'object') return snapshot(value);
          return snapshot(Object.fromEntries(Object.entries(value)
            .filter(([, record]) => Number(record?.expiresAtMs) <= query.endAt)
            .slice(0, query.limit)));
        },
        async transaction(update) {
          await beforeTransaction?.({ target, state, write });
          const current = clone(read(target) ?? null);
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(target, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
      return ref;
    },
  };
}

const status = (expiresAtMs, timestamp = 100) => ({
  schemaVersion: 2,
  scope: 'group',
  tourId: 'TOUR_1',
  actorKey: 'driver%3AD-ONE',
  tourActorKey: 'TOUR_1|driver%3AD-ONE',
  appSessionId: 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authUid: 'uid-a',
  principalId: 'driver:D-ONE',
  principalType: 'driver',
  isDriver: true,
  name: 'Driver',
  timestamp,
  expiresAtMs,
});

test('expired per-session chat status is compare-deleted and its actor is reconciled', async () => {
  const database = createDatabase({
    chat_presence_sessions: { group: { sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: status(200) } },
  });
  const reconciled = [];
  const result = await cleanupExpiredChatStatusSessions({
    database,
    nowMs: 300,
    reconcileActor: async (actor) => reconciled.push(actor),
  });
  assert.equal(result.removed, 1);
  assert.equal(database.state.chat_presence_sessions.group.sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, undefined);
  assert.deepEqual(reconciled.map(({ scope, tourId, actorKey }) => ({ scope, tourId, actorKey })), [{
    scope: 'group', tourId: 'TOUR_1', actorKey: 'driver%3AD-ONE',
  }]);
});

test('scheduled cleanup cannot remove a leaf refreshed after the candidate query', async () => {
  let refreshed = false;
  const sessionId = 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const database = createDatabase({
    chat_typing_sessions: { group: { [sessionId]: status(200) } },
  }, async ({ target, write }) => {
    if (!refreshed && target === `chat_typing_sessions/group/${sessionId}`) {
      refreshed = true;
      write(target, status(1_000, 400));
    }
  });
  const result = await cleanupExpiredChatStatusSessions({
    database,
    nowMs: 300,
    reconcileActor: async () => {},
  });
  assert.equal(result.removed, 0);
  assert.equal(database.state.chat_typing_sessions.group[sessionId].expiresAtMs, 1_000);
});

test('a saturated branch can use the whole cleanup capacity and reports only real remaining work', async () => {
  const records = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const appSessionId = `sess_v1_${index.toString(16).padStart(32, '0')}`;
    return [appSessionId, { ...status(200, 100 + index), appSessionId }];
  }));
  const database = createDatabase({ chat_presence_sessions: { group: records } });

  const first = await cleanupExpiredChatStatusSessions({
    database,
    nowMs: 300,
    limit: 20,
    reconcileActor: async () => {},
  });
  assert.equal(first.scanned, 20);
  assert.equal(first.removed, 20);
  assert.equal(first.hasMore, true);

  const second = await cleanupExpiredChatStatusSessions({
    database,
    nowMs: 300,
    limit: 20,
    reconcileActor: async () => {},
  });
  assert.equal(second.scanned, 10);
  assert.equal(second.removed, 10);
  assert.equal(second.hasMore, false);
});
