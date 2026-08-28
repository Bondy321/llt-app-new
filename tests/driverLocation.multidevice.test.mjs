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
          return buildSnapshot(path);
        },
        async transaction(update) {
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

test('two driver devices own different live leaves and stale disconnect cannot remove the newer device', async () => {
  const db = createRealtimeHarness();
  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.1, longitude: -4.1, accuracy: 8 },
    source: 'auto',
    sessionId: 'live_session_a',
    sessionScope: scope(APP_SESSION_A, 'uid_a'),
    dbInstance: db,
    now: () => 1_000,
  });
  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.2, longitude: -4.2, accuracy: 8 },
    source: 'auto',
    sessionId: 'live_session_b',
    sessionScope: scope(APP_SESSION_B, 'uid_b'),
    dbInstance: db,
    now: () => 2_000,
  });

  const pathA = `driver_location_sessions/${APP_SESSION_A}|live_session_a`;
  const pathB = `driver_location_sessions/${APP_SESSION_B}|live_session_b`;
  assert.ok(db.values.has(pathA));
  assert.ok(db.values.has(pathB));
  await db.disconnect(pathA);
  assert.equal(db.values.has(pathA), false);
  assert.equal(db.values.get(pathB).authUid, 'uid_b');
});

test('live withdrawal compares both app-session and live-sharing ownership', async () => {
  const db = createRealtimeHarness();
  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.2, longitude: -4.2, accuracy: 8 },
    source: 'auto',
    sessionId: 'live_session_b',
    sessionScope: scope(APP_SESSION_B, 'uid_b'),
    dbInstance: db,
    now: () => 2_000,
  });

  const stale = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    appSessionId: APP_SESSION_B,
    dbInstance: db,
    expectedSessionId: 'live_session_a',
  });
  assert.equal(stale.removed, false);
  assert.ok(db.values.has(`driver_location_sessions/${APP_SESSION_B}|live_session_b`));
});

test('manual pickup uses a durable source separate from live disconnect state', async () => {
  const db = createRealtimeHarness();
  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.3, longitude: -4.3 },
    source: 'manual',
    sessionScope: scope(APP_SESSION_A, 'uid_a'),
    dbInstance: db,
    now: () => 3_000,
  });
  assert.ok(db.values.has('driver_location_pickups/TOUR_1'));
  assert.equal([...db.values.keys()].some((path) => path.startsWith('driver_location_sessions/')), false);
});
