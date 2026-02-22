const test = require('node:test');
const assert = require('node:assert');

const {
  uploadPhoto,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
} = require('../services/photoService');

const mockDbRef = (_db, path) => ({ path });
const mockSnapshot = (data) => ({ val: () => data });

const createMockBlob = (overrides = {}) => ({
  size: 1024,
  type: 'image/jpeg',
  closed: false,
  close() {
    this.closed = true;
  },
  ...overrides,
});

test('uploadPhoto stores group photo using group_tour_photos paths and rich metadata', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const blob = createMockBlob();
  const fetchCalls = [];
  const mockFetch = async (uri) => {
    fetchCalls.push(uri);
    return {
      ok: true,
      blob: async () => blob,
    };
  };

  let uploadCall;
  const mockUploadBytes = async (ref, uploadedBlob, metadata) => {
    uploadCall = { ref, uploadedBlob, metadata };
  };

  const storagePaths = [];
  const mockStorageRef = (_storage, path) => {
    storagePaths.push(path);
    return { path };
  };

  let setPayload;
  let setPath;
  const mockPush = (ref) => {
    setPath = ref.path;
    return { key: 'group-photo-1' };
  };
  const mockSet = async (_ref, payload) => {
    setPayload = payload;
  };

  const result = await uploadPhoto('file://group.jpg', 'tour-77', 'user-9', 'Lovely day!', {
    uploaderName: 'Driver Bond',
    storageInstance: {},
    realtimeDbInstance: {},
    storageRefFn: mockStorageRef,
    uploadBytesFn: mockUploadBytes,
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: mockDbRef,
    pushFn: mockPush,
    setFn: mockSet,
    serverTimestampFn: () => 1234567890,
    fetchFn: mockFetch,
  });

  assert.deepStrictEqual(fetchCalls, ['file://group.jpg']);
  assert.strictEqual(storagePaths[0], 'group_tour_photos/tour-77/1700000000000_user-9.jpg');
  assert.strictEqual(setPath, 'group_tour_photos/tour-77');
  assert.strictEqual(uploadCall.ref.path, storagePaths[0]);
  assert.strictEqual(uploadCall.uploadedBlob, blob);
  assert.strictEqual(uploadCall.metadata.contentType, 'image/jpeg');
  assert.strictEqual(uploadCall.metadata.customMetadata.uploadedBy, 'user-9');

  assert.deepStrictEqual(setPayload, {
    url: 'https://example.com/group_tour_photos/tour-77/1700000000000_user-9.jpg',
    userId: 'user-9',
    caption: 'Lovely day!',
    timestamp: 1234567890,
    storagePath: 'group_tour_photos/tour-77/1700000000000_user-9.jpg',
    fileSize: 1024,
    fileType: 'image/jpeg',
    uploaderName: 'Driver Bond',
  });

  assert.deepStrictEqual(result, {
    id: 'group-photo-1',
    url: 'https://example.com/group_tour_photos/tour-77/1700000000000_user-9.jpg',
    userId: 'user-9',
    caption: 'Lovely day!',
    uploaderName: 'Driver Bond',
  });
  assert.strictEqual(blob.closed, true);
});

test('uploadPhoto stores private photos in private_tour_photos namespaces', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const blob = createMockBlob({ type: 'image/webp' });
  const mockFetch = async () => ({ ok: true, blob: async () => blob });

  let writePath;
  const mockPush = (ref) => {
    writePath = ref.path;
    return { key: 'private-photo-1' };
  };

  let dbPayload;
  await uploadPhoto('file://private.webp', 'tour-55', 'user-private', 'Hidden gem', {
    visibility: 'private',
    storageInstance: {},
    realtimeDbInstance: {},
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async () => {},
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: mockDbRef,
    pushFn: mockPush,
    setFn: async (_ref, payload) => {
      dbPayload = payload;
    },
    serverTimestampFn: () => 9999,
    fetchFn: mockFetch,
  });

  assert.strictEqual(writePath, 'private_tour_photos/tour-55/user-private');
  assert.strictEqual(dbPayload.storagePath, 'private_tour_photos/tour-55/user-private/1700000000000_user-private.webp');
  assert.strictEqual(dbPayload.fileType, 'image/webp');
  assert.ok(!('uploaderName' in dbPayload));
  assert.strictEqual(blob.closed, true);
});

test('uploadPhoto rejects unsupported image types', async () => {
  const blob = createMockBlob({ type: 'image/gif' });

  await assert.rejects(
    uploadPhoto('file://bad.gif', 'tour-1', 'user-1', '', {
      storageInstance: {},
      realtimeDbInstance: {},
      fetchFn: async () => ({ ok: true, blob: async () => blob }),
      storageRefFn: (_storage, path) => ({ path }),
      uploadBytesFn: async () => {},
      getDownloadURLFn: async () => 'https://example.com/photo',
      dbRefFn: mockDbRef,
      pushFn: () => ({ key: 'x' }),
      setFn: async () => {},
      serverTimestampFn: () => 1,
    }),
    /File type image\/gif is not supported/
  );
});

test('uploadPhoto surfaces fetch failures when response is not ok', async () => {
  await assert.rejects(
    uploadPhoto('file://missing.jpg', 'tour-1', 'user-1', '', {
      storageInstance: {},
      realtimeDbInstance: {},
      fetchFn: async () => ({ ok: false, statusText: 'Not Found' }),
      storageRefFn: (_storage, path) => ({ path }),
      uploadBytesFn: async () => {},
      getDownloadURLFn: async () => 'https://example.com/photo',
      dbRefFn: mockDbRef,
      pushFn: () => ({ key: 'x' }),
      setFn: async () => {},
      serverTimestampFn: () => 1,
    }),
    /Failed to fetch file: Not Found/
  );
});

test('subscribeToTourPhotos sorts by descending timestamp and returns a safe fallback when mapping fails', async () => {
  const delivered = [];

  const unsubscribe = subscribeToTourPhotos('tour-1', (photos) => {
    delivered.push(photos);
  }, {
    realtimeDbInstance: {},
    dbRefFn: mockDbRef,
    onValueFn: (_ref, callback) => {
      callback(mockSnapshot({ first: { timestamp: 1 }, second: { timestamp: 10 } }));
      callback(mockSnapshot(null));
      return () => {};
    },
  });

  assert.deepStrictEqual(delivered[0].map((p) => p.id), ['second', 'first']);
  assert.deepStrictEqual(delivered[1], []);
  unsubscribe();
});

test('subscribeToPrivatePhotos scopes path to user and sorts newest first', async () => {
  let seenPath;
  let received;

  const unsubscribe = subscribeToPrivatePhotos('tour-A', 'user-5', (photos) => {
    received = photos;
  }, {
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => {
      seenPath = path;
      return { path };
    },
    onValueFn: (_ref, callback) => {
      callback(mockSnapshot({
        one: { timestamp: 2 },
        two: { timestamp: 22 },
      }));
      return () => {};
    },
  });

  assert.strictEqual(seenPath, 'private_tour_photos/tour-A/user-5');
  assert.deepStrictEqual(received.map((p) => p.id), ['two', 'one']);
  unsubscribe();
});

test('deleteGroupPhoto deletes owned photo from storage and database', async () => {
  const operations = [];

  const result = await deleteGroupPhoto('tour-1', 'photo-1', 'owner-1', {
    storageInstance: {},
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => ({ path }),
    getFn: async () => mockSnapshot({
      userId: 'owner-1',
      storagePath: 'group_tour_photos/tour-1/file.jpg',
    }),
    storageRefFn: (_storage, path) => ({ path }),
    deleteObjectFn: async (ref) => {
      operations.push(`delete-storage:${ref.path}`);
    },
    removeFn: async (ref) => {
      operations.push(`delete-db:${ref.path}`);
    },
  });

  assert.deepStrictEqual(operations, [
    'delete-storage:group_tour_photos/tour-1/file.jpg',
    'delete-db:group_tour_photos/tour-1/photo-1',
  ]);
  assert.deepStrictEqual(result, { success: true });
});

test('deleteGroupPhoto rejects delete when requesting user does not own photo', async () => {
  await assert.rejects(
    deleteGroupPhoto('tour-1', 'photo-1', 'intruder', {
      storageInstance: {},
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      getFn: async () => mockSnapshot({ userId: 'owner-1' }),
      removeFn: async () => {},
      deleteObjectFn: async () => {},
      storageRefFn: (_storage, path) => ({ path }),
    }),
    /You can only delete your own photos/
  );
});

test('deletePrivatePhoto succeeds even when storage object deletion fails', async () => {
  const deletedDbPaths = [];

  const result = await deletePrivatePhoto('tour-2', 'user-2', 'photo-99', {
    storageInstance: {},
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => ({ path }),
    getFn: async () => mockSnapshot({ storagePath: 'private_tour_photos/tour-2/user-2/file.jpg' }),
    storageRefFn: (_storage, path) => ({ path }),
    deleteObjectFn: async () => {
      throw new Error('storage down');
    },
    removeFn: async (ref) => {
      deletedDbPaths.push(ref.path);
    },
  });

  assert.deepStrictEqual(deletedDbPaths, ['private_tour_photos/tour-2/user-2/photo-99']);
  assert.deepStrictEqual(result, { success: true });
});
