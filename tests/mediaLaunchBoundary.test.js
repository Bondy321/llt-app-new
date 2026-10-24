'use strict';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-media-unit', storageBucket: 'demo-media-unit.appspot.com' });
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const sharp = createRequire(resolve(__dirname, '../functions/package.json'))('sharp');
const { validateDecodedImage, MAX_IMAGE_BYTES } = require('../functions/src/domains/media/mediaImageValidation');
const { signCurrentMedia } = require('../functions/src/domains/media/mediaOperationBoundary');
const deferred = () => { let done; const promise = new Promise(resolve => { done = resolve; }); return { promise, resolve: done }; };

test('real image decoder validates JPEG/PNG/WebP and rejects declared MIME mismatch, corrupt bytes and decoded dimension overflow', async () => {
  for (const [format, type] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const body = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#4477aa' } })[format]().toBuffer();
    assert.deepEqual(await validateDecodedImage(body, type), { width: 3, height: 2, format });
    await assert.rejects(validateDecodedImage(body, type === 'image/jpeg' ? 'image/png' : 'image/jpeg'), { code: 'INVALID_IMAGE' });
    await assert.rejects(validateDecodedImage(body.subarray(0, Math.floor(body.length / 2)), type), { code: 'INVALID_IMAGE' });
  }
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#000000' } }).png().toBuffer();
  await assert.rejects(validateDecodedImage(wide, 'image/png'), { code: 'INVALID_IMAGE' });
  await assert.rejects(validateDecodedImage(Buffer.from('not an image'), 'image/jpeg'), { code: 'INVALID_IMAGE' });
  await assert.rejects(validateDecodedImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/jpeg'), { code: 'INVALID_IMAGE' });
});

test('decode rejects pixel bombs, animations and codec mismatch before pixel processing', async () => {
  for (const metadata of [{ format: 'png', width: 8192, height: 8192 }, { format: 'png', width: 2, height: 2, pages: 2 }, { format: 'heif', width: 2, height: 2, compression: 'av1' }]) {
    let decoded = false; let destroyed = false;
    await assert.rejects(validateDecodedImage(Buffer.from('fixture'), metadata.format === 'heif' ? 'image/heic' : 'image/png', {
      loadSharp: () => () => ({ metadata: async () => metadata, stats: async () => { decoded = true; }, destroy: () => { destroyed = true; } }),
    }), { code: 'INVALID_IMAGE' });
    assert.equal(decoded, false); assert.equal(destroyed, true);
  }
});

const access = { allowed: true, role: 'passenger', principalId: 'pax-synthetic', session: { sessionId: 'session-a', sessionRevision: 1 } };
const record = { userId: 'pax-synthetic', idempotencyKey: 'upload-a', storagePath: 'private_tour_photos/TOUR/pax-synthetic/photo-a.jpg' };
test('a delayed signing operation cannot issue new media after logout, same-principal session replacement or revision change', async () => {
  for (const revoked of [{ allowed: false }, { ...access, session: { sessionId: 'session-b', sessionRevision: 1 } }, { ...access, session: { ...access.session, sessionRevision: 2 } }]) {
    const gate = deferred(); let current = access;
    const pending = signCurrentMedia({ access, records: { photo: record }, readAccess: async () => current,
      readRecords: async () => ({ photo: record }), sign: async () => { await gate.promise; return { photo: { sourceUrl: 'https://synthetic.invalid/signed' } }; } });
    current = revoked; gate.resolve();
    assert.deepEqual(await pending, { allowed: false, media: {} });
  }
});
test('signing filters upload/deletion claims and drops records replaced or removed while the URL is generated', async () => {
  let signed;
  const outcome = await signCurrentMedia({ access, records: { keep: record, deleted: record, replaced: record,
    deleting: { ...record, _serverDeletion: { status: 'deleting' } }, pending: { ...record, _upload: { status: 'pending' } } },
    readAccess: async () => access,
    readRecords: async () => ({ keep: record, replaced: { ...record, storagePath: 'replacement' } }),
    sign: async records => { signed = Object.keys(records); return Object.fromEntries(signed.map(id => [id, { sourceUrl: `https://synthetic.invalid/${id}` }])); },
  });
  assert.deepEqual(signed, ['keep', 'deleted', 'replaced']);
  assert.deepEqual(outcome, { allowed: true, media: { keep: { sourceUrl: 'https://synthetic.invalid/keep' } } });
});

const { performMediaUpload, assertMediaUploadSettled } = require('../functions/src/domains/media/mediaUploadOperation');
const { cleanupMediaUploadOperation, installCancellationSentinel } = require('../functions/src/domains/media/mediaUploadCleanup');
const memoryDb = () => {
  const data = {}; const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const read = path => path.split('/').filter(Boolean).reduce((node, key) => node?.[key], data) ?? null;
  const write = (path, value) => {
    const keys = path.split('/').filter(Boolean); let node = data;
    for (const key of keys.slice(0, -1)) node = node[key] ||= {};
    if (value === null) delete node[keys.at(-1)]; else node[keys.at(-1)] = clone(value);
  };
  const snapshot = value => ({ val: () => clone(value), exists: () => value !== null });
  return { data, read, ref: (path = '') => ({ once: async () => snapshot(read(path)),
    set: async value => write(path, value), remove: async () => write(path, null),
    update: async updates => { for (const [key, value] of Object.entries(updates)) write([path, key].filter(Boolean).join('/'), value); },
    transaction: async fn => { const proposed = fn(clone(read(path))); if (proposed !== undefined) write(path, proposed);
      return { committed: proposed !== undefined, snapshot: snapshot(read(path)) }; },
  }) };
};
const memoryBucket = () => {
  const objects = new Map(); let generation = 0; let beforeSave = async () => {};
  return { objects, delay: fn => { beforeSave = fn; }, file: path => ({
    getMetadata: async () => { const current = objects.get(path); if (!current) throw Object.assign(new Error('Missing'), { code: 404 });
      return [{ ...current.metadata, generation: current.generation, size: String(current.body.length) }]; },
    save: async (body, options) => { await beforeSave(body); const current = objects.get(path);
      const expected = options.preconditionOpts.ifGenerationMatch;
      if ((String(expected) === '0' && current) || (String(expected) !== '0' && String(expected) !== current?.generation)) throw Object.assign(new Error('Precondition failed'), { code: 412 });
      objects.set(path, { body, metadata: options.metadata, generation: String(++generation) }); },
  }) };
};
const uploadArguments = (db, bucket) => ({ db, bucket, input: { tourId: 'TOUR', idempotencyKey: 'photo-one', caption: 'Synthetic', uploaderName: 'Synthetic' },
  access, authUid: 'device', visibility: 'group', body: Buffer.from('synthetic bytes previously decoded by handler'), contentType: 'image/jpeg', lockOwner: 'lock',
  now: () => 100, readAccess: async () => access,
  captureAuthority: async () => ({ tourGeneration: null, authorityEpoch: 'a'.repeat(48), sessionId: 'session-a', sessionRevision: 1 }),
  publish: async ({ operation, record: next, phase }) => {
    await db.ref().update({ [operation.recordPath]: next, [`${operation.operationPath}/state`]: phase === 'reserve' ? 'reserved' : 'committed',
      ...(phase === 'finalize' ? { [`media_upload_cleanup_queue/${operation.operationId}`]: null } : {}) });
  },
});

test('upload persists recovery before source bytes and publishes only after exact finalization; retry never writes twice', async () => {
  const db = memoryDb(); const bucket = memoryBucket(); const args = uploadArguments(db, bucket);
  bucket.delay(async () => {
    const [operation] = Object.values(db.read('media_upload_operations/device'));
    assert.equal(operation.state, 'reserved');
    assert.equal(db.read(operation.recordPath)._upload.status, 'pending');
    assert.equal(db.read(`media_upload_cleanup_queue/${operation.operationId}`).authUid, 'device');
  });
  const first = await performMediaUpload(args);
  assert.equal(db.read(`group_tour_photos/TOUR/${first.photoId}`)._upload.status, 'complete');
  assert.equal((await performMediaUpload(args)).deduped, true);
  assert.equal(bucket.objects.size, 1);
  await assert.rejects(performMediaUpload({ ...args, body: Buffer.from('different bytes') }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('revocation while storage save is delayed leaves durable cancellation; expiry sentinel rejects late original save', async () => {
  const db = memoryDb(); const bucket = memoryBucket(); const args = uploadArguments(db, bucket);
  const gate = deferred(); let saving; const entered = new Promise(resolve => { saving = resolve; });
  bucket.delay(async body => { if (body.length) { saving(); await gate.promise; } });
  const pending = performMediaUpload({ ...args, publish: async options => {
    if (options.phase === 'finalize') throw Object.assign(new Error('Revoked at server commit'), { code: 'MEDIA_AUTHORITY_CHANGED' });
    return args.publish(options);
  } });
  await entered;
  const [operation] = Object.values(db.read('media_upload_operations/device'));
  await assert.rejects(assertMediaUploadSettled({ db, record: db.read(operation.recordPath) }), { code: 'MEDIA_UPLOAD_IN_PROGRESS' });
  assert.equal(await cleanupMediaUploadOperation({ db, bucket, authUid: 'device', operationId: operation.operationId, nowMs: operation.expiresAtMs - 1 }), 'waiting');
  assert.equal(await cleanupMediaUploadOperation({ db, bucket, authUid: 'device', operationId: operation.operationId, nowMs: operation.expiresAtMs + 1 }), 'cleaned');
  gate.resolve(); await assert.rejects(pending, { code: 412 });
  assert.equal(bucket.objects.get(operation.storagePath).body.length, 0);
  assert.equal(bucket.objects.get(operation.storagePath).metadata.metadata.cancelled, 'true');
  assert.equal(db.read(operation.recordPath), null);
  assert.equal(db.read(operation.operationPath).state, 'cleaned');
  assert.equal(db.read(`media_upload_cleanup_queue/${operation.operationId}`), null);
  bucket.delay(async () => {});
  const recovered = await performMediaUpload({ ...args, now: () => operation.expiresAtMs + 2 });
  assert.notEqual(recovered.storagePath, operation.storagePath);
  assert.equal(recovered.photoId, operation.photoId);
  assert.equal(bucket.objects.get(operation.storagePath).body.length, 0);
  assert.equal(bucket.objects.get(recovered.storagePath).body.toString(), args.body.toString());
});

test('cancelled cleanup never replaces another operation storage object', async () => {
  const bucket = memoryBucket(); const operation = { storagePath: 'group_tour_photos/TOUR/photo.jpg', authUid: 'device', operationId: 'old' };
  await bucket.file(operation.storagePath).save(Buffer.from('successor'), { preconditionOpts: { ifGenerationMatch: 0 }, metadata: { metadata: { uploadOperationId: 'new', authUid: 'device' } } });
  await assert.rejects(installCancellationSentinel({ bucket, operation }), /ownership changed/);
  assert.equal(bucket.objects.get(operation.storagePath).body.toString(), 'successor');
});

const { processPhotoVariantObject } = require('../functions/src/domains/media/photoVariantFunction');
test('storage events never generate variants for pending publications or cancellation tombstones', async () => {
  const db = memoryDb(); const bucket = memoryBucket(); const args = uploadArguments(db, bucket);
  const gate = deferred(); let saving; const entered = new Promise(resolve => { saving = resolve; });
  bucket.delay(async body => { if (body.length) { saving(); await gate.promise; } });
  const pending = performMediaUpload({ ...args, now: Date.now });
  await entered;
  const [operation] = Object.values(db.read('media_upload_operations/device'));
  const event = { data: { bucket: 'demo-bucket', name: operation.storagePath,
    metadata: { uploadOperationId: operation.operationId, authUid: 'device', sourceRole: 'source' } } };
  let generated = 0;
  const deps = { database: db, bucket, findPhotoRecordByStoragePathFn: async () => ({ photoId: operation.photoId, photoRecord: db.read(operation.recordPath) }),
    generatePhotoVariantsForRecordFn: async () => { generated += 1; return { status: 'ready' }; } };
  await assert.rejects(processPhotoVariantObject(event, deps), { code: 'PHOTO_VARIANT_RETRY' });
  assert.equal(generated, 0);
  await processPhotoVariantObject({ data: { ...event.data, metadata: { ...event.data.metadata, cancelled: 'true', sourceRole: 'cancelled' } } }, deps);
  assert.equal(generated, 0);
  gate.resolve(); await pending;
  await processPhotoVariantObject(event, deps);
  assert.equal(generated, 1);
});

const { retireVariantObject, saveVariantOnce } = require('../functions/src/domains/media/mediaVariantStorage');
test('deletion reserves even missing variant targets and blocks a delayed variant save', async () => {
  const bucket = memoryBucket(); const sourcePath = 'group_tour_photos/TOUR/photo-source.jpg';
  const path = 'group_tour_photos/TOUR/viewers/photo-source_viewer.jpg';
  const metadata = { contentType: 'image/jpeg', metadata: { sourcePath, sourceGeneration: 'source-1', sourceRole: 'viewer', visibility: 'group' } };
  const gate = deferred(); let saving; const entered = new Promise(resolve => { saving = resolve; });
  bucket.delay(async body => { if (body.length) { saving(); await gate.promise; } });
  const pending = saveVariantOnce({ file: bucket.file(path), buffer: Buffer.from('customer pixels'), metadata });
  await entered;
  await retireVariantObject({ bucket, path, expectedGeneration: 'missing', sourcePath });
  gate.resolve(); await assert.rejects(pending, { code: 412 });
  assert.equal(bucket.objects.get(path).body.length, 0);
  assert.equal(await retireVariantObject({ bucket, path, expectedGeneration: 'missing', sourcePath }), false);
});

test('variant retries only reuse exact source generation and never overwrite a successor', async () => {
  const bucket = memoryBucket(); const file = bucket.file('group_tour_photos/TOUR/viewers/source.jpg');
  const metadata = { contentType: 'image/jpeg', metadata: { sourcePath: 'source.jpg', sourceGeneration: 'one', sourceRole: 'viewer', visibility: 'group' } };
  assert.equal((await saveVariantOnce({ file, buffer: Buffer.from('pixels'), metadata })).created, true);
  assert.equal((await saveVariantOnce({ file, buffer: Buffer.from('pixels'), metadata })).created, false);
  await assert.rejects(saveVariantOnce({ file, buffer: Buffer.from('other'), metadata: { ...metadata, metadata: { ...metadata.metadata, sourceGeneration: 'two' } } }), { code: 412 });
});

test('a previously missing variant that arrives before deletion is retired only for the exact source generation', async () => {
  const bucket = memoryBucket(); const path = 'group_tour_photos/TOUR/viewers/source.jpg';
  const metadata = { contentType: 'image/jpeg', metadata: { sourcePath: 'source.jpg', sourceGeneration: 'one', sourceRole: 'viewer', visibility: 'group' } };
  await saveVariantOnce({ file: bucket.file(path), buffer: Buffer.from('pixels'), metadata });
  await assert.rejects(retireVariantObject({ bucket, path, expectedGeneration: 'missing', sourcePath: 'source.jpg', sourceGeneration: 'other', sourceRole: 'viewer', visibility: 'group' }), { code: 412 });
  await retireVariantObject({ bucket, path, expectedGeneration: 'missing', sourcePath: 'source.jpg', sourceGeneration: 'one', sourceRole: 'viewer', visibility: 'group' });
  assert.equal(bucket.objects.get(path).body.length, 0);
});
