'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) throw new Error('Loopback database emulator required');
const projectId = 'demo-llt-tour-publication';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
const admin = require('../functions/node_modules/firebase-admin');
const { createTourPublisher, commitTourPublication } = require('../functions/src/domains/administration/tourPublication');
const { acquireManualSourceRosterLease, releaseManualSourceRosterLease } = require('../functions/src/domains/administration/manualPassengerBooking');
const { applyTourMutation } = require('../functions/src/domains/administration/tourMutation');
const { tourPublicationGate, tourPublicationReadGrants } = require('../functions/lib/tourPublicationRules');
const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), projectId);
const db = app.database();
const read = async path => (await db.ref(path).once('value')).val();
test.before(async () => installDemoDatabaseRules({ projectId }));
test.beforeEach(async () => db.ref().set(null));
test.after(async () => Promise.all(admin.apps.map(item => item.delete())));

for (const kind of ['delete', 'manual', 'import']) test(`queued ${kind} cannot remove a transferred booking or recreate a successor tour`, async () => {
  await db.ref().set({ tours: { A: { name: 'Original' }, B: { name: 'Destination' } },
    bookings: { BOOK: { tourId: 'A', operatorNote: 'Keep' } },
    sync_roster_control: { A: { owner: 'old', leaseUntilMs: Date.now() + 60000 } } });
  let connection; let acknowledgeQueued;
  const queued = new Promise(resolve => { acknowledgeQueued = resolve; });
  const updates = kind === 'delete' ? { 'tours/A': null, 'bookings/BOOK': null }
    : { 'tours/A/name': 'Stale', 'bookings/BOOK/tourId': 'A' };
  const pending = commitTourPublication({ db, tourIds: ['A'], bookingRefs: ['BOOK'], owner: 'old', updates,
    createPublisher: args => {
      const publisher = createTourPublisher(args); connection = publisher.database; connection.goOffline();
      return { ...publisher, database: { ref: () => ({ update: value => {
        const result = connection.ref().update(value); acknowledgeQueued(); return result;
      } }) } };
    } });
  const outcome = pending.then(() => 'accepted', () => 'denied');
  await queued;
  await db.ref().update({ 'sync_roster_control/A/owner': 'successor', 'bookings/BOOK/tourId': 'B',
    'tours/A': { name: 'Recreated', adminMutationRevision: 'successor' } });
  connection.goOnline();
  assert.equal(await outcome, 'denied');
  assert.deepEqual(await read('bookings/BOOK'), { tourId: 'B', operatorNote: 'Keep' });
  assert.equal((await read('tours/A')).name, 'Recreated');
});

test('cold shared lease denies manual writes during deletion, and explicit recreation starts a fresh revision', async () => {
  await db.ref('sync_roster_control/A').set({ lifecycle: { state: 'deleting', generation: 'old' } });
  assert.equal(await acquireManualSourceRosterLease({ db, tourId: 'A', owner: 'manual' }), false);
  await assert.rejects(applyTourMutation({ db, tourId: 'A', mode: 'create', values: {} }), /TOUR_BUSY_OR_DELETED/);
  await db.ref('sync_roster_control/A/lifecycle/state').set('deleted');
  const result = await applyTourMutation({ db, tourId: 'A', mode: 'create', values: {
    name: 'New', tourCode: 'A', startDate: '01/11/2026', endDate: '02/11/2026', days: 2,
  } });
  assert.equal((await read('sync_roster_control/A/lifecycle')).state, 'active');
  assert.equal((await read('tours/A')).adminMutationRevision, result.revision);
  await assert.rejects(applyTourMutation({ db, tourId: 'A', mode: 'update', values: { name: 'Old edit' }, expectedRevision: null }), /TOUR_CHANGED/);
  await applyTourMutation({ db, tourId: 'A', mode: 'update', values: { name: 'Current edit' }, expectedRevision: result.revision });
  assert.equal((await read('tours/A')).name, 'Current edit');
  assert.equal(await read('sync_roster_control/A/owner'), null);
});

test('ordinary custom-token claims cannot forge a server publisher', async () => {
  await acquireManualSourceRosterLease({ db, tourId: 'A', owner: 'known' });
  const forged = admin.initializeApp({ ...app.options, databaseAuthVariableOverride: {
    uid: 'attacker', token: { lltTourPublisher: true, tourCount: 1, tour0: 'A', owner: 'known' },
  } }, 'forged-tour-publisher');
  await assert.rejects(forged.database().ref('tours/A').set({ name: 'Forged' }));
  await forged.delete();
  await releaseManualSourceRosterLease({ db, tourId: 'A', owner: 'known' });
});

test('CAS read grants permit exact current component and deny foreign or superseded leaves', async () => {
  await db.ref().set({ sync_roster_control: { A: { owner: 'reader', leaseUntilMs: Date.now() + 60000 },
    _transfers: { current: { tourIds: ['A'] }, foreign: { tourIds: ['B'] } } },
  tours: { A: { name: 'Current' }, B: { name: 'Foreign' } },
  pickupPoints: { A: { label: 'Current' }, B: { label: 'Foreign' } },
  bookings: { CURRENT: { tourId: 'A' }, FOREIGN: { tourId: 'B' } },
  booking_identities: { CURRENT: { email: 'synthetic@example.invalid' }, FOREIGN: { email: 'outside@example.invalid' } },
  sync_roster_archive: { CURRENT: { hash: { sourceSnapshot: { tourId: 'A' } } }, FOREIGN: { hash: { sourceSnapshot: { tourId: 'B' } } } } });
  const publisher = createTourPublisher({ db, tourIds: ['A'], owner: 'reader' });
  const allowed = ['tours/A', 'pickupPoints/A', 'bookings/CURRENT', 'booking_identities/CURRENT', 'sync_roster_archive/CURRENT/hash', 'sync_roster_control/_transfers/current'];
  try {
    for (const path of allowed) assert.ok((await publisher.database.ref(path).once('value')).exists(), path);
    for (const path of ['/', 'bookings', 'tours/B', 'pickupPoints/B', 'bookings/FOREIGN', 'booking_identities/FOREIGN', 'sync_roster_archive/FOREIGN/hash', 'sync_roster_control/_transfers/foreign']) {
      await assert.rejects(publisher.database.ref(path).once('value'), /permission_denied/i);
    }
    await publisher.database.ref('tours/A').transaction(value => ({ ...value, name: 'CAS current' }));
    assert.equal((await read('tours/A')).name, 'CAS current');
    await db.ref('sync_roster_control/A/owner').set('successor');
    for (const path of allowed) await assert.rejects(publisher.database.ref(path).once('value'), /permission_denied/i);
  } finally { await publisher.close(); }
});

test('cross-repository SDK fixture uses the same commit-time lease contract', () => {
  const fixture = new URL('../../llt-app-sync/tests/fixtures/tour-publication.rules.json', `file:///${__filename.replaceAll('\\', '/')}`);
  // The fixture travels with the importer; check parity when both repositories
  // are present. CI in the app independently tests the full production rules.
  if (fs.existsSync(fixture)) assert.equal(JSON.parse(fs.readFileSync(fixture)).rules['.write'], tourPublicationGate());
  const rules = JSON.parse(fs.readFileSync(require.resolve('../database.rules.json'))).rules;
  assert.ok(rules['.write'].includes(tourPublicationGate()));
  for (const { path, predicate } of tourPublicationReadGrants()) {
    assert.ok(path.reduce((node, key) => node[key], rules)['.read'].includes(predicate));
    if (fs.existsSync(fixture)) {
      assert.equal(path.reduce((node, key) => node[key], JSON.parse(fs.readFileSync(fixture)).rules)['.read'], predicate);
    }
  }
});
