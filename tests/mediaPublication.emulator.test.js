'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) throw new Error('Loopback database emulator required');
const projectId = 'demo-llt-media-publication';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
const admin = require('../functions/node_modules/firebase-admin');
const { createMediaPublisher, commitMediaPublication, mediaOperationPaths, createScopedMediaChatPublisher } = require('../functions/src/domains/media/mediaPublication');
const { derivePassengerAccountDeletionKey } = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), projectId);
const db = app.database();
const read = async path => (await db.ref(path).once('value')).val();
test.before(async () => installDemoDatabaseRules({ projectId }));
test.beforeEach(async () => db.ref().set(null));
test.after(async () => Promise.all(admin.apps.map(item => item.delete())));

async function seed(visibility = 'group', driver = false) {
  const sessionId = `sess_v1_${'a'.repeat(32)}`;
  const principalId = driver ? 'driver:D-TEST' : `pax_v2_${'b'.repeat(32)}`;
  const operation = { schemaVersion: 1, operationId: 'upload-one', authUid: 'device',
    sessionId, sessionRevision: 1, authorityEpoch: 'c'.repeat(48), principalId,
    role: driver ? 'assigned_driver' : 'passenger', visibility, tourId: 'TOUR', ownerKey: principalId,
    photoId: 'photo-one', storagePath: `${visibility}_tour_photos/TOUR/${visibility === 'private' ? `${principalId}/` : ''}photo-one.jpg`,
    bookingRef: 'BOOK', sourceTourId: 'TOUR', passengerDeletionKey: derivePassengerAccountDeletionKey('BOOK'),
    expiresAtMs: Date.now() + 120000, state: 'pending' };
  Object.assign(operation, mediaOperationPaths(operation));
  const session = { schemaVersion: 1, authUid: 'device', sessionId, sessionRevision: 1,
    principalType: driver ? 'driver' : 'passenger', principalId, tourId: 'TOUR', status: 'active',
    issuedAtMs: Date.now() - 1000, lastAuthenticatedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 3600000, ...(driver ? { driverId: 'D-TEST', driverLoginPolicyGeneration: 1 } : {}) };
  await db.ref().update({
    'tours/TOUR': { name: 'Synthetic media test', participants: { device: { schemaVersion: 2, sessionId, principalId,
      userId: 'device', joinedAtMs: Date.now(), sessionExpiresAtMs: session.expiresAtMs } } },
    'passenger_identity_security/BOOK': { deviceAuthorizationVersion: 2, passengerPrincipalId: principalId, authorizedAuthUids: { device: true } },
    'users/device': { principalType: driver ? 'driver' : 'passenger', stablePassengerId: principalId,
      stablePassengerKey: principalId, identityVersion: 'pax_v2', privatePhotoOwnerId: principalId,
      privatePhotoOwnerKey: principalId, bookingRef: 'BOOK', ...(driver ? { driverId: 'D-TEST', driverPrincipalId: principalId, driverAssignedTourId: 'TOUR' } : {}) },
    'bookings/BOOK': { tourId: 'TOUR' }, 'app_sessions/device': session,
    'app_session_authority/device': { schemaVersion: 1, state: 'committed', epoch: operation.authorityEpoch, sessionId },
    [operation.operationPath]: operation, [operation.lockPath]: { owner: 'lock-owner', expiresAtMs: Date.now() + 120000 },
    ...(driver ? { 'driver_device_authorizations/device': { schemaVersion: 1, state: 'active', driverId: 'D-TEST', sessionId, generation: 'd'.repeat(48) },
      'driver_staff_policy/D-TEST': { schemaVersion: 1, generation: 'd'.repeat(48) },
      'driver_login_policy/v1': { schemaVersion: 1, generation: 1, revision: 1, updatedAtMs: Date.now(), enforceSingleDevice: false, transitionPhase: 'stable' },
      'drivers/D-TEST': { currentTourId: 'TOUR', authUid: 'device', authUidStaffGeneration: 'd'.repeat(48) }, 'tour_manifests/TOUR/assigned_drivers/D-TEST': true } : {}),
  });
  const record = { userId: principalId, storagePath: operation.storagePath, timestamp: Date.now(),
    _upload: { operationId: operation.operationId, authUid: operation.authUid, status: 'pending' } };
  return { operation, record, lockOwner: 'lock-owner', db };
}

for (const visibility of ['group', 'private']) test(`${visibility} reserves hidden metadata then atomically finalizes only its exact operation`, async () => {
  const args = await seed(visibility);
  await commitMediaPublication({ ...args, phase: 'reserve' });
  assert.equal((await read(args.operation.recordPath))._upload.status, 'pending');
  await commitMediaPublication({ ...args, phase: 'finalize', record: { ...args.record, _upload: { ...args.record._upload, status: 'complete' } } });
  assert.equal((await read(args.operation.operationPath)).state, 'committed');
  assert.equal((await read(args.operation.recordPath))._upload.status, 'complete');
});

for (const enforceSingleDevice of [false, true]) test(`current approved driver completes media publication with single-device policy ${enforceSingleDevice}`, async () => {
  const args = await seed('group', true);
  await db.ref('driver_login_policy/v1/enforceSingleDevice').set(enforceSingleDevice);
  await commitMediaPublication({ ...args, phase: 'reserve' });
  await commitMediaPublication({ ...args, phase: 'finalize', record: { ...args.record, _upload: { ...args.record._upload, status: 'complete' } } });
  assert.equal((await read(args.operation.operationPath)).state, 'committed');
});

const driverSupersessions = ['staff-revocation', 'assignment-false', 'assignment-malformed', 'policy-transition', 'policy-malformed', 'staff-claim-replaced'];
for (const phase of ['reserve', 'finalize']) {
  for (const supersession of ['logout', 'deletion', 'sibling-deletion', 'transfer', 'tour-deletion', 'lock-replacement', 'cancel', ...driverSupersessions, 'authority-schema', 'session-schema']) {
    test(`queued ${phase} denied after ${supersession}`, async () => {
      const args = await seed('group', driverSupersessions.includes(supersession));
      if (phase === 'finalize') await commitMediaPublication({ ...args, phase: 'reserve' });
      let connection; let queued;
      const dispatched = new Promise(resolve => { queued = resolve; });
      const pending = commitMediaPublication({ ...args, phase,
        record: { ...args.record, _upload: { ...args.record._upload, status: phase === 'reserve' ? 'pending' : 'complete' } },
        createPublisher: options => {
          const publisher = createMediaPublisher(options); connection = publisher.db; connection.goOffline();
          return { ...publisher, db: { ref: () => ({ update: value => {
            const result = connection.ref().update(value); queued(); return result;
          } }) } };
        } });
      const outcome = pending.then(() => 'accepted', () => 'denied');
      await dispatched;
      const mutations = {
        logout: { 'app_session_authority/device/state': 'blocked' },
        deletion: { 'app_session_authority/device/state': 'deleted', [args.operation.recordPath]: null },
        'sibling-deletion': { [`account_deletion_passenger_active/v1/${args.operation.passengerDeletionKey}`]: { status: 'pending' } },
        transfer: { 'bookings/BOOK/tourId': 'OTHER' },
        'tour-deletion': { 'sync_roster_control/TOUR/lifecycle': { state: 'deleted', generation: 'new' }, [args.operation.recordPath]: null },
        'lock-replacement': { [`${args.operation.lockPath}/owner`]: 'successor' },
        cancel: { [`${args.operation.operationPath}/state`]: 'cancelled' },
        'staff-revocation': { 'driver_staff_policy/D-TEST/generation': 'e'.repeat(48) },
        'assignment-false': { 'driver_assignment_active/v1/D-TEST': false },
        'assignment-malformed': { 'driver_assignment_active/v1/D-TEST': { unexpected: true } },
        'policy-transition': { 'driver_login_policy/v1/transitionPhase': 'draining' },
        'policy-malformed': { 'driver_login_policy/v1/enforceSingleDevice': null },
        'staff-claim-replaced': { 'driver_login_policy/v1/enforceSingleDevice': true, 'drivers/D-TEST/authUidStaffGeneration': 'e'.repeat(48) },
        'authority-schema': { 'app_session_authority/device/schemaVersion': 0 },
        'session-schema': { 'app_sessions/device/schemaVersion': 0 },
      };
      await db.ref().update(mutations[supersession]);
      const before = await read(args.operation.recordPath);
      connection.goOnline();
      assert.equal(await outcome, 'denied');
      assert.deepEqual(await read(args.operation.recordPath), before);
      assert.notEqual((await read(args.operation.operationPath)).state, 'committed');
    });
  }
}

test('ordinary token claims cannot become a media publisher', async () => {
  const args = await seed();
  const forged = admin.initializeApp({ ...app.options, databaseAuthVariableOverride: { uid: 'device',
    token: { lltMediaPublisher: true, mediaOperationId: args.operation.operationId, mediaPhase: 'reserve', mediaLockOwner: args.lockOwner },
  } }, 'forged-media-publisher');
  await assert.rejects(forged.database().ref(args.operation.recordPath).set(args.record));
  await forged.delete();
});

for (const change of ['none', 'logout', 'photo-deletion', 'sibling-deletion']) test(`scoped photo chat publication: ${change}`, async () => {
  const args = await seed();
  const photo = { ...args.record, _upload: { ...args.record._upload, status: 'complete' } };
  await db.ref(args.operation.recordPath).set(photo);
  const session = await read('app_sessions/device');
  const publisher = await createScopedMediaChatPublisher({ db, authUid: 'device',
    access: { allowed: true, role: 'passenger', principalId: args.operation.principalId, session },
    tourId: 'TOUR', photoId: args.operation.photoId, photo });
  const message = { schemaVersion: 2, type: 'image', text: 'Synthetic caption', senderName: 'Synthetic',
    senderId: args.operation.principalId, senderStableId: args.operation.principalId,
    senderType: 'passenger', isDriver: false, timestamp: Date.now(), clientCreatedAt: Date.now(),
    status: 'sent', idempotencyKey: 'message-one', photoId: args.operation.photoId };
  try {
    if (change === 'none') {
      const result = await publisher.db.ref('chats/TOUR/messages/message-one').transaction(current => current || message);
      assert.equal(result.committed, true);
    } else {
      publisher.db.goOffline();
      const outcome = publisher.db.ref('chats/TOUR/messages/message-one').set(message).then(() => 'accepted', () => 'denied');
      if (change === 'logout') await db.ref('app_session_authority/device/state').set('blocked');
      else if (change === 'photo-deletion') await db.ref(args.operation.recordPath).remove();
      else await db.ref(`account_deletion_passenger_active/v1/${args.operation.passengerDeletionKey}`).set({ status: 'pending' });
      publisher.db.goOnline();
      assert.equal(await outcome, 'denied');
      assert.equal(await read('chats/TOUR/messages/message-one'), null);
    }
  } finally { await publisher.close(); }
});

// These normal-path cases deliberately distinguish read admission, ordinary set
// admission and capture of a populated tour generation from queued-write denial.
async function seedReadablePhotoPublisher({ withLifecycle = false, claims } = {}) {
  const args = await seed();
  if (withLifecycle) await db.ref('sync_roster_control/TOUR/lifecycle').set({ state: 'active', generation: 'synthetic-generation-1' });
  const photo = { ...args.record, _upload: { ...args.record._upload, status: 'complete' } };
  await db.ref(args.operation.recordPath).set(photo);
  const publisher = await createScopedMediaChatPublisher({ db, authUid: 'device', claims,
    access: { allowed: true, role: 'passenger', principalId: args.operation.principalId, session: await read('app_sessions/device') },
    tourId: 'TOUR', photoId: args.operation.photoId, photo });
  const message = { schemaVersion: 2, type: 'image', text: 'Synthetic caption', senderName: 'Synthetic',
    senderId: args.operation.principalId, senderStableId: args.operation.principalId,
    senderType: 'passenger', isDriver: false, timestamp: Date.now(), clientCreatedAt: Date.now(),
    status: 'sent', idempotencyKey: 'message-normal', photoId: args.operation.photoId };
  return { publisher, message, ref: publisher.db.ref('chats/TOUR/messages/message-normal') };
}

test('scoped photo chat normal admission: exact message read before publication', async () => {
  const { publisher, ref } = await seedReadablePhotoPublisher();
  try { assert.equal((await ref.once('value')).val(), null); }
  finally { await publisher.close(); }
});

test('scoped photo chat normal admission: ordinary set with absent lifecycle generation', async () => {
  const { publisher, ref, message } = await seedReadablePhotoPublisher();
  try {
    await ref.set(message);
    assert.deepEqual(await read('chats/TOUR/messages/message-normal'), message);
  } finally { await publisher.close(); }
});

test('scoped photo chat normal admission: read and transaction with captured lifecycle generation', async () => {
  const { publisher, ref, message } = await seedReadablePhotoPublisher({ withLifecycle: true });
  try {
    assert.equal((await ref.once('value')).val(), null);
    const result = await ref.transaction(current => current || message);
    assert.equal(result.committed, true);
    assert.deepEqual(await read('chats/TOUR/messages/message-normal'), message);
  } finally { await publisher.close(); }
});

test('scoped photo chat normal admission: verified anonymous token namespace', async () => {
  const { publisher, ref, message } = await seedReadablePhotoPublisher({
    claims: { sub: 'device', user_id: 'device', firebase: { sign_in_provider: 'anonymous', identities: {} } },
  });
  try {
    assert.equal((await ref.once('value')).val(), null);
    const result = await ref.transaction(current => current || message);
    assert.equal(result.committed, true);
    assert.deepEqual(await read('chats/TOUR/messages/message-normal'), message);
  } finally { await publisher.close(); }
});

test('photo chat rejects path separators, reserved key characters and control characters', async () => {
  const { publisher, ref, message } = await seedReadablePhotoPublisher();
  try {
    for (const photoId of ['other/photo', 'other.photo', 'other#photo', 'other$photo', 'other[photo]', 'bad\u0000id', 'bad\u001fid', 'bad\u007fid']) {
      await assert.rejects(ref.set({ ...message, photoId }), /permission.denied/i);
      assert.equal(await read('chats/TOUR/messages/message-normal'), null);
    }
  } finally { await publisher.close(); }
});
