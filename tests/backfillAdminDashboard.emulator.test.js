'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../functions/node_modules/firebase-admin');
const { PROGRESS_PATH, parseArgs, run, transactionWithHydratedValue } = require('../functions/scripts/backfillAdminDashboard');

const projectId = 'demo-llt-dashboard-resume';
const config = { projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` };
let writer;
let apps = [];
const fresh = () => {
  const app = admin.initializeApp(config, `dashboard-resume-${apps.length}`);
  apps.push(app);
  return app;
};

test.before(() => {
  assert.ok(process.env.FIREBASE_DATABASE_EMULATOR_HOST, 'This test requires the RTDB emulator');
  writer = fresh();
});
test.after(async () => { await Promise.all(apps.map(app => app.delete())); });
test.beforeEach(async () => { await writer.database().ref().set(null); });

test('applied pages resume on fresh SDK instances after the previous once cache is released', { timeout: 30_000 }, async () => {
  await writer.database().ref('tours').set({ A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' } });
  const options = parseArgs(['--apply', `--confirm-project=${projectId}`, '--page-size=1']);
  for (let page = 1; page <= 3; page += 1) {
    const app = fresh();
    const result = await run({ admin: { app: () => app, database: () => app.database() }, options });
    const progress = (await writer.database().ref(PROGRESS_PATH).once('value')).val();
    assert.equal(progress.revision, page);
    assert.equal(progress.pagesCompleted, page);
    assert.equal(progress.toursScanned, page);
    assert.equal(result.tours, 1);
    assert.equal(result.complete, page === 3);
  }
});

test('a cold-cache progress transaction preserves revision, cursor and deletion conflicts', { timeout: 30_000 }, async () => {
  const original = { revision: 1, lastTourCursor: 'A', pagesCompleted: 1 };
  for (const changed of [
    { ...original, revision: 2 },
    { ...original, lastTourCursor: 'B' },
    null,
  ]) {
    await writer.database().ref(PROGRESS_PATH).set(original);
    const app = fresh();
    const reference = app.database().ref(PROGRESS_PATH);
    // Interleave the competing write after hydration but before CAS starts.
    const wrapped = {
      on: (...args) => reference.on(...args),
      off: (...args) => reference.off(...args),
      transaction: async (...args) => {
        await writer.database().ref(PROGRESS_PATH).set(changed);
        return reference.transaction(...args);
      },
    };
    const result = await transactionWithHydratedValue(wrapped, current => {
      if (Number(current?.revision || 0) !== original.revision
        || String(current?.lastTourCursor || '') !== original.lastTourCursor) return undefined;
      return { ...current, revision: 2, lastTourCursor: 'B' };
    });
    assert.equal(result.committed, false);
    assert.deepEqual((await writer.database().ref(PROGRESS_PATH).once('value')).val(), changed);
  }
});

test('hydration listener is removed after updater failures', { timeout: 10_000 }, async () => {
  const app = fresh();
  const reference = app.database().ref(PROGRESS_PATH);
  const removals = [];
  const wrapped = {
    on: (...args) => reference.on(...args),
    off: (...args) => { removals.push(args); reference.off(...args); },
    transaction: async () => { throw new Error('fixture failure'); },
  };
  await assert.rejects(transactionWithHydratedValue(wrapped, value => value), /fixture failure/);
  assert.equal(removals.length, 1);
  assert.equal(removals[0][0], 'value');
  assert.equal(typeof removals[0][1], 'function');
});
