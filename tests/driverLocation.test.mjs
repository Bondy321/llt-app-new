import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriverLocationPayload,
  getDriverLocationPresentation,
} from '../utils/driverLocation.js';
import {
  publishDriverLocation,
  withdrawLiveDriverLocation,
  withdrawDriverLocation,
} from '../services/driverLocationService.js';

test('manual driver locations remain actionable pickup points without claiming to be live', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const result = getDriverLocationPresentation({
    latitude: 56.0,
    longitude: -4.5,
    timestamp: now - (24 * 60 * 60 * 1000),
    source: 'manual',
    isSharing: true,
  }, now);

  assert.equal(result.available, true);
  assert.equal(result.actionable, true);
  assert.equal(result.mode, 'pickup');
  assert.equal(result.freshness, 'pickup');
});

test('live driver locations become non-actionable, then disappear when expired', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const record = {
    latitude: 56.0,
    longitude: -4.5,
    source: 'auto',
    isSharing: true,
  };

  assert.equal(getDriverLocationPresentation({ ...record, timestamp: now - 60_000 }, now).freshness, 'live');
  const stale = getDriverLocationPresentation({ ...record, timestamp: now - (15 * 60_000) }, now);
  assert.equal(stale.available, true);
  assert.equal(stale.actionable, false);
  assert.equal(stale.freshness, 'stale');

  const expired = getDriverLocationPresentation({ ...record, timestamp: now - (31 * 60_000) }, now);
  assert.equal(expired.available, false);
  assert.equal(expired.coordinates, null);
});

test('withdrawn, malformed, and far-future driver locations are unavailable', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const base = { latitude: 56, longitude: -4, timestamp: now };
  assert.equal(getDriverLocationPresentation({ ...base, isSharing: false }, now).available, false);
  assert.equal(getDriverLocationPresentation({ ...base, latitude: 999 }, now).available, false);
  assert.equal(getDriverLocationPresentation({ ...base, timestamp: now + (6 * 60_000) }, now).freshness, 'invalid');
});

test('location payload uses a server timestamp and bounded schema', () => {
  const payload = buildDriverLocationPayload({
    latitude: 56.01,
    longitude: -4.02,
    accuracy: 12,
    address: '  Main Street  ',
    updatedBy: ' Driver ',
    source: 'auto',
  });

  assert.deepEqual(payload.timestamp, { '.sv': 'timestamp' });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.mode, 'live');
  assert.equal(payload.isSharing, true);
  assert.equal(payload.address, 'Main Street');
  assert.equal(payload.updatedBy, 'Driver');
});

test('publish and withdraw write only the canonical tour location path', async () => {
  const calls = [];
  const dbInstance = {
    ref(path) {
      calls.push({ path, set: [], remove: 0 });
      const call = calls.at(-1);
      return {
        async set(value) { call.set.push(value); },
        async remove() { call.remove += 1; },
        async transaction(updater) {
          const next = updater({ source: 'auto', mode: 'live' });
          call.transactionValue = next;
          return { committed: next === null };
        },
      };
    },
  };

  const published = await publishDriverLocation({
    tourId: '5112D 8',
    location: { latitude: 56, longitude: -4, accuracy: 5 },
    updatedBy: 'Driver',
    dbInstance,
    now: () => 1234,
  });
  await withdrawDriverLocation({ tourId: '5112D 8', dbInstance });
  const liveWithdrawal = await withdrawLiveDriverLocation({ tourId: '5112D 8', dbInstance });

  assert.equal(published.timestamp, 1234);
  assert.deepEqual(calls.map((call) => call.path), [
    'tours/5112D_8/driverLocation',
    'tours/5112D_8/driverLocation',
    'tours/5112D_8/driverLocation',
  ]);
  assert.equal(calls[0].set.length, 1);
  assert.equal(calls[1].remove, 1);
  assert.equal(liveWithdrawal.removed, true);
  assert.equal(calls[2].transactionValue, null);
});

test('stopping live sharing preserves a fixed manual pickup point', async () => {
  let transactionResult = 'not-run';
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          transactionResult = updater({ source: 'manual', mode: 'pickup' });
          return { committed: false };
        },
      };
    },
  };

  const result = await withdrawLiveDriverLocation({ tourId: 'TOUR_1', dbInstance });
  assert.equal(result.removed, false);
  assert.equal(transactionResult, undefined);
});
