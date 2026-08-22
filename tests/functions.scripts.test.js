const test = require('node:test');
const assert = require('node:assert/strict');

const photoBackfill = require('../functions/scripts/backfillPhotoVariants');
const privatePhotoHardening = require('../functions/scripts/hardenPrivatePhotoMedia');

test('photo variant backfill selects missing or failed server variants', () => {
  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: null,
  }, { retryFailed: true }), true);

  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: 'https://example.test/thumb.jpg',
    variantStatus: 'failed',
  }, { retryFailed: true }), true);

  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: 'https://example.test/thumb.jpg',
    variantStatus: 'failed',
  }, { retryFailed: false }), false);

  assert.equal(photoBackfill.shouldBackfill({
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: null,
  }, { retryFailed: true }), false);

  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: 'https://example.test/thumb.jpg',
    variantStatus: 'ready',
  }, { retryFailed: false, force: true }), true);
  assert.equal(
    photoBackfill.parseArgs(['--refresh-group-ownership=true']).refreshGroupOwnership,
    true,
  );
});

test('group ownership refresh uses a bounded exact-tour cursor page', async () => {
  const calls = [];
  const query = {
    orderByKey: () => { calls.push('orderByKey'); return query; },
    startAt: (key) => { calls.push(['startAt', key]); return query; },
    limitToFirst: (limit) => { calls.push(['limitToFirst', limit]); return query; },
    once: async () => ({ val: () => ({
      B: { storagePath: 'group_tour_photos/TOUR_1/B.jpg' },
      a: { storagePath: 'group_tour_photos/TOUR_1/a.jpg' },
      z: { storagePath: 'group_tour_photos/TOUR_1/z.jpg' },
    }) }),
  };
  const result = await photoBackfill.collectGroupCandidates({
    db: { ref: (path) => { assert.equal(path, 'group_tour_photos/TOUR_1'); return query; } },
    tourId: 'TOUR_1',
    remaining: 1,
    retryFailed: false,
    refreshGroupOwnership: true,
    afterCursor: 'B',
  });
  assert.deepEqual(result.candidates.map(({ photoId }) => photoId), ['a']);
  assert.equal(result.nextCursor, 'a');
  assert.deepEqual(calls, ['orderByKey', ['startAt', 'B'], ['limitToFirst', 3]]);
  assert.throws(() => photoBackfill.validateOptions({
    refreshGroupOwnership: true, visibility: 'all', tourId: 'TOUR_1', dryRun: true,
  }), /requires --visibility=group/);
});

test('private photo hardening is dry-run first and selects only exact private paths and URL fields', () => {
  assert.equal(privatePhotoHardening.parseArgs([]).dryRun, true);
  assert.equal(privatePhotoHardening.parseArgs(['--apply']).dryRun, false);
  const candidate = privatePhotoHardening.buildCandidate({
    tourId: 'TOUR_1', ownerKey: 'owner-1', photoId: 'photo-1',
    record: {
      sourceUrl: 'https://firebasestorage.test/token',
      storagePath: 'private_tour_photos/TOUR_1/owner-1/source.jpg',
      viewerStoragePath: 'private_tour_photos/TOUR_1/other-owner/viewer.jpg',
    },
  });
  assert.deepStrictEqual(candidate.urlFields, ['sourceUrl']);
  assert.deepStrictEqual(candidate.objectPaths, ['private_tour_photos/TOUR_1/owner-1/source.jpg']);
});

test('private photo hardening apply revokes tokens and removes durable URL fields', async () => {
  const metadataWrites = [];
  const dbUpdates = [];
  const records = { photo: {
    sourceUrl: 'https://token.test/source',
    viewerUrl: 'https://token.test/viewer',
    storagePath: 'private_tour_photos/TOUR_1/owner/source.jpg',
    viewerStoragePath: 'private_tour_photos/TOUR_1/owner/viewer.jpg',
  } };
  const ownerRef = {
    orderByKey: () => ownerRef,
    limitToFirst: () => ownerRef,
    once: async () => ({ val: () => records }),
    child: (photoId) => ({ update: async (updates) => dbUpdates.push({ photoId, updates }) }),
  };
  const admin = {
    database: () => ({ ref: () => ownerRef }),
    storage: () => ({ bucket: () => ({ file: (path) => ({
      setMetadata: async (metadata) => metadataWrites.push({ path, metadata }),
    }) }) }),
  };
  await privatePhotoHardening.run({ admin, options: {
    dryRun: false, tourId: 'TOUR_1', ownerKey: 'owner', limit: 50, afterCursor: null,
  } });
  assert.equal(metadataWrites.length, 2);
  assert.deepStrictEqual(dbUpdates, [{
    photoId: 'photo',
    updates: { sourceUrl: null, viewerUrl: null },
  }]);
});

test('private photo hardening pages at the exact owner query and advances across mixed keys', async () => {
  const calls = [];
  const query = {
    orderByKey: () => { calls.push('orderByKey'); return query; },
    startAt: (key) => { calls.push(['startAt', key]); return query; },
    limitToFirst: (limit) => { calls.push(['limitToFirst', limit]); return query; },
    once: async () => ({ val: () => ({ B: {}, a: {}, 'z-1': {} }) }),
  };
  const first = await privatePhotoHardening.readPhotoPage({ ownerRef: query, afterCursor: null, limit: 1 });
  assert.deepStrictEqual(Object.keys(first.records), ['B']);
  assert.equal(first.nextCursor, 'B');
  const second = await privatePhotoHardening.readPhotoPage({ ownerRef: query, afterCursor: first.nextCursor, limit: 1 });
  assert.deepStrictEqual(Object.keys(second.records), ['a']);
  assert.deepStrictEqual(calls.slice(-3), ['orderByKey', ['startAt', 'B'], ['limitToFirst', 3]]);
});

test('private photo hardening treats missing objects as success but fails other Storage errors', async () => {
  const makeAdmin = (error) => {
    const ownerRef = {
      orderByKey: () => ownerRef,
      limitToFirst: () => ownerRef,
      once: async () => ({ val: () => ({ photo: {
        sourceUrl: 'https://token.test/source',
        storagePath: 'private_tour_photos/T/O/source.jpg',
      } }) }),
      child: () => ({ update: async () => {} }),
    };
    return {
      database: () => ({ ref: () => ownerRef }),
      storage: () => ({ bucket: () => ({ file: () => ({ setMetadata: async () => { throw error; } }) }) }),
    };
  };
  const options = { dryRun: false, tourId: 'T', ownerKey: 'O', limit: 10, afterCursor: null };
  await assert.doesNotReject(privatePhotoHardening.run({ admin: makeAdmin({ code: 404 }), options }));
  await assert.rejects(privatePhotoHardening.run({ admin: makeAdmin({ code: 500 }), options }));
});

test('photo variant backfill apply runs require explicit broad-scan approval', () => {
  assert.throws(
    () => photoBackfill.validateOptions({ dryRun: false, tourId: null, allowFullScan: false }),
    /Refusing to apply/,
  );
  assert.doesNotThrow(
    () => photoBackfill.validateOptions({ dryRun: false, tourId: 'TOUR_1', allowFullScan: false }),
  );
  assert.throws(
    () => photoBackfill.validateOptions({
      dryRun: true,
      visibility: 'group',
      tourId: 'TOUR_1',
      ownerKey: 'owner-1',
    }),
    /ownerKey/,
  );
});
