const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeLivePhotoWindow,
  mergePhotoLists,
} = require('../services/photoGalleryMergeService');

test('mergePhotoLists preserves newest-first order and de-duplicates by id', () => {
  const merged = mergePhotoLists(
    [
      { id: 'older', timestamp: 100, caption: 'old' },
      { id: 'same', timestamp: 200, caption: 'old caption' },
    ],
    [
      { id: 'newest', timestamp: 300 },
      { id: 'same', timestamp: 250, caption: 'new caption' },
    ],
  );

  assert.deepEqual(merged.map((photo) => photo.id), ['newest', 'same', 'older']);
  assert.equal(merged.find((photo) => photo.id === 'same').caption, 'new caption');
});

test('mergeLivePhotoWindow replaces recent live window while keeping older paged photos', () => {
  const merged = mergeLivePhotoWindow(
    [
      { id: 'deleted-recent', timestamp: 300 },
      { id: 'older-page', timestamp: 50 },
    ],
    [
      { id: 'new-live', timestamp: 400 },
      { id: 'live-floor', timestamp: 100 },
    ],
  );

  assert.deepEqual(merged.map((photo) => photo.id), ['new-live', 'live-floor', 'older-page']);
});
