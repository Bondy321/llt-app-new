const test = require('node:test');
const assert = require('node:assert/strict');

const photoBackfill = require('../functions/scripts/backfillPhotoVariants');
const privatePhotoHardening = require('../functions/scripts/hardenPrivatePhotoMedia');
const groupPhotoHardening = require('../functions/scripts/hardenGroupPhotoMedia');

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

test('private photo hardening recovers exact paths from URL-only legacy records', () => {
  const candidate = privatePhotoHardening.buildCandidate({
    tourId: 'TOUR_1', ownerKey: 'owner-1', photoId: 'photo-1',
    record: {
      sourceUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/private_tour_photos%2FTOUR_1%2Fowner-1%2Fsource.jpg?alt=media&token=secret',
      viewerUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/private_tour_photos%2FTOUR_1%2Fother-owner%2Fviewer.jpg?alt=media&token=secret',
      thumbnailUrl: 'https://example.test/not-a-firebase-object',
      url: 'https://firebasestorage.googleapis.com/v0/b/demo/o/private_tour_photos%2FTOUR_1%2Fowner-1%2Fold-source.jpg?alt=media&token=secret',
      fullUrl: 'https://example.test/old-external-link',
    },
  });
  assert.deepStrictEqual(candidate.objectPaths, ['private_tour_photos/TOUR_1/owner-1/source.jpg']);
  assert.deepStrictEqual(candidate.pathUpdates, {
    storagePath: 'private_tour_photos/TOUR_1/owner-1/source.jpg',
  });
  assert.deepStrictEqual(candidate.urlFields, ['sourceUrl', 'viewerUrl', 'thumbnailUrl', 'url', 'fullUrl']);
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
    storage: () => ({ bucket: () => ({
      getFiles: async () => [[
        {
          name: 'private_tour_photos/TOUR_1/owner/source.jpg',
          getMetadata: async () => [{ metadata: { firebaseStorageDownloadTokens: 'a' } }],
        },
        {
          name: 'private_tour_photos/TOUR_1/owner/viewer.jpg',
          getMetadata: async () => [{ metadata: { firebaseStorageDownloadTokens: 'b' } }],
        },
      ]],
      file: (path) => ({
        setMetadata: async (metadata) => metadataWrites.push({ path, metadata }),
      }),
    }) }),
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
      storage: () => ({ bucket: () => ({
        getFiles: async () => [[{
          name: 'private_tour_photos/T/O/source.jpg',
          getMetadata: async () => [{ metadata: { firebaseStorageDownloadTokens: 'token' } }],
        }]],
        file: () => ({ setMetadata: async () => { throw error; } }),
      }) }),
    };
  };
  const options = { dryRun: false, tourId: 'T', ownerKey: 'O', limit: 10, afterCursor: null };
  await assert.doesNotReject(privatePhotoHardening.run({ admin: makeAdmin({ code: 404 }), options }));
  await assert.rejects(privatePhotoHardening.run({ admin: makeAdmin({ code: 500 }), options }));
});

test('group photo hardening derives exact paths, strips URLs, and migrates chat references', () => {
  assert.equal(groupPhotoHardening.parseArgs([]).dryRun, true);
  assert.equal(groupPhotoHardening.parseArgs(['--apply']).dryRun, false);
  const candidate = groupPhotoHardening.buildCandidate({
    tourId: 'TOUR_1', photoId: 'photo-1', record: {
      sourceUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/group_tour_photos%2FTOUR_1%2Fsource.jpg?alt=media&token=secret',
      viewerUrl: 'https://token.test/viewer',
      viewerStoragePath: 'group_tour_photos/TOUR_1/viewers/source_viewer.jpg',
      thumbnailStoragePath: 'group_tour_photos/TOUR_2/thumbnails/foreign.jpg',
    },
  });
  assert.equal(candidate.storagePath, 'group_tour_photos/TOUR_1/source.jpg');
  assert.deepEqual(candidate.urlFields, ['sourceUrl', 'viewerUrl']);
  assert.deepEqual(candidate.objectPaths, [
    'group_tour_photos/TOUR_1/source.jpg',
    'group_tour_photos/TOUR_1/viewers/source_viewer.jpg',
  ]);
  assert.deepEqual(groupPhotoHardening.findChatReferenceUpdates({
    candidates: [candidate],
    messages: { m1: { type: 'image', imageUrl: candidate.legacyUrls[0], thumbnailUrl: candidate.legacyUrls[0] } },
  }), {
    'chats/TOUR_1/messages/m1/photoId': 'photo-1',
    'chats/TOUR_1/messages/m1/imageUrl': null,
    'chats/TOUR_1/messages/m1/thumbnailUrl': null,
  });
});

test('group photo hardening migrates the oldest url-only record shape', () => {
  const candidate = groupPhotoHardening.buildCandidate({
    tourId: 'TOUR_1',
    photoId: 'legacy-photo',
    record: {
      url: 'https://firebasestorage.googleapis.com/v0/b/demo/o/group_tour_photos%2FTOUR_1%2Flegacy.jpg?alt=media&token=secret',
    },
  });
  assert.equal(candidate.storagePath, 'group_tour_photos/TOUR_1/legacy.jpg');
  assert.deepEqual(candidate.urlFields, ['url']);
  assert.deepEqual(candidate.legacyUrls, [
    'https://firebasestorage.googleapis.com/v0/b/demo/o/group_tour_photos%2FTOUR_1%2Flegacy.jpg?alt=media&token=secret',
  ]);
});

test('group photo token audit uses bounded file metadata and returns deterministic paths', async () => {
  let metadataReads = 0;
  const files = [
    {
      name: 'group_tour_photos/TOUR_1/z.jpg',
      metadata: { metadata: {} },
      getMetadata: async () => {
        metadataReads += 1;
        return [{ metadata: { firebaseStorageDownloadTokens: 'token-z' } }];
      },
    },
    {
      name: 'group_tour_photos/TOUR_1/clean.jpg',
      getMetadata: async () => {
        metadataReads += 1;
        return [{ metadata: {} }];
      },
    },
    {
      name: 'group_tour_photos/TOUR_1/a.jpg',
      getMetadata: async () => {
        metadataReads += 1;
        return [{ metadata: { firebaseStorageDownloadTokens: 'token-a' } }];
      },
    },
  ];
  const result = await groupPhotoHardening.listTokenizedObjects({
    bucket: { getFiles: async () => [files] },
    tourId: 'TOUR_1',
    concurrency: 2,
  });
  assert.deepEqual(result, [
    'group_tour_photos/TOUR_1/a.jpg',
    'group_tour_photos/TOUR_1/z.jpg',
  ]);
  assert.equal(metadataReads, 3);
});

test('group photo hardening recovers existing orphan chat media and clears missing links', async () => {
  const existingUrl = 'https://firebasestorage.googleapis.com/v0/b/demo/o/group_tour_photos%2FTOUR_1%2Forphan.jpg?alt=media&token=one';
  const missingUrl = 'https://firebasestorage.googleapis.com/v0/b/demo/o/group_tour_photos%2FTOUR_1%2Fmissing.jpg?alt=media&token=two';
  const plan = await groupPhotoHardening.buildOrphanChatMediaPlan({
    bucket: {
      file: (objectPath) => ({ exists: async () => [objectPath.endsWith('/orphan.jpg')] }),
    },
    tourId: 'TOUR_1',
    tourExists: true,
    knownUrls: new Set(),
    nowMs: 1234,
    messages: {
      existing: {
        type: 'image', imageUrl: existingUrl, thumbnailUrl: existingUrl,
        senderStableId: 'pax_v2_11111111111111111111111111111111', senderName: 'Guest', timestamp: 100,
      },
      missing: {
        type: 'image', imageUrl: missingUrl, thumbnailUrl: missingUrl,
        senderId: 'legacy-auth-uid', text: 'Missing', timestamp: 200,
      },
    },
  });
  assert.equal(plan.referenceCount, 2);
  assert.equal(Object.keys(plan.photoRecords).length, 1);
  const [photoId, record] = Object.entries(plan.photoRecords)[0];
  assert.match(photoId, /^legacy_chat_[a-f0-9]{32}$/);
  assert.equal(record.storagePath, 'group_tour_photos/TOUR_1/orphan.jpg');
  assert.equal(record.userId, 'pax_v2_11111111111111111111111111111111');
  assert.equal(record.caption, '');
  assert.equal(plan.updates['chats/TOUR_1/messages/existing/photoId'], photoId);
  assert.equal(plan.updates['chats/TOUR_1/messages/existing/imageUrl'], null);
  assert.equal(plan.updates['chats/TOUR_1/messages/missing/imageUrl'], null);
  assert.equal(plan.updates['chats/TOUR_1/messages/missing/photoId'], undefined);
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
