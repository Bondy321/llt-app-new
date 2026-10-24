import test from 'node:test';
import assert from 'node:assert/strict';

import {
  publishDriverLocation,
  withdrawLiveDriverLocation,
} from '../services/driverLocationService.js';

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function createRealtimeHarness() {
  const values = new Map();
  const disconnects = new Map();
  const writes = [];
  const buildSnapshot = (path) => ({
    exists: () => values.has(path),
    val: () => clone(values.get(path) ?? null),
  });
  return {
    values,
    writes,
    async disconnect(path) {
      await disconnects.get(path)?.();
    },
    ref(path) {
      return {
        async set(value) {
          writes.push({ type: 'set', path, value: clone(value) });
          values.set(path, clone(value));
        },
        async remove() {
          writes.push({ type: 'remove', path });
          values.delete(path);
        },
        async once() {
          if (path.startsWith('driver_location_sessions/')) throw new Error('private read denied');
          return buildSnapshot(path);
        },
        async transaction(update) {
          if (path.startsWith('driver_location_sessions/')) throw new Error('private transaction denied');
          const current = clone(values.get(path) ?? null);
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: buildSnapshot(path) };
          if (next === null) values.delete(path);
          else values.set(path, clone(next));
          writes.push({ type: 'transaction', path, value: clone(next) });
          return { committed: true, snapshot: buildSnapshot(path) };
        },
        onDisconnect() {
          return {
            async remove() {
              disconnects.set(path, async () => {
                values.delete(path);
                writes.push({ type: 'disconnect-remove', path });
              });
            },
            async cancel() {
              disconnects.delete(path);
            },
          };
        },
      };
    },
  };
}

const scope = (sessionId, authUid) => ({
  authUid,
  sessionId,
  principalId: 'D-ONE',
  role: 'driver',
  tourId: 'TOUR_1',
});

const APP_SESSION_A = 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APP_SESSION_B = 'sess_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('withdrawal targets the exact retired session and leaves the other handset untouched', async () => {
  const db = createRealtimeHarness();
  const pathA = `driver_location_sessions/${APP_SESSION_A}|live_session_a`;
  const pathB = `driver_location_sessions/${APP_SESSION_B}|live_session_b`;
  db.values.set(pathA, { authUid: 'uid_a' }); db.values.set(pathB, { authUid: 'uid_b' });
  const result = await withdrawLiveDriverLocation({ tourId: 'TOUR_1', appSessionId: APP_SESSION_A,
    dbInstance: db, expectedSessionId: 'live_session_a' });
  assert.equal(result.withdrawalAcknowledged, true);
  assert.equal(db.values.has(pathA), false);
  assert.equal(db.values.get(pathB).authUid, 'uid_b');
  await withdrawLiveDriverLocation({ tourId: 'TOUR_1', appSessionId: APP_SESSION_B,
    dbInstance: db, expectedSessionId: 'live_session_a' });
  assert.equal(db.values.has(pathB), true);
});

test('manual pickup uses a durable source separate from live disconnect state', async () => {
  const db = createRealtimeHarness();
  const mutations = [];
  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.3, longitude: -4.3 },
    source: 'manual',
    sessionScope: scope(APP_SESSION_A, 'uid_a'),
    dbInstance: db,
    now: () => 3_000,
    pickupMutation: async (request) => {
      mutations.push(request);
      return {
        success: true,
        pickup: {
          schemaVersion: 1,
          isSharing: true,
          source: 'manual',
          mode: 'pickup',
          driverId: 'D-ONE',
          tourId: 'TOUR_1',
          assignmentRevision: 7,
          latitude: 56.3,
          longitude: -4.3,
          timestamp: 3_000,
          publishedAtMs: 3_000,
          expiresAtMs: 4_000,
        },
      };
    },
  });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].operation, 'publish');
  assert.equal(mutations[0].sessionScope.sessionId, APP_SESSION_A);
  assert.equal(Object.hasOwn(mutations[0], 'dbInstance'), false);
  assert.equal([...db.values.keys()].some((path) => path.startsWith('driver_location_sessions/')), false);
});
