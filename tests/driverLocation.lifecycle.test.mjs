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

test('automatic publication cannot bypass explicit native tracking, even with valid legacy ownership', async () => {
  const h = harness();
  await assert.rejects(publish(h.db), { code: 'EXPLICIT_TRACKING_REQUIRED' });
  assert.deepEqual(h.events, []);
});

test('failed deletion retains disconnect cleanup and the exact identity for retry', async () => {
  let failures = 1;
  const h = harness({ remove: async () => { if (failures-- > 0) throw new Error('delete rejected'); } });
  h.values.set(sourcePath(session.sessionId), { latitude: 56 });
  h.armed.add(sourcePath(session.sessionId));
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
  h.values.set(sourcePath(session.sessionId), { latitude: 56 });
  h.armed.add(sourcePath(session.sessionId));
  const result = await withdraw(h.db);
  assert.equal(result.withdrawalAcknowledged, true);
  assert.equal(result.disconnectCancelled, false);
  assert.equal(h.values.size, 0);
});

test('a delayed old cancellation cannot disarm a newer live session', { timeout: 2000 }, async () => {
  const entered = deferred(); const release = deferred();
  const h = harness({ cancel: async path => { if (path === sourcePath(session.sessionId)) { entered.resolve(); await release.promise; } } });
  h.values.set(sourcePath(session.sessionId), { latitude: 56 });
  h.armed.add(sourcePath(session.sessionId));
  const stopped = withdraw(h.db);
  await entered.promise;
  h.values.set(sourcePath('live_session_b'), { latitude: 57 });
  h.armed.add(sourcePath('live_session_b'));
  release.resolve(); await stopped;
  assert.equal(h.armed.has(sourcePath('live_session_b')), true);
  assert.equal(h.values.has(sourcePath('live_session_b')), true);
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
