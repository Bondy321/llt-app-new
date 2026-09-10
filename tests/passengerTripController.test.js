const test = require('node:test');
const assert = require('node:assert/strict');
const { createPassengerTripController } = require('../services/passenger-trip/tripController');
const { createTripCache } = require('../services/passenger-trip/tripCache');
const { seedEnvelope, normalizeEnvelope } = require('../services/passenger-trip/tripBoundary');
const { createTripApi } = require('../services/passenger-trip/tripApi');
const { migrateLegacyTripSeed } = require('../services/passenger-trip/legacyTripSeed');
const scope = { authUid: 'synthetic-uid', principalId: `pax_v2_${'a'.repeat(32)}`,
  bookingRef: 'TEST123', tourId: 'TEST_1', sessionId: `sess_v1_${'b'.repeat(32)}` };
const booking = { id: scope.bookingRef, tourId: scope.tourId, pickupTime: '08:00',
  passengerNames: ['Synthetic Guest'], seatNumbers: ['12'] };
const tour = { id: scope.tourId, name: 'Synthetic Tour', driverPhone: '000000000',
  itinerary: { revision: 1, days: [{ day: 1, content: 'Published before opening itinerary' }] } };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
function harness(options = {}) {
  const disk = options.disk || new Map();
  const writes = [];
  const storage = { getItem: async (key) => disk.get(key) || null,
    setItem: async (key, value) => { writes.push(value); if (options.failSave) throw new Error('DISK'); disk.set(key, value); },
    removeItem: async (key) => disk.delete(key) };
  const timers = new Map(); let timerId = 0;
  const calls = []; let attached = 0; let detached = 0; let signal;
  const cache = createTripCache(storage);
  const controller = createPassengerTripController({ scope, cache,
    seed: seedEnvelope(scope, booking, tour),
    request: (args) => { const d = deferred(); calls.push({ ...args, ...d }); return d.promise; },
    subscribeSignals: (_scope, cb) => { attached += 2; signal = cb; return () => { detached += 2; }; },
    schedule: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    cancel: (id) => timers.delete(id), ...options.controller,
  });
  const drain = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  const response = (call, values = {}, version = 'c') => ({ schemaVersion: 1, scope, checkedAtMs: 1000,
    parts: Object.fromEntries(call.parts.map((name) => [name, { status: 'value', version: version.repeat(64),
      data: values[name] || { booking, tour, itinerary: tour.itinerary }[name] }])) });
  return { controller, cache, disk, writes, calls, response, drain, signal: (...args) => signal(...args),
    counts: () => ({ attached, detached }) };
}

test('shared seed saves itinerary before visit; booking update replaces pickup and offline restart uses committed parts', async () => {
  const h = harness(); await h.controller.ready;
  assert.equal(h.controller.getState().parts.itinerary.persisted, true);
  h.controller.setAvailability(true); h.drain(); await flush();
  h.calls[0].resolve(h.response(h.calls[0])); await flush();
  h.signal('booking', 1); h.signal('booking', 2); h.signal('booking', 3);
  h.drain(); await flush();
  assert.deepEqual(h.calls[1].parts, ['booking']);
  h.calls[1].resolve(h.response(h.calls[1], { booking: { ...booking, pickupTime: '09:10', seatNumbers: ['18'] } }, 'd'));
  await flush();
  assert.equal(h.controller.getState().parts.booking.data.pickupTime, '09:10');
  assert.equal(h.calls.length, 2); assert.deepEqual(h.counts(), { attached: 2, detached: 0 });
  h.controller.stop();
  const restored = harness({ disk: h.disk }); await restored.controller.ready;
  assert.equal(restored.controller.getState().parts.booking.data.pickupTime, '09:10');
  assert.equal(restored.controller.getState().parts.itinerary.data.days[0].content, tour.itinerary.days[0].content);
  assert.equal(restored.controller.getState().parts.itinerary.status, 'saved');
  restored.controller.stop();
});

test('concurrent refreshes coalesce and dirty part arriving during read gets one follow-up', async () => {
  const h = harness(); await h.controller.ready;
  h.controller.setAvailability(true); h.controller.refresh('foreground'); h.controller.refresh('reconnect');
  h.drain(); await flush(); assert.equal(h.calls.length, 1);
  h.signal('itinerary', 1); h.signal('itinerary', 2); h.signal('itinerary', 3);
  h.calls[0].resolve(h.response(h.calls[0])); await flush(); h.drain(); await flush();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].parts, ['itinerary']);
  h.calls[1].resolve(h.response(h.calls[1])); await flush(); h.drain(); await flush();
  assert.equal(h.calls.length, 2); h.controller.stop();
});

test('withdrawal and removed contact replace old values; unavailable retains old check time', async () => {
  const h = harness(); await h.controller.ready;
  h.controller.setAvailability(true); h.drain(); await flush();
  h.calls[0].resolve(h.response(h.calls[0])); await flush();
  const done = h.controller.refresh('manual'); await flush();
  h.calls[1].resolve({ schemaVersion: 1, scope, checkedAtMs: 2000, parts: {
    booking: { status: 'unavailable' }, itinerary: { status: 'absent', version: 'd'.repeat(64) },
    tour: { status: 'value', version: 'e'.repeat(64), data: { id: scope.tourId, name: 'New Tour' } },
  } }); await done;
  const state = h.controller.getState();
  assert.equal(state.parts.itinerary.data, null); assert.equal(state.parts.tour.data.driverPhone, undefined);
  assert.equal(state.parts.booking.checkedAtMs, 1000); assert.equal(state.parts.booking.status, 'error');
  const saved = await h.cache.read(scope); assert.equal(saved.parts.itinerary.data, null);
  assert.equal(saved.parts.tour.data.driverPhone, undefined); h.controller.stop();
});

test('unchanged preserves content reference; saving failure retains remote data without offline claim', async () => {
  const h = harness({ failSave: true }); await h.controller.ready;
  h.controller.setAvailability(true); h.drain(); await flush();
  h.calls[0].resolve(h.response(h.calls[0])); await flush();
  const original = h.controller.getState().parts.booking.data;
  const done = h.controller.refresh('manual', ['booking']); await flush();
  h.calls[1].resolve({ schemaVersion: 1, scope, checkedAtMs: 2000, parts: {
    booking: { status: 'unchanged', version: 'c'.repeat(64) },
  } }); await done;
  const state = h.controller.getState().parts.booking;
  assert.equal(state.data, original); assert.equal(state.checkedAtMs, 2000); assert.equal(state.persisted, false);
  assert.equal(h.disk.size, 0); h.controller.stop();
});

test('late response, delayed hydration and queued cache writes cannot repopulate after purge', async () => {
  const h = harness(); await h.controller.ready;
  h.controller.setAvailability(true); h.drain(); await flush();
  await h.controller.purge();
  h.calls[0].resolve(h.response(h.calls[0])); await flush();
  assert.equal(h.disk.size, 0); assert.deepEqual(h.counts(), { attached: 2, detached: 2 });
  const delay = deferred(); const raw = new Map(); let live = true;
  const cache = createTripCache({ getItem: () => delay.promise,
    setItem: async (key, value) => { await delay.promise; raw.set(key, value); }, removeItem: async (key) => raw.delete(key) });
  const env = seedEnvelope(scope, booking, tour);
  const first = cache.write(scope, env, () => live); await flush();
  const second = cache.write(scope, env, () => live); live = false;
  const purge = cache.purge(scope); delay.resolve(JSON.stringify(env)); await Promise.all([first, second, purge]);
  assert.equal(raw.size, 0);
  const read = deferred();
  const delayed = harness({ controller: { cache: { read: () => read.promise, write: async () => { throw new Error('must not write'); }, purge: async () => {} } } });
  await delayed.controller.purge(); read.resolve(env); await delayed.controller.ready;
  assert.equal(delayed.controller.getState().parts.booking.persisted, false);
});

test('scope mismatches rejected recursively; no identity/operational fields or renewed auth timestamps saved', async () => {
  const h = harness(); await h.controller.ready;
  const raw = JSON.parse(h.writes[0]);
  assert.deepEqual(Object.keys(raw).sort(), ['parts', 'schemaVersion', 'scope']);
  assert.equal(normalizeEnvelope(raw, { ...scope, sessionId: `sess_v1_${'c'.repeat(32)}` }), null);
  h.controller.setAvailability(true); h.drain(); await flush();
  const response = h.response(h.calls[0], { booking: { ...booking, supplier: 'private', email: 'private', passengerNames: ['Updated'] } });
  response.scope = { ...scope, authUid: 'other' }; h.calls[0].resolve(response); await flush();
  assert.deepEqual(h.controller.getState().parts.booking.data.passengerNames, booking.passengerNames);
  assert.ok([...h.disk.keys()].every((key) => key.startsWith('@LLT:passengerTrip:v1:')));
  h.controller.stop();
});

test('API attaches exactly two compact subscriptions and sends no client-selectable booking/tour path', async () => {
  const paths = []; const detached = []; let body;
  const api = createTripApi({ endpoint: () => 'https://synthetic.invalid/endpoint',
    getFirebase: () => ({ auth: { currentUser: { uid: scope.authUid, getIdToken: async () => 'synthetic-token' } },
      realtimeDb: { ref: (path) => ({ on: () => paths.push(path), off: () => detached.push(path) }) } }),
    fetchFn: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; },
  });
  const unsubscribe = api.subscribeSignals(scope, () => {}, () => {});
  await api.request({ scope, parts: ['booking'], versions: {} }); unsubscribe();
  assert.equal(paths.length, 2); assert.deepEqual(paths, detached);
  assert.deepEqual(Object.keys(body).sort(), ['expectedSessionId', 'parts', 'versions']);
});

test('legacy same-owner migration compares published revisions without creating server-check evidence', () => {
  const seed = seedEnvelope(scope, booking, tour);
  const legacy = { tour, booking: { ...booking, stablePassengerId: scope.principalId },
    itinerary: { revision: 5, days: [{ day: 1, content: 'Later published content' }] } };
  const migrated = migrateLegacyTripSeed(scope, seed, legacy);
  assert.equal(migrated.parts.itinerary.data.revision, 5);
  assert.equal(migrated.parts.itinerary.checkedAtMs, null);
  assert.equal(migrateLegacyTripSeed(scope, seed, { ...legacy, booking: { ...legacy.booking, stablePassengerId: 'other' } })
    .parts.itinerary.data.revision, 1);
});

test('offline/background pause detaches subscriptions, bounded retry stops after purge', async () => {
  const h = harness(); await h.controller.ready;
  h.controller.setAvailability(true); h.drain(); await flush();
  h.calls[0].reject(new Error('NETWORK_ERROR')); await flush();
  assert.equal(h.controller.getState().parts.booking.status, 'error');
  h.controller.setAvailability(false); h.drain(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.counts().detached, 2);
  const saved = await h.controller.refresh('manual'); assert.notEqual(saved.parts.booking.status, 'checked');
  h.controller.setAvailability(true, true); h.drain(); await flush();
  assert.equal(h.calls.length, 2); h.calls[1].reject(new Error('NETWORK_ERROR')); await flush();
  await h.controller.purge(); h.drain(); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.disk.size, 0);
});

test('a confirmed invalid session uses lifecycle callback; ordinary service failure never does', async () => {
  const revoked = [];
  const h = harness({ controller: { onInvalidSession: (event) => revoked.push(event) } });
  await h.controller.ready; h.controller.setAvailability(true); h.drain(); await flush();
  h.calls[0].reject(new Error('SERVICE_UNAVAILABLE')); await flush(); assert.equal(revoked.length, 0);
  const done = h.controller.refresh('manual'); await flush();
  h.calls[1].reject(Object.assign(new Error('SESSION_CHANGED'), { invalidSession: true })); await done;
  assert.deepEqual(revoked, [{ reason: 'SESSION_CHANGED' }]);
  assert.equal(h.counts().detached, 2);
});
