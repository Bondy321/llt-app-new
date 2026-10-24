'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A loopback RTDB emulator is required for mobile paging acceptance');
}
const firebasePath = require.resolve('../firebase');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
  exports: { realtimeDbModular: {}, auth: {} } };
const { fetchTourPhotosPage, fetchPrivatePhotosPage } = require('../services/photo/photoFetchService');
const { createAppSessionService } = require('../services/appSessionService');
let env;
let databaseURL;
test.before(async () => {
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  const projectId = 'demo-llt-mobile-media';
  databaseURL = `http://${host}:${port}/?ns=${projectId}`;
  env = await initializeTestEnvironment({ projectId, database: { host, port: Number(port),
    rules: JSON.stringify({ rules: { '.read': true, '.write': true,
      group_tour_photos: { '$tour': { '.indexOn': 'timestamp' } },
      private_tour_photos: { '$tour': { '$owner': { '.indexOn': 'timestamp' } } } } }) } });
});
test.after(async () => env?.cleanup());

for (const visibility of ['group', 'private']) {
  for (const deletedCursor of [false, true]) {
    test(`actual SDK ${visibility} gallery reaches 95 equal-timestamp records, deleted cursor=${deletedCursor}`, async () => {
      await env.clearDatabase();
      const writer = env.unauthenticatedContext().database(databaseURL);
      const reader = env.unauthenticatedContext().database(databaseURL)._delegate;
      const root = visibility === 'group' ? 'group_tour_photos/TOUR' : 'private_tour_photos/TOUR/OWNER';
      const records = Object.fromEntries(Array.from({ length: 95 }, (_, index) => [`p${String(index).padStart(3, '0')}`,
        { timestamp: 1000 + Math.floor(index / 10), caption: `Synthetic ${index}` }]));
      await writer.ref(root).set(records);
      const fetchPage = visibility === 'group' ? fetchTourPhotosPage : fetchPrivatePhotosPage;
      const options = { realtimeDbInstance: reader,
        resolveGroupPhotoMediaFn: async ({ photos }) => photos,
        resolvePrivatePhotoMediaFn: async ({ photos }) => photos };
      let cursor = null;
      const ids = [];
      let pageCount = 0;
      do {
        const page = await fetchPage({ tourId: 'TOUR', ownerId: 'OWNER', limit: 30, endBefore: cursor }, options);
        ids.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
        pageCount += 1;
        if (pageCount === 1) {
          if (deletedCursor) await writer.ref(`${root}/${cursor.id}`).remove();
          // Newer insertion belongs to the live head and must not disturb the
          // established backwards traversal or manufacture duplicates.
          await writer.ref(`${root}/newer`).set({ timestamp: 5000, caption: 'Synthetic concurrent insertion' });
          // Older insertion remains reachable before the traversal passes it.
          await writer.ref(`${root}/older`).set({ timestamp: 1, caption: 'Synthetic older insertion' });
        }
        if (!page.hasMore) break;
        assert.ok(pageCount < 10, 'pagination terminates');
      } while (cursor);
      assert.equal(pageCount, 4);
      assert.equal(ids.length, 96);
      assert.equal(new Set(ids).size, 96);
      assert.deepEqual(new Set(ids), new Set([...Object.keys(records), 'older']));
      const head = await fetchPage({ tourId: 'TOUR', ownerId: 'OWNER', limit: 30 }, options);
      assert.ok(head.items.some(item => item.id === 'newer'));
    });
  }
}

test('fresh SDK offline session read has a bounded startup decision; late reconnect cannot return authority', async () => {
  await env.clearDatabase();
  const cold = env.unauthenticatedContext().database(databaseURL);
  cold.goOffline();
  const service = createAppSessionService({ getFirebase: () => ({ realtimeDb: cold }) });
  const started = Date.now();
  await assert.rejects(service.verifyCurrent({ authUid: 'synthetic-phone', expectedSession: {}, timeoutMs: 25 }),
    error => error.code === 'NETWORK_DECISION_TIMEOUT');
  assert.ok(Date.now() - started < 1000);
  cold.goOnline();
});

test('two authorized SDK handsets reconcile older boarding through automatic replay and restart', async () => {
  const fs = require('node:fs');
  const { driverAuthorityUpdates } = require('./firebaseRules/sessionFixtures');
  const { applyManifestUpdateDirect } = require('../services/booking/manifestService');
  const queue = require('../services/offlineSyncService');
  const { createDriverManifestCacheService } = require('../services/driverManifestCacheService');
  await env.clearDatabase();
  await env.cleanup();
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({ projectId: 'demo-llt-mobile-media', database: { host, port: Number(port),
    rules: fs.readFileSync(require('node:path').resolve(__dirname, '../database.rules.json'), 'utf8') } });
  const tourId = 'BOARDING_TOUR'; const bookingRef = 'BOOKING-ONE';
  await env.withSecurityRulesDisabled(async context => {
    await context.database(databaseURL).ref().update({
      [`tours/${tourId}`]: { name: 'Synthetic boarding tour', tourCode: 'BOARDING TOUR', isActive: true },
      [`bookings/${bookingRef}`]: { tourId },
      ...driverAuthorityUpdates({ uid: 'boarding-phone-a', driverId: 'D-ONE', tourId }),
      ...driverAuthorityUpdates({ uid: 'boarding-phone-b', driverId: 'D-TWO', tourId }),
    });
  });
  const a = env.authenticatedContext('boarding-phone-a').database(databaseURL);
  const b = env.authenticatedContext('boarding-phone-b').database(databaseURL);
  const base = { tourCode: 'BOARDING TOUR', bookingRef };
  const authoritative = await applyManifestUpdateDirect({ ...base, passengerStatuses: ['NO_SHOW'],
    lastUpdated: '2026-10-24T12:00:02.000Z', idempotencyKey: 'handset_b_newer' }, b);
  assert.equal(authoritative.success, true, authoritative.error);
  const values = new Map(); const local = { getItemAsync: async key => values.get(key) || null,
    setItemAsync: async (key, value) => values.set(key, value), deleteItemAsync: async key => values.delete(key) };
  const cache = createDriverManifestCacheService({ storage: local });
  await cache.replace({ tourId, driverId: 'D-ONE', manifest: { tourId, complete: true,
    bookings: [{ id: bookingRef, passengerNames: ['Synthetic Guest'], passengerStatus: ['BOARDED'] }] } });
  const scope = { tourId, principalId: 'driver:D-ONE', role: 'driver', authUid: 'boarding-phone-a', cacheOwnerId: 'D-ONE' };
  await queue.setActiveSessionScope(scope);
  await queue.enqueueAction({ id: 'handset_a_older', type: 'MANIFEST_UPDATE', tourId, scope,
    payload: { ...base, passengerStatuses: ['BOARDED'], lastUpdated: '2026-10-24T12:00:01.000Z', idempotencyKey: 'handset_a_older' } });
  const replay = await queue.replayQueue({ scope, db: a, services: { driverManifestCache: cache, bookingService: { applyManifestUpdateDirect } } });
  assert.equal(replay.success, true);
  assert.equal(replay.data.outcomes[0].reconciled, true);
  assert.equal((await queue.getQueuedActions({ scope })).data.length, 0);
  const restarted = await createDriverManifestCacheService({ storage: local }).get({ tourId, driverId: 'D-ONE' });
  assert.equal(restarted.data.bookings[0].status, 'NO_SHOW');
  assert.equal(restarted.data.lastReconciliation.attemptedStatus, 'BOARDED');
  assert.equal((await a.ref(`tour_manifests/${tourId}/bookings/${bookingRef}/status`).get()).val(), 'NO_SHOW');
});
