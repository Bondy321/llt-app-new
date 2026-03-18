const test = require('node:test');
const assert = require('node:assert');

const {
  uploadPhoto,
  fetchTourPhotosPage,
  fetchPrivatePhotosPage,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
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
    fullUrl: 'https://example.com/group_tour_photos/tour-77/1700000000000_user-9.jpg',
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
  assert.strictEqual(dbPayload.fullUrl, 'https://example.com/private_tour_photos/tour-55/user-private/1700000000000_user-private.webp');
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


test('uploadPhoto stores thumbnail and optimization metadata when provided', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const mainBlob = createMockBlob({ size: 2048, type: 'image/jpeg' });
  const thumbBlob = createMockBlob({ size: 512, type: 'image/jpeg' });

  const mockFetch = async (uri) => ({
    ok: true,
    blob: async () => (uri.includes('thumb') ? thumbBlob : mainBlob),
  });

  const uploaded = [];
  let payload;
  await uploadPhoto('file://main.jpg', 'tour-thumb', 'user-thumb', 'Thumb test', {
    thumbnailUri: 'file://thumb.jpg',
    optimizationMetrics: {
      originalSizeBytes: 4096,
      optimizedSizeBytes: 2048,
      thumbnailSizeBytes: 512,
      optimizationRatio: 0.5,
    },
    storageInstance: {},
    realtimeDbInstance: {},
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async (ref) => {
      uploaded.push(ref.path);
    },
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: mockDbRef,
    pushFn: () => ({ key: 'thumb-photo' }),
    setFn: async (_ref, value) => {
      payload = value;
    },
    serverTimestampFn: () => 42,
    fetchFn: mockFetch,
  });

  assert.deepStrictEqual(uploaded, [
    'group_tour_photos/tour-thumb/1700000000000_user-thumb.jpg',
    'group_tour_photos/tour-thumb/thumbnails/1700000000000_user-thumb_thumb.jpg',
  ]);
  assert.strictEqual(payload.thumbnailUrl, 'https://example.com/group_tour_photos/tour-thumb/thumbnails/1700000000000_user-thumb_thumb.jpg');
  assert.strictEqual(payload.thumbnailStoragePath, 'group_tour_photos/tour-thumb/thumbnails/1700000000000_user-thumb_thumb.jpg');
  assert.deepStrictEqual(payload.optimization, {
    originalSizeBytes: 4096,
    optimizedSizeBytes: 2048,
    thumbnailSizeBytes: 512,
    optimizationRatio: 0.5,
  });
  assert.strictEqual(mainBlob.closed, true);
  assert.strictEqual(thumbBlob.closed, true);
});



test('uploadPhoto continues when thumbnail upload fails and still writes full photo record', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const mainBlob = createMockBlob({ size: 2048, type: 'image/jpeg' });
  const thumbBlob = createMockBlob({ size: 512, type: 'image/jpeg' });

  const mockFetch = async (uri) => ({
    ok: true,
    blob: async () => (uri.includes('thumb') ? thumbBlob : mainBlob),
  });

  let payload;
  const uploadedPaths = [];
  await uploadPhoto('file://main.jpg', 'tour-thumb-fallback', 'user-thumb', 'Thumb optional', {
    thumbnailUri: 'file://thumb.jpg',
    storageInstance: {},
    realtimeDbInstance: {},
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async (ref) => {
      uploadedPaths.push(ref.path);
      if (ref.path.includes('/thumbnails/')) {
        throw new Error('thumbnail path denied');
      }
    },
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: mockDbRef,
    pushFn: () => ({ key: 'thumb-fallback-photo' }),
    setFn: async (_ref, value) => {
      payload = value;
    },
    serverTimestampFn: () => 42,
    fetchFn: mockFetch,
  });

  assert.deepStrictEqual(uploadedPaths, [
    'group_tour_photos/tour-thumb-fallback/1700000000000_user-thumb.jpg',
    'group_tour_photos/tour-thumb-fallback/thumbnails/1700000000000_user-thumb_thumb.jpg',
  ]);
  assert.strictEqual(payload.url, 'https://example.com/group_tour_photos/tour-thumb-fallback/1700000000000_user-thumb.jpg');
  assert.ok(!('thumbnailUrl' in payload));
  assert.ok(!('thumbnailStoragePath' in payload));
  assert.strictEqual(mainBlob.closed, true);
  assert.strictEqual(thumbBlob.closed, true);
});

test('uploadPhoto retries getDownloadURL for transient storage errors before succeeding', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const blob = createMockBlob();
  let attempts = 0;

  let payload;
  await uploadPhoto('file://group.jpg', 'tour-retry', 'user-retry', '', {
    storageInstance: {},
    realtimeDbInstance: {},
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async () => {},
    getDownloadURLFn: async (ref) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('object-not-found while edge cache catches up');
        error.code = 'storage/object-not-found';
        throw error;
      }
      return `https://example.com/${ref.path}`;
    },
    dbRefFn: mockDbRef,
    pushFn: () => ({ key: 'photo-retry' }),
    setFn: async (_ref, value) => {
      payload = value;
    },
    serverTimestampFn: () => 123,
    fetchFn: async () => ({ ok: true, blob: async () => blob }),
  });

  assert.strictEqual(attempts, 3);
  assert.strictEqual(payload.url, 'https://example.com/group_tour_photos/tour-retry/1700000000000_user-retry.jpg');
});

test('uploadPhoto fails fast on non-retryable getDownloadURL errors', async () => {
  const blob = createMockBlob();
  let attempts = 0;

  await assert.rejects(
    uploadPhoto('file://group.jpg', 'tour-fail', 'user-fail', '', {
      storageInstance: {},
      realtimeDbInstance: {},
      storageRefFn: (_storage, path) => ({ path }),
      uploadBytesFn: async () => {},
      getDownloadURLFn: async () => {
        attempts += 1;
        const error = new Error('permission denied');
        error.code = 'storage/unauthorized';
        throw error;
      },
      dbRefFn: mockDbRef,
      pushFn: () => ({ key: 'photo-fail' }),
      setFn: async () => {},
      serverTimestampFn: () => 123,
      fetchFn: async () => ({ ok: true, blob: async () => blob }),
    }),
    /permission denied/
  );

  assert.strictEqual(attempts, 1);
});

test('subscribeToTourPhotos sorts by descending timestamp and returns a safe fallback when mapping fails', async () => {
  const delivered = [];

  const unsubscribe = subscribeToTourPhotos('tour-1', (photos) => {
    delivered.push(photos);
  }, {
    realtimeDbInstance: {},
    dbRefFn: mockDbRef,
    queryFn: (ref) => ref,
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (limit) => limit,
    onValueFn: (_ref, callback, onError) => {
      callback(mockSnapshot({ first: { timestamp: 1 }, second: { timestamp: 10 } }));
      onError(new Error('listener failed'));
      return () => {};
    },
  });

  assert.deepStrictEqual(delivered[0].map((p) => p.id), ['second', 'first']);
  assert.deepStrictEqual(delivered[1], []);
  unsubscribe();
});

test('subscribeToPrivatePhotos scopes path to user and sorts newest first', async () => {
  const seenPaths = [];
  let received;

  const unsubscribe = subscribeToPrivatePhotos('tour-A', 'user-5', (photos) => {
    received = photos;
  }, {
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => {
      seenPaths.push(path);
      return { path };
    },
    queryFn: (ref) => ref,
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (limit) => limit,
    onValueFn: (_ref, callback) => {
      callback(mockSnapshot({
        one: { timestamp: 2 },
        two: { timestamp: 22 },
      }));
      return () => {};
    },
  });

  assert.deepStrictEqual(seenPaths, ['private_tour_photos/tour-A/user-5']);
  assert.deepStrictEqual(received.map((p) => p.id), ['two', 'one']);
  assert.deepStrictEqual(received.map((p) => p.ownerScope), ['user-5', 'user-5']);
  unsubscribe();
});

test('fetchTourPhotosPage returns bounded page with cursor and hasMore contract', async () => {
  const queryCalls = [];

  const result = await fetchTourPhotosPage({ tourId: 'tour-1', limit: 2 }, {
    realtimeDbInstance: {},
    dbRefFn: mockDbRef,
    queryFn: (...args) => {
      queryCalls.push(args);
      return { args };
    },
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (value) => value,
    endAtFn: (value) => value,
    getFn: async () => mockSnapshot({
      alpha: { timestamp: 10 },
      beta: { timestamp: 40 },
      gamma: { timestamp: 30 },
    }),
  });

  assert.strictEqual(queryCalls.length, 1);
  assert.deepStrictEqual(result.items.map((item) => item.id), ['beta', 'gamma']);
  assert.strictEqual(result.hasMore, true);
  assert.deepStrictEqual(result.nextCursor, { timestamp: 30, id: 'gamma' });
});

test('fetchPrivatePhotosPage applies endBefore cursor and normalizes timestamps safely', async () => {
  const queryCalls = [];

  const result = await fetchPrivatePhotosPage({
    tourId: 'tour-2',
    userId: 'user-2',
    limit: 3,
    endBefore: { timestamp: '120', id: 'cursor-a' },
  }, {
    realtimeDbInstance: {},
    dbRefFn: mockDbRef,
    queryFn: (...args) => {
      queryCalls.push(args);
      return { args };
    },
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (value) => value,
    endAtFn: (value) => value,
    getFn: async () => mockSnapshot({
      withDateObj: { timestamp: new Date('2026-01-01T00:00:00.000Z') },
      withNumberString: { timestamp: '100' },
      withInvalid: { timestamp: 'not-a-number' },
    }),
  });

  assert.strictEqual(queryCalls.length, 1);
  assert.strictEqual(queryCalls[0][2], 120);
  assert.strictEqual(queryCalls[0][3], 4);
  assert.deepStrictEqual(result.items.map((item) => item.id), ['withDateObj', 'withNumberString', 'withInvalid']);
  assert.strictEqual(result.items[0].timestamp, Number(new Date('2026-01-01T00:00:00.000Z')));
  assert.strictEqual(result.items[2].timestamp, 0);
  assert.strictEqual(result.hasMore, false);
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
      thumbnailStoragePath: 'group_tour_photos/tour-1/thumbnails/file_thumb.jpg',
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
    'delete-storage:group_tour_photos/tour-1/thumbnails/file_thumb.jpg',
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
    getFn: async () => mockSnapshot({ storagePath: 'private_tour_photos/tour-2/user-2/file.jpg', thumbnailStoragePath: 'private_tour_photos/tour-2/user-2/thumbnails/file_thumb.jpg' }),
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


test('uploadPhoto reports progress updates when resumable upload is available', async () => {
  const blob = createMockBlob();
  const progress = [];

  await uploadPhoto('file://progress.jpg', 'tour-p', 'user-p', 'Progress', {
    storageInstance: {},
    realtimeDbInstance: {},
    fetchFn: async () => ({ ok: true, blob: async () => blob }),
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async () => {},
    uploadBytesResumableFn: () => ({
      snapshot: { bytesTransferred: 100, totalBytes: 100 },
      on: (_event, onNext, _onError, onComplete) => {
        onNext({ bytesTransferred: 25, totalBytes: 100 });
        onNext({ bytesTransferred: 100, totalBytes: 100 });
        onComplete();
      },
    }),
    getDownloadURLFn: async () => 'https://example.com/progress.jpg',
    dbRefFn: mockDbRef,
    pushFn: () => ({ key: 'progress-photo' }),
    setFn: async () => {},
    serverTimestampFn: () => 1,
    onProgress: (ratio) => progress.push(ratio),
  });

  assert.deepStrictEqual(progress, [0.25, 1]);
});

test('updatePhotoCaption writes caption edit metadata for group photo', async () => {
  let targetPath;
  let payload;

  const result = await updatePhotoCaption({
    tourId: 'tour-1',
    photoId: 'photo-1',
    userId: 'user-1',
    caption: 'Updated caption',
    visibility: 'group',
  }, {
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => {
      targetPath = path;
      return { path };
    },
    updateFn: async (_ref, values) => {
      payload = values;
    },
    serverTimestampFn: () => 555,
  });

  assert.strictEqual(targetPath, 'group_tour_photos/tour-1/photo-1');
  assert.deepStrictEqual(payload, {
    caption: 'Updated caption',
    captionUpdatedAt: 555,
    captionEditedBy: 'user-1',
  });
  assert.deepStrictEqual(result, { success: true });
});
