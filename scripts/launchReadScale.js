'use strict';
// Production read/authority functions, synthetic in-process indexed adapter.
// This measures bounded application work, not Auth-provider or cloud throughput.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-read-scale' });
const { passengerAuthorityUpdates, passengerIdFor, sessionIdFor } = require('../tests/firebaseRules/sessionFixtures');
const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
const { loadPassengerLoginContext } = require('../functions/src/domains/passenger-auth/passengerLoginWorkflow');
const { readPassengerTripSnapshot } = require('../functions/src/domains/passenger-trip/passengerTripSnapshot');
const { buildTourManifestPayload } = require('../functions/src/domains/manifests/manifestDomain');
const { readGroupMediaRecords } = require('../functions/src/domains/media/mediaAccess');
const { ensureNoActiveAccountDeletion, ensureNoActivePassengerAccountDeletion } = require('../functions/src/domains/account-deletion/public');
const { parseDateOnly } = require('../functions/lib/tourDateIndex');
const forbidden = () => { throw new Error('LIVE_NETWORK_FORBIDDEN'); };
global.fetch = forbidden;
require('node:http').request = forbidden;
require('node:https').request = forbidden;
require('node:net').Socket.prototype.connect = forbidden;
const nowMs = Date.UTC(2026, 9, 24, 12);
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] || 0;
const set = (root, path, value) => {
  const keys = path.split('/'); let item = root;
  for (const key of keys.slice(0, -1)) item = item[key] ||= {};
  item[keys.at(-1)] = value;
};
const get = (root, path) => path.split('/').reduce((item, key) => item?.[key], root) ?? null;

async function run({ name, population, requests, concurrency }) {
  const data = {}; const bookingIndex = new Map();
  for (let index = 0; index < population; index += 1) {
    const uid = `synthetic_${index}`; const tourId = `TOUR_${Math.floor(index / 75)}`;
    const bookingRef = `BOOK_${index}`;
    if (!bookingIndex.has(tourId)) {
      bookingIndex.set(tourId, {});
      set(data, `tours/${tourId}`, { name: 'Synthetic tour', tourCode: tourId, startDate: '01/11/2026',
        endDate: '02/11/2026', isActive: true, currentParticipants: 75, maxParticipants: 75,
        driverAssignmentRevision: 1, itinerary: { title: 'Synthetic', days: [{ day: 1, title: 'Arrival', content: 'Example' }] } });
    }
    for (const [path, value] of Object.entries(passengerAuthorityUpdates({ uid, tourId, bookingRef, nowMs }))) set(data, path, value);
    set(data, `passenger_identity_security/${bookingRef}/passengerPrincipalId`, passengerIdFor(uid));
    set(data, `passenger_identity_security/${bookingRef}/passengerIdentityVersion`, 'pax_v2');
    const booking = { tourId, tourCode: tourId, passengerNames: ['Synthetic Passenger'], seatNumbers: [index % 75 + 1], loginEligible: true };
    set(data, `bookings/${bookingRef}`, booking); bookingIndex.get(tourId)[bookingRef] = booking;
    set(data, `booking_identities/${bookingRef}`, { bookingRef, tourId, email: 'synthetic@example.invalid' });
    set(data, `group_tour_photos/${tourId}/photo_${index % 75}`, { userId: passengerIdFor(uid), storagePath: `group_tour_photos/${tourId}/synthetic.jpg` });
  }
  const metrics = { reads: 0, indexedQueries: 0, readBytes: 0, maxReadBytes: 0, maxQueryRecords: 0, errors: 0, peakRssBytes: process.memoryUsage().rss };
  const db = { ref(path) {
    let ordered; let equality;
    const ref = { orderByChild(key) { ordered = key; return ref; }, equalTo(value) { equality = value; return ref; },
      async once() {
        assert.ok(path.includes('/') || path === 'bookings' && ordered === 'tourId' && typeof equality === 'string', `Unbounded read: ${path}`);
        const value = ordered ? bookingIndex.get(equality) || {} : get(data, path);
        if (ordered) { assert.equal(path, 'bookings'); metrics.indexedQueries += 1; metrics.maxQueryRecords = Math.max(metrics.maxQueryRecords, Object.keys(value).length); }
        const size = bytes(value); metrics.reads += 1; metrics.readBytes += size; metrics.maxReadBytes = Math.max(metrics.maxReadBytes, size);
        return { val: () => value, exists: () => value !== null };
      } };
    return ref;
  } };
  const timings = []; let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < requests) {
      const index = next++; const uid = `synthetic_${index % 150}`; const tourId = `TOUR_${Math.floor((index % 150) / 75)}`;
      const start = performance.now();
      try {
        const login = await loadPassengerLoginContext({ database: db, bookingRef: `BOOK_${index % 150}`,
          email: 'synthetic@example.invalid', networkDimension: 'synthetic' });
        assert.equal(login.ok, true);
        const access = await verifyActiveAppSession({ db, authUid: uid, expectedRole: 'passenger', expectedSessionId: sessionIdFor(uid), nowMs });
        assert.equal(access.allowed, true, access.reason);
        const snapshot = await readPassengerTripSnapshot({ db, authUid: uid, access, nowMs, parseDateOnly,
          request: { parts: ['booking', 'tour', 'itinerary'], versions: {} }, ensureNoActiveAccountDeletion, ensureNoActivePassengerAccountDeletion });
        assert.equal(snapshot.parts.booking.status, 'value');
        // Authorized manifest/media data-read kernels; HTTP/rules admission is
        // separately tested. This is not a passenger manifest permission grant.
        if (index % 10 === 0) assert.equal((await buildTourManifestPayload({ db, tourId })).bookings.length, 75);
        if (index % 5 === 0) assert.equal(Object.keys(await readGroupMediaRecords({ db, tourId, photoIds: Array.from({ length: 20 }, (_, id) => `photo_${id}`) })).length, 20);
      } catch (error) { metrics.errors += 1; throw error; }
      timings.push(performance.now() - start);
      metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
    }
  }));
  return { name, population, requests, concurrency, elapsedMs: performance.now() - started, ...metrics,
    readsPerJourney: metrics.reads / requests, bytesPerJourney: metrics.readBytes / requests,
    latencyMs: { p50: percentile(timings, .5), p95: percentile(timings, .95), p99: percentile(timings, .99) } };
}

(async () => {
  const targets = { p95LocalMs: 1000, maxReadsPerJourney: 100, maxQueryRecords: 75, peakRssBytes: 1024 ** 3, errors: 0 };
  const results = [];
  for (const workload of [
    { name: 'small-baseline', population: 150, requests: 200, concurrency: 10 },
    { name: 'normal', population: 60000, requests: 200, concurrency: 10 },
    { name: 'launch-burst', population: 60000, requests: 500, concurrency: 50 },
    { name: 'reconnect-storm', population: 60000, requests: 1000, concurrency: 100 },
  ]) results.push(await run(workload));
  for (const result of results) {
    assert.equal(result.errors, 0); assert.ok(result.latencyMs.p95 < targets.p95LocalMs);
    assert.ok(result.readsPerJourney <= targets.maxReadsPerJourney);
    assert.ok(result.maxQueryRecords <= targets.maxQueryRecords); assert.ok(result.peakRssBytes < targets.peakRssBytes);
  }
  assert.equal(results[0].readsPerJourney, results[1].readsPerJourney);
  assert.equal(results[0].bytesPerJourney, results[1].bytesPerJourney);
  const output = { targets, results, limitations: 'Synthetic indexed adapter exercises production credential/source lookup and current-session reads, not Auth token issuance, login publication, distributed quota contention, TLS, storage signing, cloud contention or billed bytes. Arrival/concurrency assumptions are test inputs, not a business forecast. Real deployed p95 and capacity require isolated cloud verification.' };
  const destination = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (destination) fs.writeFileSync(destination, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
