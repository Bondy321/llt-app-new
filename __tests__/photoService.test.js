const test = require('node:test');
const assert = require('node:assert');
const { loadTourPhotos } = require('../services/photoService');

test('loadTourPhotos transforms storage items into photo objects', async () => {
  const mockStorage = {};
  const mockStorageRefFn = (_storage, path) => ({ fullPath: path });
  const mockListAllFn = async () => ({
    items: [
      { name: 'photo1.jpg' },
      { name: 'photo2.jpg' }
    ]
  });
  const mockGetDownloadURLFn = async (itemRef) => `https://example.com/${itemRef.name}`;

  const photos = await loadTourPhotos('tour-123', {
    storageInstance: mockStorage,
    storageRefFn: mockStorageRefFn,
    listAllFn: mockListAllFn,
    getDownloadURLFn: mockGetDownloadURLFn
  });

  assert.equal(photos.length, 2);
  assert.deepEqual(photos[0], {
    id: 'photo1.jpg',
    url: 'https://example.com/photo1.jpg',
    name: 'photo1.jpg'
  });
  assert.deepEqual(photos[1], {
    id: 'photo2.jpg',
    url: 'https://example.com/photo2.jpg',
    name: 'photo2.jpg'
  });
});

test('loadTourPhotos handles empty lists gracefully', async () => {
  const photos = await loadTourPhotos('tour-123', {
    storageInstance: {},
    storageRefFn: (_storage, path) => ({ fullPath: path }),
    listAllFn: async () => ({ items: [] }),
    getDownloadURLFn: async () => null
  });

  assert.deepEqual(photos, []);
});
