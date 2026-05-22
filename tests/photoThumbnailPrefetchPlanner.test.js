const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectThumbnailPrefetchBatch,
} = require('../services/photoThumbnailPrefetchPlanner');

test('selectThumbnailPrefetchBatch only returns thumbnails included in the current batch', () => {
  const alreadyPrefetched = new Set(['https://cdn/1-thumb.jpg']);
  const batch = selectThumbnailPrefetchBatch({
    photos: [
      { thumbnailUrl: 'https://cdn/1-thumb.jpg' },
      { thumbnailUrl: 'https://cdn/2-thumb.jpg' },
      { thumbnailUrl: 'https://cdn/3-thumb.jpg' },
      { thumbnailUrl: 'https://cdn/4-thumb.jpg' },
    ],
    prefetchedUris: alreadyPrefetched,
    maxBatchSize: 2,
  });

  assert.deepEqual(batch, [
    'https://cdn/2-thumb.jpg',
    'https://cdn/3-thumb.jpg',
  ]);
  assert.equal(alreadyPrefetched.has('https://cdn/4-thumb.jpg'), false);
});

test('selectThumbnailPrefetchBatch de-dupes batch candidates and skips processing source fallbacks', () => {
  const batch = selectThumbnailPrefetchBatch({
    photos: [
      { thumbnailUrl: 'https://cdn/1-thumb.jpg' },
      { thumbnailUrl: 'https://cdn/1-thumb.jpg' },
      {
        variantStatus: 'processing',
        sourceUrl: 'https://cdn/large-source.jpg',
      },
      { viewerUrl: 'https://cdn/viewer-fallback.jpg' },
    ],
    prefetchedUris: new Set(),
    maxBatchSize: 8,
  });

  assert.deepEqual(batch, [
    'https://cdn/1-thumb.jpg',
    'https://cdn/viewer-fallback.jpg',
  ]);
});
