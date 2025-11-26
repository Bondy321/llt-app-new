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

test('loadTourPhotos supports private album paths', async () => {
  let capturedPath;

  const photos = await loadTourPhotos('tour-private', {
    userId: 'user-99',
    isPrivate: true,
    storageInstance: {},
    storageRefFn: (_storage, path) => {
      capturedPath = path;
      return { fullPath: path };
    },
    listAllFn: async () => ({
      items: [{ name: 'private1.jpg' }]
    }),
    getDownloadURLFn: async (itemRef) => `https://example.com/${itemRef.name}`
  });

  assert.equal(capturedPath, 'private_tour_photos/tour-private/user-99');
  assert.deepEqual(photos, [
    {
      id: 'private1.jpg',
      url: 'https://example.com/private1.jpg',
      name: 'private1.jpg'
    }
  ]);
});

test('uploadImage builds private paths and reports progress', async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let capturedPath;
  let reportedProgress;

  Date.now = () => 1700000000000;
  global.fetch = async () => ({ blob: async () => ({ size: 1024 }) });

  const mockStorageRefFn = (_storage, path) => {
    capturedPath = path;
    return { fullPath: path };
  };

  const mockUploadTask = {
    on: (_event, progressCb, _errorCb, completeCb) => {
      progressCb({ bytesTransferred: 50, totalBytes: 100 });
      mockUploadTask.snapshot = { ref: { fullPath: capturedPath } };
      completeCb();
    },
    snapshot: { ref: { fullPath: '' } }
  };

  const mockUploadBytesResumableFn = () => mockUploadTask;
  const mockGetDownloadURLFn = async (ref) => `https://example.com/${ref.fullPath}`;

  try {
    const photo = await uploadImage({
      imageUri: 'file://photo.jpg',
      userId: 'user-123',
      tourId: 'tour-456',
      isPrivate: true,
      storageInstance: {},
      storageRefFn: mockStorageRefFn,
      uploadBytesResumableFn: mockUploadBytesResumableFn,
      getDownloadURLFn: mockGetDownloadURLFn,
      onProgress: (progress) => {
        reportedProgress = progress;
      }
    });

    assert.equal(
      capturedPath,
      'private_tour_photos/tour-456/user-123/photo_1700000000000_user-123.jpg'
    );
    assert.equal(reportedProgress, 0.5);
    assert.deepEqual(photo, {
      id: 'photo_1700000000000_user-123.jpg',
      url: 'https://example.com/private_tour_photos/tour-456/user-123/photo_1700000000000_user-123.jpg',
      name: 'photo_1700000000000_user-123.jpg'
    });
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});
