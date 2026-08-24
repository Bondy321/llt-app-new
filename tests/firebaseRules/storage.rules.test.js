const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  ref,
  uploadBytes,
  deleteObject,
  getBytes,
} = require('firebase/storage');

const PROJECT_ID = 'demo-llt-storage-rules';
const BUCKET_URL = `gs://${PROJECT_ID}.appspot.com`;
const OWNER_UID = 'photo-owner';
const FOREIGN_UID = 'photo-foreign';
const OWNER_KEY = 'pax_v2_77777777777777777777777777777777';
const FOREIGN_OWNER_KEY = 'pax_v2_88888888888888888888888888888888';

const parseHost = () => {
  const value = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_STORAGE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  return { host, port: Number(portText) };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../storage_rules.json'), 'utf8');
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const imageMetadataFor = (authUid) => ({
  contentType: 'image/jpeg',
  customMetadata: { authUid },
});

let testEnv;
const storageFor = (uid, claims = {}) => testEnv.authenticatedContext(uid, claims).storage(BUCKET_URL);

test.before(async () => {
  const emulator = parseHost();
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      host: emulator.host,
      port: emulator.port,
      rules,
    },
  });
});

test.beforeEach(async () => {
  await testEnv.clearStorage();
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('all direct client access to server-mediated group media is denied', async () => {
  const paths = [
    'group_tour_photos/TOUR_B/source.jpg',
    'group_tour_photos/TOUR_B/viewers/source_viewer.jpg',
    'group_tour_photos/TOUR_B/thumbnails/source_thumb.jpg',
  ];
  await testEnv.withSecurityRulesDisabled(async (context) => {
    for (const objectPath of paths) {
      await uploadBytes(ref(context.storage(BUCKET_URL), objectPath), imageBytes, { contentType: 'image/jpeg' });
    }
  });
  for (const objectPath of paths) {
    for (const context of [
      storageFor(OWNER_UID, { tourId: 'TOUR_B' }),
      storageFor(FOREIGN_UID, { tourId: 'TOUR_A' }),
      storageFor('unassigned-driver', { driverId: 'D-404' }),
      testEnv.unauthenticatedContext().storage(BUCKET_URL),
    ]) {
      const objectRef = ref(context, objectPath);
      await assertFails(getBytes(objectRef));
      await assertFails(deleteObject(objectRef));
    }
  }
});

test('members cannot upload to their own, another, or an invented group tour path', async () => {
  for (const objectPath of [
    'group_tour_photos/TOUR_A/own.jpg',
    'group_tour_photos/TOUR_B/cross-tour.jpg',
    'group_tour_photos/INVENTED_TOUR/invented.jpg',
  ]) {
    await assertFails(uploadBytes(
      ref(storageFor(OWNER_UID, { tourId: 'TOUR_A' }), objectPath),
      imageBytes,
      imageMetadataFor(OWNER_UID),
    ));
  }
});

test('all direct client access to server-mediated private media is denied', async () => {
  const objectPath = `private_tour_photos/TOUR_1/${OWNER_KEY}/read.jpg`;
  await testEnv.withSecurityRulesDisabled((context) => uploadBytes(
    ref(context.storage(BUCKET_URL), objectPath), imageBytes, { contentType: 'image/jpeg' },
  ));
  await assertFails(getBytes(ref(storageFor(OWNER_UID, { privatePhotoOwnerKey: OWNER_KEY }), objectPath)));
  await assertFails(deleteObject(ref(storageFor(OWNER_UID, { privatePhotoOwnerKey: OWNER_KEY }), objectPath)));
  await assertFails(getBytes(ref(storageFor(FOREIGN_UID), objectPath)));
  await assertFails(getBytes(ref(
    storageFor(FOREIGN_UID, { privatePhotoOwnerKey: FOREIGN_OWNER_KEY }),
    objectPath,
  )));
  await assertFails(getBytes(ref(
    testEnv.unauthenticatedContext().storage(BUCKET_URL),
    objectPath,
  )));
});

test('private uploads are denied even with the former matching owner claim and metadata', async () => {
  const objectPath = `private_tour_photos/TOUR_1/${OWNER_KEY}/metadata.jpg`;
  const objectRef = ref(storageFor(OWNER_UID, { privatePhotoOwnerKey: OWNER_KEY }), objectPath);
  await assertFails(uploadBytes(objectRef, imageBytes, {
    contentType: 'image/jpeg',
    customMetadata: { authUid: OWNER_UID, visibility: 'private', sourceRole: 'source' },
  }));
});

test('a restored stable owner cannot directly delete a private object', async () => {
  const objectPath = `private_tour_photos/TOUR_1/${OWNER_KEY}/legacy.jpg`;
  await testEnv.withSecurityRulesDisabled((context) => uploadBytes(
    ref(context.storage(BUCKET_URL), objectPath), imageBytes, { contentType: 'image/jpeg' },
  ));
  await assertFails(deleteObject(ref(
    storageFor('restored-owner', { privatePhotoOwnerKey: OWNER_KEY }),
    objectPath,
  )));
});
