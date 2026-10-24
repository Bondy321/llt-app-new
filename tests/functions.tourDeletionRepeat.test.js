'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const projection = require('../functions/lib/driverLocationProjection');
const deletion = require('../functions/src/domains/administration/tourDeletion');
const TOUR = 'FIXTURE_DELETE';
let context;
const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (!parent?.filename.endsWith('administrationFunctions.js')) return originalLoad(request, parent, isMain);
  if (request === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (request.endsWith('/bootstrap/firebaseAdmin')) return { admin: { database: () => context.db, storage: () => ({ bucket: () => ({}) }) } };
  if (request.endsWith('/bootstrap/legacyLibrary')) return { loadLegacyLibrary: () => projection };
  if (request.endsWith('/auth/requestAuth')) return { verifyRequestAuthUid: async () => ({ success: true, uid: 'fixture-admin', claims: { firebase: { sign_in_second_factor: 'totp' } } }) };
  if (request.endsWith('/database/operationLock')) return {
    acquireManualBookingLock: async ({ path }) => { context.locks.add(path); return true; },
    releaseManualBookingLock: async ({ path }) => { context.locks.delete(path); },
  };
  if (request.endsWith('/http/adminCors')) return { applyAuthenticatedCors: () => true };
  if (request.endsWith('/logging/safeLogger')) return { log: { warn() {}, info() {}, error() {} } };
  if (request.endsWith('/rate-limit/requestRateLimiter')) return { checkRateLimit: () => true, getRequestClientKey: () => 'fixture' };
  if (request.endsWith('/storage/storageDeletion')) return {
    deleteStoragePrefixes: async () => { context.storageCalls += 1; return 0; },
    deleteStoragePaths: async () => { throw new Error('Unexpected storage path deletion'); },
  };
  if (request === '../media/public') return { drainTourMediaForDeletion: async () => { context.mediaDrains += 1; } };
  if (request === './adminAuthorization') return { verifyOperationsAdminAccess: async () => true };
  if (request === './tourPublication') return { commitTourPublication: async ({ db, updates }) => db.ref().update(updates) };
  if (request === './tourDeletion') return deletion;
  return originalLoad(request, parent, isMain);
};
const { deleteTourData } = require('../functions/src/domains/administration/administrationFunctions');
Module._load = originalLoad;

const memory = initial => {
  const state = structuredClone(initial);
  const read = path => path.split('/').filter(Boolean).reduce((value, key) => value?.[key], state);
  const write = (path, value) => {
    const keys = path.split('/').filter(Boolean); let target = state;
    for (const key of keys.slice(0, -1)) target = target[key] ||= {};
    if (value === null) delete target[keys.at(-1)]; else target[keys.at(-1)] = structuredClone(value);
  };
  const ref = (path = '', query = {}) => ({
    async once() {
      let value = read(path) ?? null;
      if (query.child) value = Object.fromEntries(Object.entries(value || {})
        .filter(([, record]) => record?.[query.child] === query.equal));
      const captured = structuredClone(value);
      if (path === `tours/${TOUR}`) context.onTourRead?.();
      return { val: () => structuredClone(captured), exists: () => captured !== null };
    },
    get() { return this.once(); },
    orderByChild(child) { return ref(path, { ...query, child }); },
    equalTo(equal) { return ref(path, { ...query, equal }); },
    async transaction(update) {
      const next = update(structuredClone(read(path) ?? null));
      if (next === undefined) return { committed: false, snapshot: { val: () => read(path) ?? null } };
      write(path, next);
      return { committed: true, snapshot: { val: () => structuredClone(next) } };
    },
    async update(updates) {
      context.rootWrites += Number(!path);
      for (const [relative, value] of Object.entries(updates)) write([path, relative].filter(Boolean).join('/'), value);
    },
    async remove() { write(path, null); },
  });
  return { state, ref, write };
};
const initialize = initial => {
  context = { mediaDrains: 0, storageCalls: 0, rootWrites: 0, locks: new Set(), onTourRead: null };
  context.db = memory(initial);
  return context;
};
const requestDeletion = async () => {
  const result = {};
  const response = { status: status => { result.status = status; return response; },
    json: body => { result.body = body; return body; } };
  await deleteTourData({ method: 'POST', body: { tourId: TOUR } }, response);
  assert.equal(context.locks.size, 0);
  return result;
};

test('repeating a completed tour deletion returns an exact zero-count result without storage or content mutation', async () => {
  const c = initialize({ tours: { [TOUR]: { name: 'Fixture tour' } },
    tour_manifests: { [TOUR]: { assigned_drivers: {} } } });
  const first = await requestDeletion();
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyDeleted, false);
  assert.equal(c.db.state.tours[TOUR], undefined);
  const before = structuredClone(c.db.state);
  const priorWrites = c.rootWrites;
  const priorStorage = c.storageCalls;
  const second = await requestDeletion();
  assert.deepEqual(second, { status: 200, body: { success: true, tourId: TOUR, alreadyDeleted: true,
    summary: { bookingsDeleted: 0, storageObjectsDeleted: 0, databasePathsDeleted: 0, alreadyDeleted: true } } });
  assert.deepEqual(c.db.state, before);
  assert.equal(c.rootWrites, priorWrites);
  assert.equal(c.storageCalls, priorStorage);
});

test('missing-tour acknowledgement preserves orphan data and records a durable deletion fence', async () => {
  const c = initialize({ tours: {}, bookings: { ORPHAN: { tourId: TOUR } },
    tour_manifests: { [TOUR]: { passengers: { ORPHAN: { name: 'Fixture roster' } } } } });
  const result = await requestDeletion();
  assert.equal(result.status, 200);
  assert.equal(result.body.alreadyDeleted, true);
  assert.equal(result.body.summary.databasePathsDeleted, 0);
  assert.equal(c.db.state.tours[TOUR], undefined);
  assert.equal(c.db.state.bookings.ORPHAN.tourId, TOUR);
  assert.equal(c.db.state.tour_manifests[TOUR].passengers.ORPHAN.name, 'Fixture roster');
  assert.equal(c.db.state.sync_roster_control[TOUR].lifecycle.state, 'deleted');
  assert.equal(c.storageCalls, 0);
});
