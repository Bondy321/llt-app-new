'use strict';

const test = require('node:test');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
for (const name of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] || '')) throw new Error(`${name} must be a loopback emulator`);
}
const projectId = 'demo-llt-deletion-content';
const options = { projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`, storageBucket: `${projectId}.appspot.com` };
process.env.FIREBASE_CONFIG = JSON.stringify(options);
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const { issuePassengerAppSession } = require('../functions/src/domains/app-sessions/sessionIssuance');
const { reserveAccountDeletion, readAccountDeletionStatusRecord, projectValidatedStatusResponse, getAccountDeletionStatus } = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const { deriveAccountDeletionId } = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const { processAccountDeletionJob } = require('../functions/src/domains/account-deletion/accountDeletionWorker');
const { deleteOwnedGroupPhotoRecord } = require('../functions/src/domains/media/groupMediaFunctions');
const writer = admin.initializeApp(options, 'deletion-content-fixtures');
const db = writer.database();
const bucket = writer.storage().bucket();
const auth = writer.auth();
const uid = 'synthetic-content-deleting';
const siblingUid = 'synthetic-content-sibling';
const tourId = 'SYNTHETIC_CONTENT_TOUR';
const bookingRef = 'SYNTHETIC_CONTENT_BOOKING';
const principalId = `pax_v2_${'a'.repeat(32)}`;
const receipt = `delrec_v1_${'b'.repeat(64)}`;
const deletionId = deriveAccountDeletionId(receipt);
const read = async path => (await db.ref(path).get()).val();
const bytes = label => Buffer.from(`synthetic-owned-object:${label}`);
const save = (path, label) => bucket.file(path).save(bytes(label), { resumable: false, contentType: 'application/octet-stream' });
const issue = authUid => issuePassengerAppSession({ db, authUid, principalId, tourId, bookingRef,
  identityUpdates: {
    [`users/${authUid}/bookingRef`]: bookingRef, [`users/${authUid}/stablePassengerId`]: principalId,
    [`users/${authUid}/stablePassengerKey`]: principalId, [`users/${authUid}/privatePhotoOwnerKey`]: principalId,
    [`users/${authUid}/identityVersion`]: 'pax_v2', [`identity_bindings/${principalId}/${authUid}`]: true,
    [`passenger_identity_security/${bookingRef}/deviceAuthorizationVersion`]: 2,
    [`passenger_identity_security/${bookingRef}/authorizedAuthUids/${authUid}`]: true,
  }, grantUpdates: {} });

test.before(async () => {
  await installDemoDatabaseRules({ projectId });
  await db.ref().set({
    tours: { [tourId]: { name: 'Synthetic preserved tour', isActive: true } },
    bookings: { [bookingRef]: { tourId, passengerNames: ['Synthetic business row'], manualNotes: 'preserve' } },
    tour_manifests: { [tourId]: { bookings: { [bookingRef]: { seatNumbers: '1', passengerStatusCodes: 'B' } } } },
    source_booking_history: { [bookingRef]: { previousTour: 'SYNTHETIC_OLD' } },
    passenger_identity_security: { [bookingRef]: { passengerPrincipalId: principalId, passengerIdentityVersion: 'pax_v2' } },
  });
  await auth.createUser({ uid }); await auth.createUser({ uid: siblingUid });
});
test.after(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

test('real content deletion retries interruption, drains all chat pages, preserves sibling/business data and deletes Auth last', async () => {
  const session = await issue(uid); const sibling = await issue(siblingUid);
  const business = await Promise.all(['bookings', 'tour_manifests', 'source_booking_history'].map(read));
  const ownedPaths = [];
  for (const visibility of ['group', 'private']) {
    const prefix = visibility === 'group' ? `group_tour_photos/${tourId}` : `private_tour_photos/${tourId}/${principalId}`;
    const record = { userId: principalId };
    for (const [field, directory] of [['storagePath', 'originals'], ['viewerStoragePath', 'viewers'], ['thumbnailStoragePath', 'thumbnails']]) {
      const path = `${prefix}/${directory}/owned.jpg`; record[field] = path; ownedPaths.push(path);
      await save(path, `${visibility}-${directory}`);
      assert.deepEqual((await bucket.file(path).download())[0], bytes(`${visibility}-${directory}`));
    }
    await db.ref(`${prefix}/owned`).set(record);
  }
  const foreignPath = `group_tour_photos/${tourId}/foreign.jpg`;
  await save(foreignPath, 'foreign-preserved');
  await db.ref(`group_tour_photos/${tourId}/foreign`).set({ userId: 'synthetic-other-owner', storagePath: foreignPath });
  const messages = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`m${String(index).padStart(3, '0')}`, {
    senderId: principalId, senderStableId: principalId, senderName: 'Synthetic passenger', senderType: 'passenger',
    text: `Private synthetic text ${index}`, type: 'text', timestamp: new Date().toISOString(),
  }]));
  messages.z_foreign = { senderId: 'foreign-owner', senderName: 'Synthetic foreign', text: 'Keep this',
    timestamp: new Date().toISOString(), reactions: { like: { [principalId]: true, 'foreign-owner': true } } };
  await db.ref(`chats/${tourId}/messages`).set(messages);
  await db.ref(`notification_mutation_authority/${uid}`).set({ state: 'committed', bookingRef, sourceTourId: tourId, passengerDeletionKey: 'private-captured-key' });
  await db.ref('driver_enrolments').set(Object.fromEntries(Array.from({ length: 55 }, (_, index) => [
    `synthetic-proof-${index}`, { schemaVersion: 1, authUid: uid, state: 'redeemed', driverId: 'SYNTHETIC_DRIVER',
      redemptionId: 'private-link', installationEpoch: 'private-epoch', createdBy: 'synthetic-admin', expiresAtMs: Date.now() + 60000 },
  ])));
  await db.ref(`driver_device_authorizations/${uid}`).set({ schemaVersion: 1, state: 'active', driverId: 'SYNTHETIC_DRIVER' });
  const admission = await reserveAccountDeletion({ db, authUid: uid,
    input: { expectedSessionId: session.sessionId, deletionReceipt: receipt }, deletionId });
  assert.equal(admission.status, 202);
  let interrupted = false; let authDeleted = false; let now = Date.now(); let chatPages = 0;
  // Only the fault boundary is instrumented. Metadata, bytes, generations, queue,
  // transactions, reservations and Auth deletion all use their real SDKs.
  const faultBucket = { file: path => {
    const file = bucket.file(path);
    return new Proxy(file, { get(target, key) {
      if (key === 'delete') return async options => {
        if (!interrupted) { interrupted = true; throw Object.assign(new Error('synthetic network interruption'), { code: 503 }); }
        return target.delete(options);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
  } };
  const observedAuth = { deleteUser: async deletingUid => {
    assert.equal(deletingUid, uid);
    assert.equal(await read(`group_tour_photos/${tourId}/owned`), null);
    assert.equal(await read(`private_tour_photos/${tourId}/${principalId}/owned`), null);
    assert.equal(await read(`users/${uid}`), null);
    assert.equal(await read(`notification_mutation_authority/${uid}`), null);
    assert.equal(await read(`driver_device_authorizations/${uid}`), null);
    const proofAudit = await read('driver_enrolments');
    assert.equal(Object.keys(proofAudit).length, 55);
    for (const proof of Object.values(proofAudit)) {
      assert.equal(proof.state, 'revoked'); assert.equal(proof.authUid, undefined);
      assert.equal(proof.redemptionId, undefined); assert.equal(proof.installationEpoch, undefined);
    }
    assert.equal((await read(`notification_device_tombstones/${uid}`)).permanent, true);
    assert.ok(Object.values(await read(`chats/${tourId}/messages`)).filter(row => row.senderId === 'account_deleted').length === 105);
    for (const path of ownedPaths) {
      if (path.includes('/originals/')) assert.equal((await bucket.file(path).exists())[0], false);
      else {
        assert.equal((await bucket.file(path).download())[0].length, 0);
        assert.equal((await bucket.file(path).getMetadata())[0].metadata.cancelled, 'true');
      }
    }
    await auth.deleteUser(deletingUid); authDeleted = true;
  } };
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const current = await readAccountDeletionStatusRecord({ db, deletionId });
    if (current.status === 'completed') break;
    if (current.phase === 'chat_scrub') chatPages += 1;
    const result = await processAccountDeletionJob({ db, bucket: faultBucket, auth: observedAuth, deletionId, nowMs: now, clock: () => now });
    if (!result.processed) {
      assert.equal(interrupted, true);
      assert.equal(authDeleted, false);
      assert.equal((await auth.getUser(uid)).uid, uid);
      assert.equal(current.phase, 'group_media', JSON.stringify(result));
      assert.ok((await read(`group_tour_photos/${tourId}/owned`))?._serverDeletion);
      now += 31_000;
    } else now += 1;
  }
  assert.equal(interrupted, true); assert.equal(authDeleted, true); assert.ok(chatPages > 1);
  await assert.rejects(auth.getUser(uid), error => error.code === 'auth/user-not-found');
  assert.equal((await auth.getUser(siblingUid)).uid, siblingUid);
  assert.equal((await read(`app_sessions/${siblingUid}`)).sessionId, sibling.sessionId);
  assert.equal(await read(`passenger_identity_security/${bookingRef}/authorizedAuthUids/${siblingUid}`), true);
  assert.deepEqual(await Promise.all(['bookings', 'tour_manifests', 'source_booking_history'].map(read)), business);
  assert.deepEqual((await bucket.file(foreignPath).download())[0], bytes('foreign-preserved'));
  assert.equal((await read(`chats/${tourId}/messages/z_foreign`)).text, 'Keep this');
  assert.deepEqual((await read(`chats/${tourId}/messages/z_foreign`)).reactions, { like: { 'foreign-owner': true } });
  // Same production receipt lookup/projection used by getAccountDeletionStatus,
  // after the original Auth user has been removed; no private scope is exposed.
  const completed = await readAccountDeletionStatusRecord({ db, deletionId });
  const response = projectValidatedStatusResponse(completed);
  assert.equal(response.status, 'completed');
  for (const secret of [uid, principalId, bookingRef, 'privateScope', 'actorKeys']) assert.equal(JSON.stringify(response).includes(secret), false);
  const freshAuthResponse = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(freshAuthResponse.status, 200);
  const freshAuth = await freshAuthResponse.json();
  const httpResult = {};
  const res = Object.assign(new EventEmitter(), { status: value => { httpResult.status = value; return res; },
    json: value => { httpResult.body = value; return value; }, set: () => res });
  await getAccountDeletionStatus({ method: 'POST', headers: { authorization: `Bearer ${freshAuth.idToken}` },
    body: { deletionReceipt: receipt } }, res);
  assert.equal(httpResult.status, 200);
  assert.deepEqual(httpResult.body, response);
  assert.equal((await read(`app_session_authority/${uid}`)).deletionPublication, undefined);
});

test('real Storage replacement is retained with generation-faithful boundary enforcement', async () => {
  const path = `group_tour_photos/${tourId}/generation-protected.jpg`;
  await save(path, 'old-generation');
  await db.ref(`group_tour_photos/${tourId}/generation-protected`).set({ userId: principalId, storagePath: path });
  let replaced = false;
  // Firebase Storage emulator omits GCS preconditions. Assert the production
  // request and enforce GCS semantics at this boundary; bytes/metadata are real.
  let conditionObserved = false;
  const conditionalBucket = { file: objectPath => {
    const file = bucket.file(objectPath);
    return new Proxy(file, { get(target, key) {
      if (key === 'delete') return async options => {
        assert.ok(options.ifGenerationMatch); conditionObserved = true;
        const [current] = await target.getMetadata();
        if (String(current.generation) !== String(options.ifGenerationMatch)) {
          throw Object.assign(new Error('Generation changed'), { code: 412 });
        }
        return target.delete(options);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
  } };
  await assert.rejects(deleteOwnedGroupPhotoRecord({ db, bucket: conditionalBucket, tourId, photoId: 'generation-protected',
    trustedOwnerKeys: [principalId], assertCanDelete: async () => {
      if (!replaced) { replaced = true; await save(path, 'replacement-generation'); }
    } }), error => error.code === 'MEDIA_OBJECT_CHANGED');
  assert.equal(conditionObserved, true);
  assert.deepEqual((await bucket.file(path).download())[0], bytes('replacement-generation'));
  assert.ok(await read(`group_tour_photos/${tourId}/generation-protected`));
});

test('pending upload blocks deletion and real Storage cancellation removes customer bytes', async () => {
  const { cleanupMediaUploadOperation } = require('../functions/src/domains/media/mediaUploadCleanup');
  const operationId = 'synthetic-cancelled-upload'; const photoId = 'pending-source';
  const storagePath = `group_tour_photos/${tourId}/${photoId}.jpg`;
  const operation = { schemaVersion: 1, operationId, authUid: uid, principalId,
    visibility: 'group', tourId, photoId, ownerKey: null, storagePath, state: 'reserved',
    createdAtMs: Date.now() - 300001, expiresAtMs: Date.now() - 1 };
  const recordPath = `group_tour_photos/${tourId}/${photoId}`;
  await db.ref().update({ [`media_upload_operations/${uid}/${operationId}`]: operation,
    [`media_upload_cleanup_queue/${operationId}`]: { authUid: uid, dueAtMs: operation.expiresAtMs },
    [recordPath]: { userId: principalId, storagePath, _upload: { operationId, authUid: uid, status: 'pending' } } });
  await assert.rejects(deleteOwnedGroupPhotoRecord({ db, bucket, tourId, photoId,
    trustedOwnerKeys: [principalId] }), error => error.code === 'MEDIA_UPLOAD_IN_PROGRESS');
  assert.equal(await cleanupMediaUploadOperation({ db, bucket, authUid: uid, operationId }), 'cleaned');
  assert.equal(await read(recordPath), null);
  assert.equal((await read(`media_upload_operations/${uid}/${operationId}`)).state, 'cleaned');
  assert.equal((await bucket.file(storagePath).download())[0].length, 0);
  const [metadata] = await bucket.file(storagePath).getMetadata();
  assert.equal(metadata.metadata.cancelled, 'true');
});

for (const action of ['disabled', 'revoked']) test(`receipt HTTP rejects a genuinely ${action} Auth emulator identity`, async () => {
  const created = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(created.status, 200);
  const identity = await created.json();
  const request = { method: 'POST', headers: { authorization: `Bearer ${identity.idToken}` }, body: { deletionReceipt: receipt } };
  const { verifyRequestAuthUid } = require('../functions/src/infrastructure/auth/requestAuth');
  assert.equal((await verifyRequestAuthUid(request)).success, true);
  if (action === 'disabled') await auth.updateUser(identity.localId, { disabled: true });
  else {
    // Firebase token auth_time and tokensValidAfterTime have one-second precision.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await auth.revokeRefreshTokens(identity.localId);
  }
  const output = {};
  const res = Object.assign(new EventEmitter(), { status: value => { output.status = value; return res; }, json: value => { output.body = value; return value; }, set: () => res });
  await getAccountDeletionStatus(request, res);
  assert.equal(output.status, 401);
  assert.equal((await verifyRequestAuthUid(request)).success, false);
});

// Capability diagnostic, deliberately separate from application acceptance.
// Passing this records the emulator limitation; it does not prove GCS fencing.
test('Storage emulator capability: generation preconditions are not implemented', async t => {
  const path = 'synthetic-capability/precondition-probe';
  await save(path, 'first');
  await bucket.file(path).save(bytes('second'), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
  assert.deepEqual((await bucket.file(path).download())[0], bytes('second'));
  t.diagnostic('EMULATOR_LIMITATION: ifGenerationMatch is ignored; isolated real GCS arrival acceptance remains required.');
  await bucket.file(path).delete();
});


test('tour deletion drains reserved uploads before prefix cleanup and retains cancellation fences', async () => {
  const { drainTourMediaForDeletion } = require('../functions/src/domains/media/tourMediaDeletion');
  const { deleteStoragePrefixes } = require('../functions/src/infrastructure/storage/storageDeletion');
  const scopedTour = 'SYNTHETIC_TOUR_MEDIA_DELETE';
  const operationId = 'tour-delayed-source'; const photoId = 'pending';
  const storagePath = `group_tour_photos/${scopedTour}/${photoId}.jpg`;
  const operationPath = `media_upload_operations/${uid}/${operationId}`;
  const now = Date.now();
  const operation = { schemaVersion: 1, operationId, authUid: uid, principalId, visibility: 'group',
    tourId: scopedTour, photoId, ownerKey: null, storagePath, state: 'reserved',
    createdAtMs: now, expiresAtMs: now + 300000 };
  await db.ref().update({ [operationPath]: operation,
    [`media_upload_cleanup_queue/${operationId}`]: { authUid: uid, dueAtMs: operation.expiresAtMs },
    [`group_tour_photos/${scopedTour}/${photoId}`]: { userId: principalId, storagePath,
      _upload: { operationId, authUid: uid, status: 'pending' } },
    [`sync_roster_control/${scopedTour}/lifecycle`]: { state: 'deleting', generation: 'fixture-generation' } });
  const privatePath = `private_tour_photos/${scopedTour}/${principalId}/source.jpg`;
  await save(privatePath, 'private-tour-content');
  await db.ref(`private_tour_photos/${scopedTour}/${principalId}/private`).set({ userId: principalId, storagePath: privatePath });
  await assert.rejects(drainTourMediaForDeletion({ db, bucket, tourId: scopedTour, nowMs: now }),
    error => error.code === 'STORAGE_CLEANUP_PENDING');
  await drainTourMediaForDeletion({ db, bucket, tourId: scopedTour, nowMs: operation.expiresAtMs + 1 });
  assert.equal((await bucket.file(privatePath).exists())[0], false);
  assert.equal(await read(`private_tour_photos/${scopedTour}/${principalId}/private`), null);
  const [before] = await bucket.file(storagePath).getMetadata();
  assert.equal(before.metadata.cancelled, 'true');
  assert.equal(before.size, '0');
  const orphanPath = `group_tour_photos/${scopedTour}/orphan.jpg`;
  await save(orphanPath, 'orphan-customer-bytes');
  await deleteStoragePrefixes({ bucket, prefixes: [`group_tour_photos/${scopedTour}/`] });
  assert.equal((await bucket.file(storagePath).getMetadata())[0].generation, before.generation);
  assert.equal((await bucket.file(storagePath).download())[0].length, 0);
  assert.equal((await bucket.file(orphanPath).exists())[0], false);
  assert.equal(await read(`group_tour_photos/${scopedTour}/${photoId}`), null);
});

test('moderation handler removes actual owned bytes with durable variant fences and preserves report audit', async () => {
  const { removeReportedPhoto } = require('../functions/src/domains/administration/administrationFunctions');
  const adminUid = 'synthetic-moderation-admin';
  await auth.createUser({ uid: adminUid });
  await db.ref(`admin_users/${adminUid}`).set(true);
  // Auth emulator deliberately accepts unsigned synthetic claims. This checks
  // the real handler/SDK boundary, not an actual end-user MFA ceremony.
  const seconds = Math.floor(Date.now() / 1000);
  const payload = { aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    sub: adminUid, user_id: adminUid, iat: seconds, exp: seconds + 3600, auth_time: seconds,
    firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp', identities: {} } };
  const token = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
  const source = 'group_tour_photos/SYNTHETIC_MODERATION/reported.jpg';
  await save(source, 'moderated-customer-bytes');
  await db.ref('group_tour_photos/SYNTHETIC_MODERATION/photo').set({ userId: principalId, storagePath: source });
  await db.ref('content_reports/synthetic-report').set({ contentType: 'group_photo', tourId: 'SYNTHETIC_MODERATION', contentId: 'photo', reason: 'Synthetic audit reason' });
  const output = {};
  const res = Object.assign(new EventEmitter(), { set: () => res,
    status: value => { output.status = value; return res; }, json: value => { output.body = value; return value; } });
  await removeReportedPhoto({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { reportId: 'synthetic-report' } }, res);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  assert.equal((await bucket.file(source).exists())[0], false);
  assert.equal(await read('group_tour_photos/SYNTHETIC_MODERATION/photo'), null);
  for (const path of ['group_tour_photos/SYNTHETIC_MODERATION/viewers/reported_viewer.jpg', 'group_tour_photos/SYNTHETIC_MODERATION/thumbnails/reported_thumb.jpg']) {
    const [metadata] = await bucket.file(path).getMetadata();
    assert.equal(metadata.metadata.cancelled, 'true');
    assert.equal((await bucket.file(path).download())[0].length, 0);
  }
  const report = await read('content_reports/synthetic-report');
  assert.equal(report.status, 'actioned'); assert.equal(report.reason, 'Synthetic audit reason');
});
