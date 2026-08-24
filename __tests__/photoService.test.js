const test = require('node:test');
const assert = require('node:assert');

const firebaseModulePath = require.resolve('../firebase');
delete require.cache[firebaseModulePath];
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    storage: {},
    realtimeDbModular: {},
    auth: { currentUser: { uid: 'auth-upload-1' } },
  },
};

const {
  uploadPhoto,
  fetchTourPhotosPage,
  fetchPrivatePhotosPage,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
  uploadPhotoDirect,
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
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

test('uploadPhoto sends group media only through the authenticated server endpoint', async () => {
  const blob = createMockBlob();
  const fetchCalls = [];
  const mockFetch = async (uri, options) => {
    fetchCalls.push({ uri, options });
    if (uri === 'file://group.jpg') return { ok: true, blob: async () => blob };
    return { ok: true, json: async () => ({ success: true, photo: {
      id: 'idem-group-1', userId: 'user-9', caption: 'Lovely day!', uploaderName: 'Driver Bond',
      storagePath: 'group_tour_photos/tour-77/idem-group-1.jpg',
    } }) };
  };

  const result = await uploadPhoto('file://group.jpg', 'tour-77', 'user-9', 'Lovely day!', {
    idempotencyKey: 'idem-group-1',
    uploaderName: 'Driver Bond',
    authInstance: { currentUser: { uid: 'auth-1', getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    groupUploadEndpoint: 'https://functions.test/uploadGroupPhoto',
    fetchFn: mockFetch,
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].uri, 'https://functions.test/uploadGroupPhoto');
  assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer id-token');
  assert.equal(fetchCalls[1].options.headers['x-firebase-appcheck'], 'app-check-token');
  assert.equal(fetchCalls[1].options.body, blob);
  const metadata = JSON.parse(decodeURIComponent(fetchCalls[1].options.headers['x-group-photo-metadata']));
  assert.deepStrictEqual(metadata, {
    tourId: 'tour-77', idempotencyKey: 'idem-group-1', caption: 'Lovely day!', uploaderName: 'Driver Bond',
  });
  assert.equal(result.id, 'idem-group-1');
  assert.equal(result.sourceUrl, undefined);
  assert.strictEqual(blob.closed, true);
});

test('uploadPhoto requires an auth uid for storage metadata', async () => {
  await assert.rejects(
    uploadPhoto('file://group.jpg', 'tour-77', 'user-9', '', {
      storageInstance: {},
      realtimeDbInstance: {},
      authInstance: { currentUser: null },
    }),
    /Authenticated user required for photo upload/
  );
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
  assert.strictEqual(dbPayload.sourceUrl, undefined);
  assert.strictEqual(dbPayload.fileType, 'image/webp');
  assert.ok(!('uploaderName' in dbPayload));
  assert.strictEqual(blob.closed, true);
});

test('uploadPhoto sanitizes private owner key segments for Realtime Database paths', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => {
    Date.now = originalNow;
  });

  const ownerId = 'pax_v1:T123659:msandreayoung@yahoo.co.uk';
  const expectedOwnerKey = 'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk';
  let writePath;
  let storedPayload;

  await uploadPhoto('file://private.jpg', 'tour-55', ownerId, 'Owner with email', {
    visibility: 'private',
    storageInstance: {},
    realtimeDbInstance: {},
    fetchFn: async () => ({ ok: true, blob: async () => createMockBlob() }),
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async () => {},
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: (_db, path) => ({ path }),
    pushFn: (ref) => {
      writePath = ref.path;
      return { key: 'private-photo-sanitized' };
    },
    setFn: async (_ref, payload) => {
      storedPayload = payload;
    },
    serverTimestampFn: () => 1,
  });

  assert.strictEqual(writePath, `private_tour_photos/tour-55/${expectedOwnerKey}`);
  assert.strictEqual(
    storedPayload.storagePath,
    `private_tour_photos/tour-55/${expectedOwnerKey}/1700000000000_pax_v1_T123659_msandreayoung_yahoo.co.uk.jpg`,
  );
});


test('uploadPhoto falls back to a numeric client timestamp when server timestamp is a placeholder object', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 1700000000123;
  t.after(() => {
    Date.now = originalNow;
  });

  const blob = createMockBlob();
  let dbPayload;

  await uploadPhoto('file://private.jpg', 'tour-rt', 'owner-1', 'Fallback timestamp', {
    visibility: 'private',
    storageInstance: {},
    realtimeDbInstance: {},
    fetchFn: async () => ({ ok: true, blob: async () => blob }),
    storageRefFn: (_storage, path) => ({ path }),
    uploadBytesFn: async () => {},
    getDownloadURLFn: async (ref) => `https://example.com/${ref.path}`,
    dbRefFn: mockDbRef,
    pushFn: () => ({ key: 'private-photo-ts' }),
    setFn: async (_ref, payload) => {
      dbPayload = payload;
    },
    serverTimestampFn: () => ({ '.sv': 'timestamp' }),
  });

  assert.strictEqual(dbPayload.timestamp, 1700000000123);
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


test('resolveGroupPhotoMedia strips durable URLs and hydrates only short-lived authorized media', async () => {
  const source = [{ id: 'photo-1', storagePath: 'group_tour_photos/tour-1/a.jpg', sourceUrl: 'https://legacy-token' }];
  const result = await resolveGroupPhotoMedia({ tourId: 'tour-1', photos: source }, {
    authInstance: { currentUser: { getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    endpoint: 'https://functions.test/resolveGroupPhotoMedia',
    fetchFn: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer id-token');
      assert.equal(options.headers['x-firebase-appcheck'], 'app-check-token');
      return { ok: true, json: async () => ({
        success: true,
        expiresAtMs: Date.now() + 60_000,
        media: { 'photo-1': { sourceUrl: 'https://signed.test/source' } },
      }) };
    },
  });
  assert.equal(result[0].sourceUrl, 'https://signed.test/source');
  assert.equal(source[0].sourceUrl, 'https://legacy-token');
});

test('resolveGroupPhotoMedia keeps deleted photo references harmless when no media remains', async () => {
  const source = [{ id: 'deleted-photo', storagePath: 'group_tour_photos/tour-1/deleted.jpg' }];
  const result = await resolveGroupPhotoMedia({ tourId: 'tour-1', photos: source }, {
    authInstance: { currentUser: { getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    endpoint: 'https://functions.test/resolveGroupPhotoMedia',
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ success: true, expiresAtMs: Date.now() + 60_000, media: {} }),
    }),
  });

  assert.deepEqual(result, source);
});

test('resolvePrivatePhotoMedia hydrates short-lived URLs in memory with an authenticated bounded request', async () => {
  const requests = [];
  const photos = [{ id: 'photo-1', storagePath: 'private_tour_photos/tour-1/owner-1/a.jpg' }];
  const result = await resolvePrivatePhotoMedia({ tourId: 'tour-1', ownerKey: 'owner-1', photos }, {
    authInstance: { currentUser: { getIdToken: async () => 'token-1' } },
    endpoint: 'https://example.test/resolve',
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ success: true, expiresAtMs: Date.now() + 60_000, media: { 'photo-1': { sourceUrl: 'https://signed.test/a' } } }) };
    },
  });
  assert.strictEqual(result[0].sourceUrl, 'https://signed.test/a');
  assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer token-1');
  assert.deepStrictEqual(JSON.parse(requests[0].options.body), {
    tourId: 'tour-1', ownerKey: 'owner-1', photoIds: ['photo-1'],
  });
  assert.strictEqual(photos[0].sourceUrl, undefined);
});

test('resolvePrivatePhotoMedia rejects expired or malformed authorization responses', async () => {
  const deps = {
    authInstance: { currentUser: { getIdToken: async () => 'token-1' } },
    endpoint: 'https://example.test/resolve',
  };
  await assert.rejects(resolvePrivatePhotoMedia({ tourId: 't', ownerKey: 'o', photos: [{ id: 'p' }] }, {
    ...deps,
    fetchFn: async () => ({ ok: true, json: async () => ({ success: true, expiresAtMs: Date.now() - 1, media: {} }) }),
  }), /could not be authorized/);
  await assert.rejects(resolvePrivatePhotoMedia({ tourId: 't', ownerKey: 'o', photos: [{ id: 'p' }] }, {
    ...deps,
    fetchFn: async () => ({ ok: true, json: async () => ({ success: true, media: [] }) }),
  }), /could not be authorized/);
});

test('uploadPhoto fails closed when group upload authorization is denied', async () => {
  const blob = createMockBlob();
  await assert.rejects(
    uploadPhoto('file://group.jpg', 'tour-fail', 'user-fail', '', {
      idempotencyKey: 'failed-upload',
      authInstance: { currentUser: { uid: 'auth-1', getIdToken: async () => 'id-token' } },
      appCheckTokenFn: async () => 'app-check-token',
      groupUploadEndpoint: 'https://functions.test/uploadGroupPhoto',
      fetchFn: async (url) => url.startsWith('file:')
        ? ({ ok: true, blob: async () => blob })
        : ({ ok: false, json: async () => ({ reason: 'NOT_AUTHORIZED' }) }),
    }),
    /no longer have access/
  );
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

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(seenPaths, ['private_tour_photos/tour-A/user-5']);
  assert.deepStrictEqual(received.map((p) => p.id), ['two', 'one']);
  assert.deepStrictEqual(received.map((p) => p.ownerScope), ['user-5', 'user-5']);
  unsubscribe();
});

test('subscribeToPrivatePhotos sanitizes owner scope with invalid key characters', async () => {
  const seenPaths = [];

  subscribeToPrivatePhotos('tour-A', 'pax_v1:T123659:msandreayoung@yahoo.co.uk', () => {}, {
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => {
      seenPaths.push(path);
      return { path };
    },
    queryFn: (ref) => ref,
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (limit) => limit,
    onValueFn: (_ref, callback) => {
      callback(mockSnapshot({}));
      return () => {};
    },
  });

  assert.deepStrictEqual(seenPaths, ['private_tour_photos/tour-A/pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk']);
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
    ownerId: 'user-2',
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

test('fetchPrivatePhotosPage strips legacy durable URLs while normalizing malformed fields', async () => {
  const result = await fetchPrivatePhotosPage({
    tourId: 'tour-current',
    ownerId: 'pax_v1:ABC:current@example.com',
    limit: 5,
  }, {
    realtimeDbInstance: {},
    dbRefFn: mockDbRef,
    queryFn: (...args) => ({ args }),
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (value) => value,
    getFn: async () => mockSnapshot({
      malformed: {
        timestamp: 20,
        userId: { uid: 'bad-shape' },
        caption: { text: 'object captions crash React Text' },
        sourceUrl: { downloadURL: 'https://cdn/bad-object-url.jpg' },
        viewerUrl: '  https://cdn/good-viewer.jpg  ',
        thumbnailUrl: 'undefined',
        storagePath: ['bad-storage-path'],
        fileSize: '4000',
      },
    }),
  });

  const [photo] = result.items;
  assert.equal(photo.id, 'malformed');
  assert.equal('viewerUrl' in photo, false);
  assert.equal('thumbnailUrl' in photo, false);
  assert.equal('sourceUrl' in photo, false);
  assert.equal('caption' in photo, false);
  assert.equal('userId' in photo, false);
  assert.equal('storagePath' in photo, false);
  assert.equal(photo.fileSize, 4000);
});

test('deleteGroupPhoto deletes owned photo from storage and database', async () => {
  const requests = [];
  const result = await deleteGroupPhoto('tour-1', 'photo-1', 'owner-1', {
    authInstance: { currentUser: { getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    endpoint: 'https://functions.test/deleteGroupPhoto',
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ success: true }) };
    },
  });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer id-token');
  assert.deepStrictEqual(JSON.parse(requests[0].options.body), { tourId: 'tour-1', photoId: 'photo-1' });
  assert.deepStrictEqual(result, { success: true });
});

test('deleteGroupPhoto rejects delete when requesting user does not own photo', async () => {
  await assert.rejects(
    deleteGroupPhoto('tour-1', 'photo-1', 'intruder', {
      authInstance: { currentUser: { getIdToken: async () => 'id-token' } },
      appCheckTokenFn: async () => 'app-check-token',
      endpoint: 'https://functions.test/deleteGroupPhoto',
      fetchFn: async () => ({ ok: false, json: async () => ({ reason: 'NOT_OWNER' }) }),
    }),
    /You can only delete your own photos/
  );
});

test('deletePrivatePhoto keeps its database record when storage deletion fails so the user can retry', async () => {
  const deletedDbPaths = [];

  await assert.rejects(
    deletePrivatePhoto('tour-2', 'user-2', 'photo-99', {
      storageInstance: {},
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      getFn: async () => mockSnapshot({
        storagePath: 'private_tour_photos/tour-2/user-2/file.jpg',
        viewerStoragePath: 'private_tour_photos/tour-2/user-2/viewers/file_viewer.jpg',
        thumbnailStoragePath: 'private_tour_photos/tour-2/user-2/thumbnails/file_thumb.jpg',
      }),
      storageRefFn: (_storage, path) => ({ path }),
      deleteObjectFn: async () => {
        throw new Error('storage down');
      },
      removeFn: async (ref) => {
        deletedDbPaths.push(ref.path);
      },
    }),
    /storage down/,
  );

  assert.deepStrictEqual(deletedDbPaths, []);
});

test('deletePrivatePhoto treats an already-missing Storage object as retry-safe', async () => {
  const deletedDbPaths = [];
  const result = await deletePrivatePhoto('tour-2', 'user-2', 'photo-99', {
    storageInstance: {},
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => ({ path }),
    getFn: async () => mockSnapshot({ storagePath: 'private_tour_photos/tour-2/user-2/file.jpg' }),
    storageRefFn: (_storage, path) => ({ path }),
    deleteObjectFn: async () => {
      const error = new Error('missing');
      error.code = 'storage/object-not-found';
      throw error;
    },
    removeFn: async (ref) => deletedDbPaths.push(ref.path),
  });

  assert.deepStrictEqual(result, { success: true });
  assert.deepStrictEqual(deletedDbPaths, ['private_tour_photos/tour-2/user-2/photo-99']);
});


test('uploadPhoto reports progress updates when resumable upload is available', async () => {
  const blob = createMockBlob();
  const progress = [];

  await uploadPhoto('file://progress.jpg', 'tour-p', 'user-p', 'Progress', {
    idempotencyKey: 'progress-photo',
    authInstance: { currentUser: { uid: 'auth-1', getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    groupUploadEndpoint: 'https://functions.test/uploadGroupPhoto',
    fetchFn: async (url) => url.startsWith('file:')
      ? ({ ok: true, blob: async () => blob })
      : ({ ok: true, json: async () => ({ success: true, photo: { id: 'progress-photo' } }) }),
    onProgress: (ratio) => progress.push(ratio),
  });

  assert.deepStrictEqual(progress, [0.05, 1]);
});


test('updatePhotoCaption falls back to a numeric client timestamp when server timestamp is a placeholder object', async (t) => {
  const originalNow = Date.now;
  Date.now = () => 777;
  t.after(() => {
    Date.now = originalNow;
  });

  let payload;

  await updatePhotoCaption({
    tourId: 'tour-1',
    photoId: 'photo-1',
    userId: 'user-1',
    caption: 'Updated caption',
    visibility: 'private',
  }, {
    realtimeDbInstance: {},
    dbRefFn: () => ({ path: 'ignored' }),
    updateFn: async (_ref, values) => {
      payload = values;
    },
    serverTimestampFn: () => ({ '.sv': 'timestamp' }),
  });

  assert.strictEqual(payload.captionUpdatedAt, 777);
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

test('uploadPhoto reuses existing record when idempotency key already exists', async () => {
  const blob = createMockBlob();
  let fetchCalls = 0;

  const result = await uploadPhoto('file://group.jpg', 'tour-77', 'user-9', 'Lovely day!', {
    idempotencyKey: 'idem-123',
    uploaderName: 'Driver Bond',
    authInstance: { currentUser: { uid: 'auth-1', getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    groupUploadEndpoint: 'https://functions.test/uploadGroupPhoto',
    fetchFn: async (url) => {
      fetchCalls += 1;
      return url.startsWith('file:')
        ? { ok: true, blob: async () => blob }
        : { ok: true, json: async () => ({ success: true, photo: { id: 'existing_photo', deduped: true } }) };
    },
  });
  assert.equal(fetchCalls, 2);
  assert.equal(result.id, 'existing_photo');
  assert.equal(result.deduped, true);
});

test('uploadPhoto uses a deterministic database key for a new idempotent upload', async () => {
  const blob = createMockBlob();

  const result = await uploadPhoto('file://group.jpg', 'tour-77', 'user-9', 'New photo', {
    idempotencyKey: 'queue.item#1',
    authInstance: { currentUser: { uid: 'auth-1', getIdToken: async () => 'id-token' } },
    appCheckTokenFn: async () => 'app-check-token',
    groupUploadEndpoint: 'https://functions.test/uploadGroupPhoto',
    fetchFn: async (url) => url.startsWith('file:')
      ? ({ ok: true, blob: async () => blob })
      : ({ ok: true, json: async () => ({ success: true, photo: { id: 'queue_2E_item_23_1' } }) }),
  });
  assert.equal(result.id, 'queue_2E_item_23_1');
});

test('uploadPhotoDirect rejects payloadVersion=2 payloads without idempotencyKey', async () => {
  const result = await uploadPhotoDirect({
    payloadVersion: 2,
    tourId: 'tour-direct',
    userId: 'user-direct',
    localAssets: { sourceUri: 'file://source.jpg' },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /idempotencyKey is required/);
});
