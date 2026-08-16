const test = require('node:test');
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
const storageFor = (uid) => testEnv.authenticatedContext(uid).storage(BUCKET_URL);

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

test('photo owner can upload and delete group and private objects', async () => {
  for (const objectPath of [
    'group_tour_photos/TOUR_1/photo.jpg',
    'private_tour_photos/TOUR_1/PASSENGER_1/photo.jpg',
  ]) {
    const objectRef = ref(storageFor(OWNER_UID), objectPath);
    await assertSucceeds(uploadBytes(objectRef, imageBytes, imageMetadataFor(OWNER_UID)));
    await assertSucceeds(deleteObject(objectRef));
  }
});

test('another authenticated user cannot overwrite or delete the uploader object', async () => {
  const objectPath = 'group_tour_photos/TOUR_1/owned.jpg';
  await assertSucceeds(uploadBytes(
    ref(storageFor(OWNER_UID), objectPath),
    imageBytes,
    imageMetadataFor(OWNER_UID),
  ));

  const foreignRef = ref(storageFor(FOREIGN_UID), objectPath);
  await assertFails(uploadBytes(foreignRef, imageBytes, imageMetadataFor(FOREIGN_UID)));
  await assertFails(deleteObject(foreignRef));
});

test('uploads must be authenticated images with matching uploader metadata', async () => {
  const unauthenticatedRef = ref(
    testEnv.unauthenticatedContext().storage(BUCKET_URL),
    'group_tour_photos/TOUR_1/unauthenticated.jpg',
  );
  await assertFails(uploadBytes(unauthenticatedRef, imageBytes, imageMetadataFor(OWNER_UID)));

  const ownerStorage = storageFor(OWNER_UID);
  await assertFails(uploadBytes(
    ref(ownerStorage, 'group_tour_photos/TOUR_1/forged.jpg'),
    imageBytes,
    imageMetadataFor(FOREIGN_UID),
  ));
  await assertFails(uploadBytes(
    ref(ownerStorage, 'group_tour_photos/TOUR_1/not-image.txt'),
    new Uint8Array([1, 2, 3]),
    { contentType: 'text/plain', customMetadata: { authUid: OWNER_UID } },
  ));
});

test('photo reads require authentication', async () => {
  const objectPath = 'private_tour_photos/TOUR_1/PASSENGER_1/read.jpg';
  await assertSucceeds(uploadBytes(
    ref(storageFor(OWNER_UID), objectPath),
    imageBytes,
    imageMetadataFor(OWNER_UID),
  ));

  await assertSucceeds(getBytes(ref(storageFor(FOREIGN_UID), objectPath)));
  await assertFails(getBytes(ref(
    testEnv.unauthenticatedContext().storage(BUCKET_URL),
    objectPath,
  )));
});
