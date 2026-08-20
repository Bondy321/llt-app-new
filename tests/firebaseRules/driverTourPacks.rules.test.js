const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-driver-tour-pack-rules';
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
const roots = [
  'driver_tour_packs/2026-09-10::5001D_1',
  'driver_tour_pack_tombstones/2026-09-10::5001D_1',
  'driver_tour_pack_ingestion/latestSuccessfulRun',
];

let testEnv;
let databaseURL;

test.before(async () => {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!raw) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = raw.split(':');
  const port = Number(portText);
  databaseURL = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host, port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(databaseURL);
    await db.ref(roots[0]).set({ schemaVersion: 1, status: 'active' });
    await db.ref(roots[1]).set({ schemaVersion: 1, status: 'cancelled' });
    await db.ref(roots[2]).set({ runId: 'server-owned-run' });
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test('Gate 5 keeps every Tour Pack root private from all client principals', async () => {
  const contexts = [
    testEnv.unauthenticatedContext(),
    testEnv.authenticatedContext('9CWQ4705gVRkfW5Xki5LyvrmVp23'),
    testEnv.authenticatedContext('assigned-driver'),
    testEnv.authenticatedContext('passenger'),
  ];
  for (const context of contexts) {
    const db = context.database(databaseURL);
    for (const root of roots) {
      await assertFails(db.ref(root).get());
      await assertFails(db.ref(root).set({ forged: true }));
    }
  }
});
