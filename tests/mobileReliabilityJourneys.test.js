'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../services/offlineSyncService');
const { storage } = require('../services/offline-sync/offlineSyncContext');
const { sendMessage, subscribeToChatMessages, getChatMessageById, hydrateGroupPhotoMessages } = require('../services/chatService');
const { createDriverTourPackActionService } = require('../services/driverTourPackActionService');
const { createDriverManifestCacheService } = require('../services/driverManifestCacheService');
const { acknowledgeCurrentNotice, acknowledgeCurrentNotices } = require('../services/notificationInboxService');
const scope = { tourId: 'TOUR_A', principalId: 'driver:D-ONE', role: 'driver', authUid: 'phone', cacheOwnerId: 'D-ONE' };
const sender = { name: 'Synthetic Driver', principalId: scope.principalId, userId: scope.principalId, principalType: 'driver', authUid: scope.authUid, isDriver: true };
const memory = () => { const values = new Map(); return { values, getItemAsync: async key => values.get(key) || null,
 setItemAsync: async (key, value) => values.set(key, value), deleteItemAsync: async key => values.delete(key) }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const snapshot = data => ({ exists: () => data != null, val: () => data,
 forEach: fn => Object.entries(data || {}).forEach(([key, value]) => fn({ key, val: () => value })) });
test.beforeEach(async () => { await queue.setActiveSessionScope(scope); await queue.purgeActionsForScope({ scope }); });

test('text survives a restarted queue reader before draft clearance, times out and reuses immutable delivery ID', async () => {
 const server = deferred(); const writes = [];
 const db = { ref: path => ({ transaction: async updater => {
  writes.push(path); const value = updater(null); await server.promise;
  return { committed: true, snapshot: { val: () => value } };
 } }) };
 let durable = false;
 const result = await sendMessage('TOUR_A', 'Synthetic durable text', sender, db, {
  messageId: 'durable_message', deliveryTimeoutMs: 15, onDurable: () => { durable = true; }
 });
 assert.equal(durable, true); assert.equal(result.success, true); assert.equal(result.queued, true);
 const persisted = await queue.getQueuedActions({ scope });
 assert.equal(persisted.data.length, 1); assert.equal(persisted.data[0].payload.messageId, 'durable_message');
 const restartedReader = require('../services/offline-sync/syncStatusService');
 assert.equal((await restartedReader.getQueueRaw())[0].payload.text, 'Synthetic durable text');
 server.resolve(); await turn();
 assert.equal((await queue.getQueuedActions({ scope })).data.length, 1, 'late remote acknowledgement cannot silently erase recovery');
 assert.equal(writes.length, 1);
});

test('durable queue failure never clears text or starts remote delivery', async () => {
 const original = storage.setItemAsync;
 let cleared = false; let dispatched = false;
 storage.setItemAsync = async () => { throw new Error('Synthetic disk full'); };
 try {
  const result = await sendMessage('TOUR_A', 'Keep this draft', sender, { ref: () => { dispatched = true; throw Error('unexpected'); } },
   { messageId: 'storage_failure', onDurable: () => { cleared = true; } });
  assert.equal(result.success, false); assert.equal(cleared, false); assert.equal(dispatched, false);
 } finally { storage.setItemAsync = original; }
});

test('one hanging replay attempt cannot block unrelated durable text and preserves the timed-out ID', async () => {
 for (const id of ['hang', 'next']) await queue.enqueueAction({ id, type: 'CHAT_MESSAGE', tourId: 'TOUR_A', scope,
  payload: { messageId: id, text: id, senderInfo: sender } });
 const processed = [];
 const result = await queue.replayQueue({ scope, attemptTimeoutMs: 15, services: { chatService: {
  sendMessageDirect: payload => { processed.push(payload.messageId); return payload.messageId === 'hang' ? new Promise(() => {}) : Promise.resolve({ success: true }); }
 } } });
 assert.deepEqual(processed, ['hang', 'next']); assert.equal(result.success, true);
 assert.deepEqual((await queue.getQueuedActions({ scope })).data.map(action => action.id), ['hang']);
});

test('mixed text snapshots publish immediately, timeout to retryable media, and ignore out-of-order signed URLs', async () => {
 let listener; const late = deferred(); const seen = [];
 const ref = { orderByChild: () => ref, limitToLast: () => ref,
  on: (_event, fn) => { listener = fn; return fn; }, off() {} };
 const stop = subscribeToChatMessages('TOUR_A', messages => seen.push(messages), { ref: () => ref }, {
  mediaTimeoutMs: 15, resolveGroupPhotoMediaFn: () => late.promise });
 listener(snapshot({ photo: { type: 'image', photoId: 'photo_a', timestamp: 1 }, text: { type: 'text', text: 'Visible now', timestamp: 2 } }));
 assert.equal(seen[0].find(item => item.id === 'text').text, 'Visible now');
 assert.equal(seen[0].find(item => item.id === 'photo').mediaState, 'loading');
 await new Promise(resolve => setTimeout(resolve, 25));
 assert.equal(seen.at(-1).find(item => item.id === 'photo').mediaState, 'retryable');
 listener(snapshot({ text: { type: 'text', text: 'Photo was removed', timestamp: 3 } }));
 late.resolve([{ id: 'photo_a', viewerUrl: 'https://signed.invalid/synthetic' }]); await turn();
 assert.deepEqual(seen.at(-1).map(item => item.id), ['text']); stop();
});

test('partial photo batches retain successful media and valid text', async () => {
 const messages = [...Array.from({ length: 45 }, (_, index) => ({ id: `m${index}`, type: 'image', photoId: `p${index}` })), { id: 'text', type: 'text', text: 'Still visible' }];
 let calls = 0;
 const hydrated = await hydrateGroupPhotoMessages('TOUR_A', messages, async ({ photos }) => {
  calls += 1; if (photos[0].id === 'p20') throw Error('Synthetic signing failure');
  return photos.map(photo => ({ id: photo.id, viewerUrl: `https://signed.invalid/${photo.id}` }));
 });
 assert.equal(calls, 3); assert.equal(hydrated.filter(item => item.mediaState === 'ready').length, 25);
 assert.equal(hydrated.filter(item => item.mediaState === 'retryable').length, 20);
 assert.equal(hydrated.at(-1).text, 'Still visible');
});

test('older notification image uses authorized resolution, suppresses deletion and changed identity', async () => {
 let stored = { type: 'image', photoId: 'old_photo', timestamp: 1 };
 const db = { ref: () => ({ once: async () => snapshot(stored) }) };
 const ready = await getChatMessageById({ tourId: 'TOUR_A', messageId: 'old', dbInstance: db,
  resolveGroupPhotoMediaFn: async () => [{ id: 'old_photo', viewerUrl: 'https://signed.invalid/old' }] });
 assert.equal(ready.message.imageUrl, 'https://signed.invalid/old');
 const deleted = await getChatMessageById({ tourId: 'TOUR_A', messageId: 'old', dbInstance: db,
  resolveGroupPhotoMediaFn: async () => { stored = null; return [{ id: 'old_photo', viewerUrl: 'https://signed.invalid/deleted' }]; } });
 assert.equal(deleted.message, null);
 stored = { type: 'image', photoId: 'old_photo', timestamp: 1 }; let current = true;
 const changed = await getChatMessageById({ tourId: 'TOUR_A', messageId: 'old', dbInstance: db, isCurrent: () => current,
  resolveGroupPhotoMediaFn: async () => { current = false; return [{ id: 'old_photo', viewerUrl: 'https://signed.invalid/wrong' }]; } });
 assert.equal(changed.success, false); assert.equal(changed.message, null);
});

test('three offline Tour Pack intents keep a syncing predecessor and durable latest successor across service recreation', async () => {
 const cacheStorage = memory(); const packScope = { departureKey: '2026-10-24::TOUR_A', tourId: 'TOUR_A', driverId: 'D-ONE', authUid: 'phone' };
 let service = createDriverTourPackActionService({ storage: cacheStorage, queue, now: () => 100 });
 const operation = state => ({ kind: 'pickup', targetId: 'stop_1', packRevision: 1, state });
 assert.equal((await service.submit(packScope, operation('ARRIVED'), { online: false })).success, true);
 const first = (await queue.getQueuedActions({ scope })).data[0];
 await queue.updateAction(first.id, { status: 'syncing' }, { scope });
 await service.submit(packScope, operation('COMPLETED'), { online: false });
 service = createDriverTourPackActionService({ storage: cacheStorage, queue, now: () => 100 });
 await service.submit(packScope, operation('SKIPPED'), { online: false });
 const actions = (await queue.getQueuedActions({ scope })).data;
 assert.equal(actions.length, 2); assert.notEqual(actions[0].id, actions[1].id);
 assert.deepEqual(actions.map(action => action.payload.state), ['ARRIVED', 'SKIPPED']);
 assert.ok(actions[1].payload.clientUpdatedAtMs > actions[0].payload.clientUpdatedAtMs);
 await service.writeCache(packScope, { pickupStops: { stop_1: { state: 'ARRIVED', updatedAtMs: 100 } } });
 assert.equal((await service.readCache(packScope)).data.actions.pickupStops.stop_1.state, 'SKIPPED');
});

const seededManifest = () => ({ tourId: 'TOUR_A', complete: true, bookings: [{ id: 'BOOK_1', passengerNames: ['Synthetic Passenger'], passengerStatus: ['BOARDED'] }] });
for (const successor of [false, true]) test(`automatic manifest reconciliation persists server outcome without mounted screen; successor=${successor}`, async () => {
 const local = memory(); const cache = createDriverManifestCacheService({ storage: local });
 assert.equal((await cache.replace({ tourId: 'TOUR_A', driverId: 'D-ONE', manifest: seededManifest() })).success, true);
 await queue.enqueueAction({ id: 'boarding_old', type: 'MANIFEST_UPDATE', tourId: 'TOUR_A', scope,
  createdAt: '2026-10-24T00:00:00.000Z', payload: { bookingRef: 'BOOK_1', passengerStatuses: ['BOARDED'] } });
 const events = []; const stop = cache.subscribe({ tourId: 'TOUR_A', driverId: 'D-ONE' }, event => events.push(event));
 const replay = await queue.replayQueue({ scope, services: { driverManifestCache: cache, bookingService: {
  applyManifestUpdateDirect: async () => {
   if (successor) await queue.enqueueAction({ id: 'boarding_new', type: 'MANIFEST_UPDATE', tourId: 'TOUR_A', scope,
    createdAt: '2026-10-24T00:00:02.000Z', payload: { bookingRef: 'BOOK_1', passengerStatuses: ['PENDING'] } });
   return { success: true, reconciled: true, passengerStatus: ['NO_SHOW'], status: 'NO_SHOW',
    conflict: { reason: 'SERVER_NEWER', bookingRef: 'BOOK_1', serverStatus: 'NO_SHOW', attemptedStatus: 'BOARDED' } };
  }
 } } }); stop();
 assert.equal(replay.success, true);
 const restarted = await createDriverManifestCacheService({ storage: local }).get({ tourId: 'TOUR_A', driverId: 'D-ONE' });
 assert.equal(restarted.data.bookings[0].status, successor ? 'PENDING' : 'NO_SHOW');
 assert.equal(restarted.data.lastReconciliation.serverStatus, 'NO_SHOW');
 assert.equal(events.at(-1).reason, 'reconciliation');
 assert.equal((await queue.getQueuedActions({ scope })).data.length, successor ? 1 : 0);
 const lateOptimistic = await cache.applyQueuedUpdate({ scope, actionId: 'boarding_old' });
 assert.equal(lateOptimistic.queued, false);
 assert.equal(lateOptimistic.data.bookings[0].status, successor ? 'PENDING' : 'NO_SHOW');
});

test('notice acknowledgement selects current principal under one installation and propagates failure', async () => {
 const base = { schemaVersion: 1, sessionId: `sess_v1_${'a'.repeat(32)}`, principalType: 'passenger', principalId: `pax_v2_${'b'.repeat(32)}`,
  driverId: null, tourId: 'TOUR_A', issuedAtMs: 1, expiresAtMs: Date.now() + 100000, sessionRevision: 1 };
 let current = { authUid: 'phone', appSession: base }; const paths = [];
 const db = { ref: path => ({ set: async () => { paths.push(path); }, update: async values => { paths.push(...Object.keys(values)); } }) };
 const opts = { getContext: () => current, tourId: 'TOUR_A', noticeId: 'notice', db, auth: { currentUser: { uid: 'phone' } } };
 await acknowledgeCurrentNotice(opts);
 current = { authUid: 'phone', appSession: { ...base, principalType: 'driver', principalId: 'driver:D-ONE', driverId: 'D-ONE' } };
 await acknowledgeCurrentNotice(opts);
 assert.ok(paths[0].includes(base.principalId)); assert.ok(paths[1].includes('driver:D-ONE'));
 await acknowledgeCurrentNotices({ ...opts, noticeIds: ['notice', 'second'] });
 assert.ok(paths.slice(-2).every(path => path.includes('driver:D-ONE')));
 await assert.rejects(acknowledgeCurrentNotice({ ...opts, auth: { currentUser: { uid: 'other-installation' } } }), /user|uid|identity|current|session/i);
 await assert.rejects(acknowledgeCurrentNotice({ ...opts, db: { ref: () => ({ set: async () => { throw Error('Synthetic permission failure'); } }) } }), /permission failure/);
 current = { authUid: 'phone', appSession: null };
 await assert.rejects(acknowledgeCurrentNotice(opts), /current matching/);
});
