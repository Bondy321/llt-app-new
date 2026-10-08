import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDriverLocation, withdrawLiveDriverLocation } from '../services/driverLocationService.js';
import { buildDriverLocationSourcePayload, normalizeDriverCoordinates } from '../utils/driverLocation.js';
import { withdrawDriverLiveLocationSession, withdrawPendingDriverLiveLocations } from '../services/driver-home/driverLiveLocationWithdrawal.js';

const appSessionId = `sess_v1_${'a'.repeat(32)}`;
const scope = { sessionId: appSessionId, authUid: 'driver_a', role: 'driver', principalId: 'driver:D-ONE', tourId: 'TOUR_1' };
const session = { appSessionId, sessionId: 'live_session_a', tourId: 'TOUR_1' };
const sourcePath = id => `driver_location_sessions/${appSessionId}|${id}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(hooks = {}) {
  const values = new Map();
  const armed = new Set();
  const events = [];
  const db = { ref(path) {
    if (path === '.info/serverTimeOffset') return { async once() {
      if (hooks.offsetUnavailable) throw new Error('metadata unavailable');
      return { val: () => hooks.offset ?? 0 };
    } };
    return {
      async once() { throw new Error('private reads are denied'); },
      async transaction() { throw new Error('private transactions are denied'); },
      async set(value) { events.push(['set-start', path]); await hooks.set?.(path, value); values.set(path, value); events.push(['set-ack', path]); },
      async remove() { events.push(['remove-start', path]); await hooks.remove?.(path); values.delete(path); events.push(['remove-ack', path]); },
      onDisconnect() { return {
        async remove() { events.push(['arm-start', path]); await hooks.arm?.(path); armed.add(path); events.push(['arm-ack', path]); },
        async cancel() { events.push(['cancel-start', path]); await hooks.cancel?.(path); armed.delete(path); events.push(['cancel-ack', path]); },
      }; },
    };
  } };
  return { db, values, armed, events };
}
const publish = (db, extra = {}) => publishDriverLocation({ tourId: 'TOUR_1',
  location: { latitude: 56, longitude: -4, accuracy: 8 }, source: 'auto',
  sessionId: session.sessionId, sessionScope: scope, dbInstance: db, now: () => 2_000, ...extra });
const withdraw = db => withdrawLiveDriverLocation({ tourId: 'TOUR_1', appSessionId,
  expectedSessionId: session.sessionId, dbInstance: db });

test('stop during disconnect registration prevents a late set and waits for acknowledged absence', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred();
  const h = harness({ arm: async () => { entered.resolve(); await release.promise; } });
  const publishing = publish(h.db);
  await entered.promise;
  let stopped = false;
  const stopping = withdraw(h.db).then(result => { stopped = true; return result; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  const result = await publishing;
  assert.equal(result.skipped, true);
  assert.equal((await stopping).withdrawalAcknowledged, true);
  assert.equal(h.events.some(([event]) => event === 'set-start'), false);
  assert.equal(h.values.size, 0);
  assert.equal(h.armed.size, 0);
});

test('stop during an in-flight set cannot acknowledge before that publication is removed', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred();
  const h = harness({ set: async () => { entered.resolve(); await release.promise; } });
  const publishing = publish(h.db);
  await entered.promise;
  let stopped = false;
  const stopping = withdraw(h.db).then(result => { stopped = true; return result; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  assert.equal((await publishing).skipped, true);
  assert.equal((await stopping).withdrawalAcknowledged, true);
  assert.equal(h.values.size, 0);
  assert.ok(h.events.findIndex(([event]) => event === 'set-ack') < h.events.findIndex(([event]) => event === 'remove-start'));
});

test('queued earlier publications are fenced by stop, but independent live sessions keep working', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred();
  const h = harness({ arm: async path => { if (path === sourcePath(session.sessionId)) { entered.resolve(); await release.promise; } } });
  const first = publish(h.db);
  await entered.promise;
  const queued = publish(h.db);
  const stopped = withdraw(h.db);
  const fresh = await publish(h.db, { sessionId: 'live_session_b' });
  assert.equal(fresh.success, true);
  release.resolve();
  assert.equal((await first).skipped, true);
  assert.equal((await queued).skipped, true);
  await stopped;
  assert.equal(h.values.has(sourcePath(session.sessionId)), false);
  assert.equal(h.values.has(sourcePath('live_session_b')), true);
});

test('a failed update preserves the previous accepted point and does not poison later work', async () => {
  let rejectSet = false;
  const h = harness({ set: async () => { if (rejectSet) throw new Error('write rejected'); } });
  await publish(h.db);
  const previous = h.values.get(sourcePath(session.sessionId));
  rejectSet = true;
  await assert.rejects(publish(h.db), /write rejected/);
  assert.equal(h.values.get(sourcePath(session.sessionId)), previous);
  assert.equal(h.armed.has(sourcePath(session.sessionId)), true);
  rejectSet = false;
  assert.equal((await publish(h.db)).publicationAcknowledged, true);
});

test('failed deletion retains disconnect cleanup and the exact identity for retry', async () => {
  let failures = 1;
  const h = harness({ remove: async () => { if (failures-- > 0) throw new Error('delete rejected'); } });
  await publish(h.db);
  const pending = new Map();
  await assert.rejects(withdrawDriverLiveLocationSession({ session, pending, dbInstance: h.db }), /delete rejected/);
  assert.equal(pending.size, 1);
  assert.equal(h.armed.has(sourcePath(session.sessionId)), true);
  assert.equal(h.events.some(([event]) => event === 'cancel-start'), false);
  await withdrawPendingDriverLiveLocations({ pending, dbInstance: h.db });
  assert.equal(pending.size, 0);
  assert.equal(h.values.size, 0);
  assert.equal(h.armed.size, 0);
});

test('disconnect cancellation failure cannot turn acknowledged deletion into a false failure', async () => {
  const h = harness({ cancel: async () => { throw new Error('cancel rejected'); } });
  await publish(h.db);
  const result = await withdraw(h.db);
  assert.equal(result.withdrawalAcknowledged, true);
  assert.equal(result.disconnectCancelled, false);
  assert.equal(h.values.size, 0);
});

test('a delayed old cancellation cannot disarm a newer live session', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred();
  const h = harness({ cancel: async path => { if (path === sourcePath(session.sessionId)) { entered.resolve(); await release.promise; } } });
  await publish(h.db);
  const stopped = withdraw(h.db);
  await entered.promise;
  await publish(h.db, { sessionId: 'live_session_b' });
  release.resolve(); await stopped;
  assert.equal(h.armed.has(sourcePath('live_session_b')), true);
  assert.equal(h.values.has(sourcePath('live_session_b')), true);
});

test('lease time is refreshed after pending disconnect work and uses readable server-clock metadata', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred(); let clock = 1_000;
  const h = harness({ offset: 30_000, arm: async () => { entered.resolve(); await release.promise; } });
  const publishing = publish(h.db, { now: () => clock });
  await entered.promise; clock = 900_000; release.resolve();
  const result = await publishing;
  assert.equal(result.timestamp, 930_000);
  assert.equal(result.timestampSource, 'server_estimate');
  assert.equal(h.values.get(sourcePath(session.sessionId)).cleanupAtMs, 930_000 + 30 * 60 * 1000);
});

test('clock metadata failure remains explicit and never reads the private source', async () => {
  const h = harness({ offsetUnavailable: true });
  const result = await publish(h.db);
  assert.equal(result.timestamp, 2_000);
  assert.equal(result.timestampSource, 'client_estimate');
  assert.equal(result.storedLocation, null);
});

test('arming failure prevents publication and existing queued errors do not hide failure', async () => {
  const h = harness({ arm: async () => { throw new Error('cleanup unavailable'); } });
  await assert.rejects(publish(h.db), /cleanup unavailable/);
  assert.equal(h.values.size, 0);
  assert.equal(h.events.some(([event]) => event === 'set-start'), false);
});

test('malformed identities and conflicting scopes fail before any remote operation', async () => {
  for (const extra of [{ sessionId: 'bad/path' }, { appSessionId: `sess_v1_${'b'.repeat(32)}` },
    { authUid: 'other_uid' }, { driverId: 'D-OTHER' }, { tourId: 'OTHER_TOUR' }]) {
    const h = harness();
    await assert.rejects(publish(h.db, extra));
    assert.equal(h.events.length, 0);
  }
});

test('missing or boolean GPS values cannot become a zero-coordinate or perfect-accuracy publication', () => {
  for (const value of [null, undefined, false, true, '', ' ', [], {}]) {
    assert.equal(normalizeDriverCoordinates({ latitude: value, longitude: -4 }), null);
    assert.throws(() => buildDriverLocationSourcePayload({ latitude: 56, longitude: -4,
      accuracy: value, source: 'auto', liveSharingSessionId: session.sessionId,
      authUid: scope.authUid, appSessionId, driverId: 'D-ONE', tourId: 'TOUR_1' }), /accuracy/);
  }
  assert.deepEqual(normalizeDriverCoordinates({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
});

test('withdrawal with no active session is safe and unacknowledged removal stays retryable', async () => {
  const pending = new Map();
  assert.equal((await withdrawDriverLiveLocationSession({ session: null, pending })).reason, 'NO_ACTIVE_LIVE_SESSION');
  await assert.rejects(withdrawDriverLiveLocationSession({ session, pending,
    withdraw: async () => ({ success: true, removed: false }) }), /not acknowledged/);
  assert.equal(pending.size, 1);
});
