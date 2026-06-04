const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePhotoUri,
  isLoadablePhotoUri,
  hashCacheKey,
  resolveViewerDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
  buildPhotoCacheKey,
  resolveThumbnailDisplayUri,
  isProcessingVariantRecord,
} = require('../services/photoVariantService');

test('resolveViewerDisplayUri prioritizes current viewer/thumbnail/source fields', () => {
  assert.equal(resolveViewerDisplayUri({
    viewerUrl: 'https://cdn/viewer.jpg',
    thumbnailUrl: 'https://cdn/thumb.jpg',
    sourceUrl: 'https://cdn/source.jpg',
  }), 'https://cdn/viewer.jpg');

  assert.equal(resolveViewerDisplayUri({
    thumbnailUrl: 'https://cdn/thumb.jpg',
    sourceUrl: 'https://cdn/source.jpg',
  }), 'https://cdn/thumb.jpg');

  assert.equal(resolveViewerDisplayUri({
    sourceUrl: 'https://cdn/source.jpg',
  }), 'https://cdn/source.jpg');

  assert.equal(resolveViewerDisplayUri({ thumbnailUrl: 'https://cdn/thumb.jpg' }), 'https://cdn/thumb.jpg');
  assert.equal(resolveFullQualityUri({ sourceUrl: 'https://cdn/source.jpg' }), 'https://cdn/source.jpg');
  assert.equal(resolveFullQualityUri({ viewerUrl: 'https://cdn/viewer.jpg' }), null);
});

test('buildNeighborPrefetchUris prioritizes viewer display variants for neighboring photos', () => {
  const uris = buildNeighborPrefetchUris({
    photos: [
      { viewerUrl: 'https://cdn/0-viewer.jpg', thumbnailUrl: 'https://cdn/0-thumb.jpg' },
      { viewerUrl: 'https://cdn/1-viewer.jpg', thumbnailUrl: 'https://cdn/1-thumb.jpg' },
      { sourceUrl: 'https://cdn/2-source.jpg', thumbnailUrl: 'https://cdn/2-thumb.jpg' },
      { sourceUrl: 'https://cdn/3-source.jpg' },
    ],
    currentIndex: 1,
    neighborDistance: 2,
    thumbnailsOnly: false,
  });

  assert.deepEqual(uris, [
    'https://cdn/0-viewer.jpg',
    'https://cdn/0-thumb.jpg',
    'https://cdn/2-thumb.jpg',
    'https://cdn/3-source.jpg',
  ]);
  assert.equal(resolveSaveUri({
    sourceUrl: 'https://cdn/source.jpg',
    viewerUrl: 'https://cdn/viewer.jpg',
    thumbnailUrl: 'https://cdn/thumb.jpg',
  }), 'https://cdn/source.jpg');
});

test('buildPhotoCacheKey prefers variant storage paths over signed URLs and hashes native cache keys', () => {
  const photo = {
    id: 'photo-1',
    variantVersion: 2,
    thumbnailUrl: 'https://signed.example.com/thumb.jpg?token=one',
    thumbnailStoragePath: 'group_tour_photos/tour-1/thumbnails/photo_thumb.jpg',
    viewerUrl: 'https://signed.example.com/viewer.jpg?token=two',
    viewerStoragePath: 'group_tour_photos/tour-1/viewers/photo_viewer.jpg',
    storagePath: 'group_tour_photos/tour-1/photo.jpg',
  };

  const thumbnailCacheKey = buildPhotoCacheKey(photo, 'thumbnail');
  const viewerCacheKey = buildPhotoCacheKey(photo, 'viewer');
  const sourceCacheKey = buildPhotoCacheKey({ id: 'source-photo', sourceUrl: 'https://signed.example.com/photo.jpg' }, 'thumbnail');

  assert.match(thumbnailCacheKey, /^photo_thumbnail_[a-z0-9]+$/);
  assert.match(viewerCacheKey, /^photo_viewer_[a-z0-9]+$/);
  assert.match(sourceCacheKey, /^photo_thumbnail_[a-z0-9]+$/);
  assert.notEqual(thumbnailCacheKey, viewerCacheKey);
  assert.equal(thumbnailCacheKey.includes('/'), false);
  assert.equal(viewerCacheKey.includes(':'), false);
  assert.equal(resolveThumbnailDisplayUri({ viewerUrl: 'viewer', sourceUrl: 'full' }), null);
  assert.equal(resolveThumbnailDisplayUri({ viewerUrl: 'private_tour_photos/tour/file.jpg', sourceUrl: 'https://cdn/source.jpg' }), 'https://cdn/source.jpg');
});

test('thumbnail resolver avoids full-size fallback while variants are still processing', () => {
  const processingPhoto = {
    id: 'processing-photo',
    variantStatus: 'processing',
    sourceUrl: 'https://cdn/source-large.jpg',
  };

  assert.equal(isProcessingVariantRecord(processingPhoto), true);
  assert.equal(resolveThumbnailDisplayUri(processingPhoto), null);
  assert.deepEqual(
    buildNeighborPrefetchUris({
      photos: [
        { viewerUrl: 'https://cdn/ready-viewer.jpg', thumbnailUrl: 'https://cdn/ready-thumb.jpg' },
        { viewerUrl: 'https://cdn/current-viewer.jpg', thumbnailUrl: 'https://cdn/current-thumb.jpg' },
        processingPhoto,
      ],
      currentIndex: 1,
      neighborDistance: 1,
      thumbnailsOnly: false,
    }),
    [
      'https://cdn/ready-viewer.jpg',
      'https://cdn/ready-thumb.jpg',
    ],
  );

  assert.equal(resolveThumbnailDisplayUri({
    variantStatus: 'processing',
    thumbnailUrl: 'https://cdn/thumb-ready.jpg',
    sourceUrl: 'https://cdn/source-large.jpg',
  }), 'https://cdn/thumb-ready.jpg');
});

test('photo URI resolvers ignore malformed fields', () => {
  assert.equal(normalizePhotoUri({ uri: 'https://cdn/object.jpg' }), null);
  assert.equal(normalizePhotoUri('  undefined  '), null);
  assert.equal(normalizePhotoUri('  https://cdn/clean.jpg  '), 'https://cdn/clean.jpg');
  assert.equal(isLoadablePhotoUri('https://cdn/clean.jpg'), true);
  assert.equal(isLoadablePhotoUri('file:///local/photo.jpg'), true);
  assert.equal(isLoadablePhotoUri('private_tour_photos/tour-1/source.jpg'), false);
  assert.equal(isLoadablePhotoUri('gs://bucket/source.jpg'), false);
  assert.match(hashCacheKey('pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk/very/long/path.jpg'), /^[a-z0-9]+$/);

  assert.equal(resolveViewerDisplayUri({
    viewerUrl: { downloadURL: 'https://cdn/bad-viewer.jpg' },
    thumbnailUrl: '  ',
    sourceUrl: 'https://cdn/source.jpg',
  }), 'https://cdn/source.jpg');

  assert.equal(resolveSaveUri({
    sourceUrl: ['https://cdn/bad-source.jpg'],
    viewerUrl: 'private_tour_photos/tour/file.jpg',
    thumbnailUrl: 'https://cdn/thumb.jpg',
  }), 'https://cdn/thumb.jpg');

  assert.equal(resolveFullQualityUri({
    sourceUrl: { uri: 'https://cdn/source.jpg' },
  }), null);

  assert.deepEqual(
    buildNeighborPrefetchUris({
      photos: [
        { viewerUrl: { uri: 'bad' }, thumbnailUrl: 'https://cdn/good-thumb.jpg' },
        { viewerUrl: 'https://cdn/current.jpg' },
        { viewerUrl: 'null', thumbnailUrl: { uri: 'bad' }, sourceUrl: 'https://cdn/fallback.jpg' },
      ],
      currentIndex: 1,
      neighborDistance: 1,
      thumbnailsOnly: false,
    }),
    [
      'https://cdn/good-thumb.jpg',
      'https://cdn/fallback.jpg',
    ],
  );
});
