const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' });
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'sharp') {
    return () => ({
      rotate: () => ({
        resize: () => ({
          jpeg: () => ({
            toBuffer: async () => Buffer.from([]),
          }),
        }),
      }),
    });
  }
  return originalLoad.apply(this, arguments);
};
const { __testables } = require('../functions/index.js');
Module._load = originalLoad;

test('parseSourcePhotoPath resolves group and private source paths only', () => {
  assert.deepEqual(__testables.parseSourcePhotoPath('group_tour_photos/tour-1/file.jpg'), {
    visibility: 'group',
    tourId: 'tour-1',
    ownerKey: null,
    filename: 'file.jpg',
  });

  assert.deepEqual(__testables.parseSourcePhotoPath('private_tour_photos/tour-1/owner-1/file.jpg'), {
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
    filename: 'file.jpg',
  });

  assert.equal(__testables.parseSourcePhotoPath('group_tour_photos/tour-1/viewers/file.jpg'), null);
});

test('buildPhotoCollectionPath maps visibility to expected DB collection', () => {
  assert.equal(__testables.buildPhotoCollectionPath({
    visibility: 'group',
    tourId: 'tour-1',
  }), 'group_tour_photos/tour-1');

  assert.equal(__testables.buildPhotoCollectionPath({
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
  }), 'private_tour_photos/tour-1/owner-1');
});

test('buildPhotoVariantPaths maps private variants to supplied owner key', () => {
  assert.deepEqual(__testables.buildPhotoVariantPaths({
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'pax_v1:T123:email_2E_example',
    filename: 'source.jpg',
  }), {
    viewerPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/viewers/source_viewer.jpg',
    thumbnailPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/thumbnails/source_thumb.jpg',
  });
});

test('buildFirebaseStorageDownloadUrl encodes object paths for token URLs', () => {
  assert.equal(
    __testables.buildFirebaseStorageDownloadUrl({
      bucketName: 'demo-bucket.appspot.com',
      objectPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/viewers/source_viewer.jpg',
      token: 'token-1',
    }),
    'https://firebasestorage.googleapis.com/v0/b/demo-bucket.appspot.com/o/private_tour_photos%2Ftour-1%2Fpax_v1%3AT123%3Aemail_2E_example%2Fviewers%2Fsource_viewer.jpg?alt=media&token=token-1',
  );
});

test('generatePhotoVariantsForRecord dry run reports target variant paths without writing', async () => {
  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'group',
    tourId: 'tour-1',
    photoId: 'photo-1',
    dryRun: true,
    photoRecord: {
      storagePath: 'group_tour_photos/tour-1/source.jpg',
    },
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.viewerPath, 'group_tour_photos/tour-1/viewers/source_viewer.jpg');
  assert.equal(result.thumbnailPath, 'group_tour_photos/tour-1/thumbnails/source_thumb.jpg');
});

test('generatePhotoVariantsForRecord writes ready variant fields', async () => {
  const savedPaths = [];
  const saveMetadataByPath = {};
  const updates = [];
  const storageBucket = {
    file: (path) => ({
      download: async () => [Buffer.from('source')],
      save: async (_buffer, options) => {
        savedPaths.push(path);
        saveMetadataByPath[path] = options?.metadata?.metadata || {};
      },
    }),
  };
  const dbRoot = {
    child: (photoId) => ({
      update: async (payload) => {
        updates.push({ photoId, payload });
      },
    }),
  };

  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'group',
    tourId: 'tour-1',
    photoId: 'photo-1',
    storageBucket,
    dbRoot,
    photoRecord: {
      idempotencyKey: 'idem-1',
      storagePath: 'group_tour_photos/tour-1/source.jpg',
    },
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(savedPaths, [
    'group_tour_photos/tour-1/viewers/source_viewer.jpg',
    'group_tour_photos/tour-1/thumbnails/source_thumb.jpg',
  ]);
  assert.equal(updates[0].photoId, 'photo-1');
  assert.equal(updates[0].payload.variantStatus, 'ready');
  assert.match(
    updates[0].payload.viewerUrl,
    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/demo-bucket\.appspot\.com\/o\/group_tour_photos%2Ftour-1%2Fviewers%2Fsource_viewer\.jpg\?alt=media&token=/,
  );
  assert.match(
    updates[0].payload.thumbnailUrl,
    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/demo-bucket\.appspot\.com\/o\/group_tour_photos%2Ftour-1%2Fthumbnails%2Fsource_thumb\.jpg\?alt=media&token=/,
  );
  assert.equal(typeof saveMetadataByPath['group_tour_photos/tour-1/viewers/source_viewer.jpg'].firebaseStorageDownloadTokens, 'string');
  assert.equal(typeof saveMetadataByPath['group_tour_photos/tour-1/thumbnails/source_thumb.jpg'].firebaseStorageDownloadTokens, 'string');
});

test('generatePhotoVariantsForRecord marks failed when source download fails', async () => {
  const updates = [];
  const storageBucket = {
    file: () => ({
      download: async () => {
        throw new Error('download failed');
      },
    }),
  };
  const dbRoot = {
    child: (photoId) => ({
      update: async (payload) => {
        updates.push({ photoId, payload });
      },
    }),
  };

  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
    photoId: 'photo-2',
    storageBucket,
    dbRoot,
    photoRecord: {
      storagePath: 'private_tour_photos/tour-1/owner-1/source.jpg',
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'download failed');
  assert.equal(updates[0].photoId, 'photo-2');
  assert.equal(updates[0].payload.variantStatus, 'failed');
  assert.equal(updates[0].payload.variantError, 'download failed');
});
