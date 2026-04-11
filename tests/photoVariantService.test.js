const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveViewerDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
} = require('../services/photoVariantService');

test('resolveViewerDisplayUri prioritizes viewer/thumbnail/source fallbacks for processing and legacy records', () => {
  assert.equal(resolveViewerDisplayUri({
    viewerUrl: 'https://cdn/viewer.jpg',
    thumbnailUrl: 'https://cdn/thumb.jpg',
    sourceUrl: 'https://cdn/source.jpg',
    url: 'https://cdn/url.jpg',
    fullUrl: 'https://cdn/full.jpg'
  }), 'https://cdn/viewer.jpg');

  assert.equal(resolveViewerDisplayUri({
    thumbnailUrl: 'https://cdn/thumb.jpg',
    sourceUrl: 'https://cdn/source.jpg',
    url: 'https://cdn/url.jpg',
  }), 'https://cdn/thumb.jpg');

  assert.equal(resolveViewerDisplayUri({
    sourceUrl: 'https://cdn/source.jpg',
    fullUrl: 'https://cdn/full.jpg',
  }), 'https://cdn/source.jpg');

  assert.equal(resolveViewerDisplayUri({ thumbnailUrl: 'https://cdn/thumb.jpg' }), 'https://cdn/thumb.jpg');
  assert.equal(resolveFullQualityUri({ fullUrl: 'https://cdn/full.jpg', url: 'https://cdn/url.jpg' }), 'https://cdn/full.jpg');
  assert.equal(resolveFullQualityUri({ url: 'https://cdn/url.jpg' }), 'https://cdn/url.jpg');
});

test('buildNeighborPrefetchUris prioritizes viewer display variants for neighboring photos', () => {
  const uris = buildNeighborPrefetchUris({
    photos: [
      { viewerUrl: 'https://cdn/0-viewer.jpg', thumbnailUrl: 'https://cdn/0-thumb.jpg' },
      { viewerUrl: 'https://cdn/1-viewer.jpg', thumbnailUrl: 'https://cdn/1-thumb.jpg' },
      { url: 'https://cdn/2-url.jpg', thumbnailUrl: 'https://cdn/2-thumb.jpg' },
      { fullUrl: 'https://cdn/3-full.jpg', thumbnailUrl: 'https://cdn/3-thumb.jpg' },
    ],
    currentIndex: 1,
    neighborDistance: 2,
    thumbnailsOnly: false,
  });

  assert.deepEqual(uris, [
    'https://cdn/0-viewer.jpg',
    'https://cdn/0-thumb.jpg',
    'https://cdn/2-thumb.jpg',
    'https://cdn/3-thumb.jpg',
  ]);
  assert.equal(resolveSaveUri({ fullUrl: 'f', url: 'u' }), 'f');
});
