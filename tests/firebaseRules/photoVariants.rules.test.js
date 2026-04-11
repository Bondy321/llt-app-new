const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-photo-rules';
const TOUR_ID = 'TOUR_001';
const USER_UID = 'user-photo-1';
const OWNER_KEY = 'pax_v1:BOOKING:demo_example.com';
const GROUP_PATH = `group_tour_photos/${TOUR_ID}/photo_1`;
const PRIVATE_PATH = `private_tour_photos/${TOUR_ID}/${OWNER_KEY}/photo_1`;

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs
  .readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8')
  .replace(/\\s/g, ' ');

let testEnv;
let dbUrl;
const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: emulator.host,
      port: emulator.port,
      rules,
    },
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('allows valid group photo variant processing fields', async () => {
  await assertSucceeds(dbFor(USER_UID).ref(GROUP_PATH).set({
    url: 'https://example.com/source.jpg',
    fullUrl: 'https://example.com/source.jpg',
    sourceUrl: 'https://example.com/source.jpg',
    userId: USER_UID,
    timestamp: Date.now(),
    idempotencyKey: 'idem-1',
    variantStatus: 'processing',
    variantUpdatedAt: Date.now(),
    variantError: null,
    variantVersion: 2,
  }));
});

test('denies invalid variantStatus values', async () => {
  await assertFails(dbFor(USER_UID).ref(GROUP_PATH).set({
    url: 'https://example.com/source.jpg',
    userId: USER_UID,
    timestamp: Date.now(),
    variantStatus: 'queued',
  }));
});

test('allows private photo record with ready variants in valid shape', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(`users/${USER_UID}`).set({
      stablePassengerId: OWNER_KEY,
      privatePhotoOwnerId: OWNER_KEY,
    });
    await context.database(dbUrl).ref(`identity_bindings/${OWNER_KEY}/${USER_UID}`).set(true);
  });

  await assertSucceeds(dbFor(USER_UID).ref(PRIVATE_PATH).set({
    url: 'https://example.com/source.jpg',
    fullUrl: 'https://example.com/source.jpg',
    sourceUrl: 'https://example.com/source.jpg',
    userId: OWNER_KEY,
    timestamp: Date.now(),
    variantStatus: 'ready',
    viewerUrl: 'https://example.com/viewer.jpg',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    variantUpdatedAt: Date.now(),
    variantVersion: 2,
  }));
});
