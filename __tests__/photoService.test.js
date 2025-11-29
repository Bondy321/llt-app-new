const test = require('node:test');
const assert = require('node:assert');
const {
  uploadPhoto,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
} = require('../services/photoService');

const mockDbRef = (_db, path) => ({ path });

const mockSnapshot = (data) => ({
  val: () => data,
});

test('uploadPhoto uploads the blob, stores metadata, and returns the new entry', async () => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;

  const mockBlob = { closed: false, close() { this.closed = true; } };
  const fetchCalls = [];
  const mockFetch = async (uri) => {
    fetchCalls.push(uri);
    return { blob: async () => mockBlob };
  };

  let uploadTarget;
  const mockStorageRef = (_storage, path) => ({ path });
  const mockUploadBytes = async (ref, blob) => { uploadTarget = { ref, blob }; };
  const mockGetDownloadURL = async (ref) => `https://example.com/${ref.path}`;

  let setPayload;
  const mockPush = () => ({ key: 'abc123' });
  const mockSet = async (_ref, payload) => { setPayload = payload; };
  const mockServerTimestamp = () => 1234567890;

  const result = await uploadPhoto(
    'file://photo.jpg',
    'tour-77',
    'user-9',
    'Lovely day!',
    {
      storageInstance: {},
      realtimeDbInstance: {},
      storageRefFn: mockStorageRef,
      uploadBytesFn: mockUploadBytes,
      getDownloadURLFn: mockGetDownloadURL,
      dbRefFn: mockDbRef,
      pushFn: mockPush,
      setFn: mockSet,
      serverTimestampFn: mockServerTimestamp,
      fetchFn: mockFetch,
    }
  );

  const expectedPath = 'photos/tour-77/1700000000000_user-9.jpg';
  assert.strictEqual(uploadTarget.ref.path, expectedPath);
  assert.strictEqual(uploadTarget.blob, mockBlob);
  assert.deepEqual(fetchCalls, ['file://photo.jpg']);

  assert.deepEqual(setPayload, {
    url: `https://example.com/${expectedPath}`,
    userId: 'user-9',
    caption: 'Lovely day!',
    timestamp: 1234567890,
  });

  assert.deepEqual(result, {
    id: 'abc123',
    url: `https://example.com/${expectedPath}`,
    userId: 'user-9',
    caption: 'Lovely day!',
  });
  assert.strictEqual(mockBlob.closed, true);

  Date.now = originalNow;
});

test('uploadPhoto stores private uploads in a user-specific path', async () => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;

  const mockBlob = { closed: false, close() { this.closed = true; } };
  const mockFetch = async () => ({ blob: async () => mockBlob });

  let storagePath;
  const mockStorageRef = (_storage, path) => {
    storagePath = path;
    return { path };
  };
  const mockUploadBytes = async () => {};
  const mockGetDownloadURL = async (ref) => `https://example.com/${ref.path}`;

  let databasePath;
  const privateDbRef = (_db, path) => {
    databasePath = path;
    return { path };
  };
  const mockPush = () => ({ key: 'private123' });
  const mockSet = async () => {};
  const mockServerTimestamp = () => 987654321;

  await uploadPhoto(
    'file://secret.jpg',
    'tour-55',
    'user-private',
    'Hidden gem',
    {
      visibility: 'private',
      storageInstance: {},
      realtimeDbInstance: {},
      storageRefFn: mockStorageRef,
      uploadBytesFn: mockUploadBytes,
      getDownloadURLFn: mockGetDownloadURL,
      dbRefFn: privateDbRef,
      pushFn: mockPush,
      setFn: mockSet,
      serverTimestampFn: mockServerTimestamp,
      fetchFn: mockFetch,
    }
  );

  const expectedFilePath = 'privatePhotos/tour-55/user-private/1700000000000_user-private.jpg';
  const expectedDbPath = 'privatePhotos/tour-55/user-private';

  assert.strictEqual(storagePath, expectedFilePath);
  assert.strictEqual(databasePath, expectedDbPath);
  assert.strictEqual(mockBlob.closed, true);

  Date.now = originalNow;
});

test('subscribeToTourPhotos sorts photos in descending timestamp order', async () => {
  let receivedPhotos;
  let unsubscribeCalled = false;

  const mockOnValue = (_ref, callback) => {
    callback(
      mockSnapshot({
        first: { url: 'https://example.com/1', timestamp: 10, userId: 'u1' },
        second: { url: 'https://example.com/2', timestamp: 20, userId: 'u2' },
      })
    );

    return () => {
      unsubscribeCalled = true;
    };
  };

  const unsubscribe = subscribeToTourPhotos(
    'tour-1',
    (photos) => {
      receivedPhotos = photos;
    },
    {
      realtimeDbInstance: {},
      dbRefFn: mockDbRef,
      onValueFn: mockOnValue,
    }
  );

  assert.deepEqual(
    receivedPhotos.map((photo) => photo.id),
    ['second', 'first']
  );

  unsubscribe();
  assert.strictEqual(unsubscribeCalled, true);
});

test('subscribeToPrivatePhotos scopes photos to the user and sorts them', async () => {
  let receivedPhotos;
  let unsubscribeCalled = false;

  const mockOnValue = (_ref, callback) => {
    callback(
      mockSnapshot({
        alpha: { url: 'https://example.com/1', timestamp: 100, userId: 'u1' },
        beta: { url: 'https://example.com/2', timestamp: 200, userId: 'u1' },
      })
    );

    return () => {
      unsubscribeCalled = true;
    };
  };

  const unsubscribe = subscribeToPrivatePhotos(
    'tour-1',
    'u1',
    (photos) => {
      receivedPhotos = photos;
    },
    {
      realtimeDbInstance: {},
      dbRefFn: mockDbRef,
      onValueFn: mockOnValue,
    }
  );

  assert.deepEqual(
    receivedPhotos.map((photo) => photo.id),
    ['beta', 'alpha']
  );

  unsubscribe();
  assert.strictEqual(unsubscribeCalled, true);
});
