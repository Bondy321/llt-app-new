const test = require('node:test');
const assert = require('node:assert');
const { loadTourPhotos, uploadImage } = require('../services/photoService');

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

test('loadTourPhotos uses private path when userId is provided', async () => {
  let usedPath;
  const mockStorageRefFn = (_storage, path) => {
    usedPath = path;
    return { fullPath: path };
  };

  await loadTourPhotos('tour-private', {
    userId: 'user-1',
    storageInstance: {},
    storageRefFn: mockStorageRefFn,
    listAllFn: async () => ({ items: [] }),
    getDownloadURLFn: async () => null
  });

  assert.equal(usedPath, 'private_tour_photos/tour-private/user-1');
});

test('uploadImage builds a private file path when userId is provided', async () => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;

  let usedPath;
  const mockStorageRefFn = (_storage, path) => {
    usedPath = path;
    return { fullPath: path };
  };

  const mockUploadBytesResumableFn = (fileRef, blob) => ({
    snapshot: { ref: fileRef },
    on: (_event, progressCallback, _errorCallback, successCallback) => {
      progressCallback({ bytesTransferred: blob.size, totalBytes: blob.size });
      successCallback();
    }
  });

  const result = await uploadImage({
    imageUri: 'file://photo.jpg',
    userId: 'user-9',
    tourId: 'tour-77',
    fetchFn: async () => ({ blob: async () => ({ size: 1024 }) }),
    storageInstance: {},
    storageRefFn: mockStorageRefFn,
    uploadBytesResumableFn: mockUploadBytesResumableFn,
    getDownloadURLFn: async (ref) => `https://example.com/${ref.fullPath}`
  });

  const expectedFileName = 'photo_1700000000000_user-9.jpg';
  const expectedPath = `private_tour_photos/tour-77/user-9/${expectedFileName}`;

  assert.equal(usedPath, expectedPath);
  assert.deepEqual(result, {
    id: expectedFileName,
    url: `https://example.com/${expectedPath}`,
    name: expectedFileName
  });

  Date.now = originalNow;
});
