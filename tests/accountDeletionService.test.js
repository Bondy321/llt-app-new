const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const originalLoad = Module._load;

const makeSnapshot = (value) => ({
  exists: () => Boolean(value && typeof value === 'object' && Object.keys(value).length > 0),
  val: () => value || null,
  forEach: (callback) => {
    Object.entries(value || {}).forEach(([key, childValue]) => {
      callback({
        key,
        val: () => childValue,
      });
    });
  },
});

const getPathValue = (data, path = '') => {
  if (!path) return data;
  return path.split('/').filter(Boolean).reduce((cursor, segment) => (
    cursor && Object.prototype.hasOwnProperty.call(cursor, segment) ? cursor[segment] : null
  ), data);
};

const buildDb = (data) => {
  const updates = [];
  const refs = [];

  return {
    updates,
    refs,
    ref(path = '') {
      refs.push(path);
      return {
        once: async () => makeSnapshot(getPathValue(data, path)),
        update: async (payload) => {
          updates.push({ path, payload });
        },
      };
    },
  };
};

const loadService = () => {
  Module._load = function mocked(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: { multiRemove: async () => {} } };
    }

    if (request === 'firebase/auth') {
      return { deleteUser: async () => {} };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        auth: { currentUser: null },
        authHelpers: {
          clearAuthData: async () => {},
          ensureAuthenticated: async () => ({ uid: 'fresh-auth' }),
        },
        realtimeDb: null,
      };
    }

    if (request.endsWith('/loggerService') || request === './loggerService') {
      return {
        __esModule: true,
        default: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        maskIdentifier: (value) => value || null,
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/accountDeletionService')];
  return require('../services/accountDeletionService');
};

test.afterEach(() => {
  Module._load = originalLoad;
});

test('deleteCurrentAccount clears app account records, active-tour content, local stores, and auth user', async () => {
  const { deleteCurrentAccount } = loadService();
  const db = buildDb({
    group_tour_photos: {
      TOUR_1: {
        groupMine: { userId: 'stable-pax-1' },
        groupOther: { userId: 'someone-else' },
      },
    },
    private_tour_photos: {
      TOUR_1: {
        'stable-pax-1': {
          privateMine: { userId: 'stable-pax-1' },
        },
      },
    },
    chats: {
      TOUR_1: {
        messages: {
          mine: {
            senderId: 'stable-pax-1',
            text: 'hello',
            imageUrl: 'https://example.com/photo.jpg',
            thumbnailUrl: 'https://example.com/thumb.jpg',
            reactions: { wave: { 'stable-pax-1': true, other: true } },
          },
          reacted: {
            senderId: 'other',
            text: 'hi',
            reactions: { thumbs: { 'stable-pax-1': true } },
          },
        },
      },
    },
  });

  const deletedUsers = [];
  const deletedGroupPhotos = [];
  const deletedPrivatePhotos = [];
  const localRemoved = [];
  const providerDeletes = [];
  let clearAuthCalled = false;
  let ensureAuthCalled = false;

  const result = await deleteCurrentAccount({
    currentUser: { uid: 'auth-1' },
    db,
    tourData: { id: 'tour 1' },
    bookingData: { id: 'T-100' },
    canonicalIdentity: {
      principalId: 'stable-pax-1',
      stablePassengerId: 'stable-pax-1',
      authUid: 'auth-1',
      principalType: 'passenger',
    },
    identityBinding: { stablePassengerKey: 'stable-pax-1' },
    sessionStorage: { multiRemove: async (keys) => localRemoved.push(['session', keys]) },
    sessionKeys: { TOUR_DATA: '@LLT:tourData', BOOKING_DATA: '@LLT:bookingData' },
    localStorage: { multiRemove: async (keys) => localRemoved.push(['async', keys]) },
    providerFactory: ({ namespace }) => ({
      multiDeleteAsync: async (keys) => {
        providerDeletes.push({ namespace, keys });
        return true;
      },
    }),
    photoApi: {
      deleteGroupPhoto: async (tourId, photoId, ownerId) => deletedGroupPhotos.push({ tourId, photoId, ownerId }),
      deletePrivatePhoto: async (tourId, ownerId, photoId) => deletedPrivatePhotos.push({ tourId, ownerId, photoId }),
    },
    authHelpersOverride: {
      clearAuthData: async () => {
        clearAuthCalled = true;
      },
      ensureAuthenticated: async () => {
        ensureAuthCalled = true;
        return { uid: 'fresh-auth' };
      },
    },
    deleteUserFn: async (user) => deletedUsers.push(user.uid),
  });

  assert.equal(result.success, true);
  assert.equal(result.deletedAuthUid, 'auth-1');
  assert.equal(result.replacementAuthUid, 'fresh-auth');
  assert.deepEqual(deletedUsers, ['auth-1']);
  assert.equal(clearAuthCalled, true);
  assert.equal(ensureAuthCalled, true);
  assert.deepEqual(deletedGroupPhotos, [{ tourId: 'TOUR_1', photoId: 'groupMine', ownerId: 'stable-pax-1' }]);
  assert.deepEqual(deletedPrivatePhotos, [{ tourId: 'TOUR_1', ownerId: 'stable-pax-1', photoId: 'privateMine' }]);

  const updatePayload = db.updates[0].payload;
  assert.equal(updatePayload['users/auth-1'], null);
  assert.equal(updatePayload['logs/auth-1'], null);
  assert.equal(updatePayload['logs/stable-pax-1'], undefined);
  assert.equal(updatePayload['identity_bindings/stable-pax-1/auth-1'], null);
  assert.equal(updatePayload['tours/TOUR_1/liveTracking/auth-1'], null);
  assert.equal(updatePayload['tours/TOUR_1/liveTracking/stable-pax-1'], undefined);
  assert.equal(updatePayload['chats/TOUR_1/messages/mine/deleted'], true);
  assert.equal(updatePayload['chats/TOUR_1/messages/mine/text'], '');
  assert.equal(updatePayload['chats/TOUR_1/messages/mine/imageUrl'], undefined);
  assert.equal(updatePayload['chats/TOUR_1/messages/mine/thumbnailUrl'], undefined);
  assert.equal(updatePayload['chats/TOUR_1/messages/mine/reactions/wave/stable-pax-1'], null);
  assert.equal(updatePayload['chats/TOUR_1/messages/reacted/reactions/thumbs/stable-pax-1'], null);
  assert.equal(db.refs.includes('private_tour_photos/TOUR_1/auth-1'), false);

  assert.ok(localRemoved.some(([source]) => source === 'session'));
  assert.ok(localRemoved.some(([source]) => source === 'async'));
  assert.ok(providerDeletes.some((entry) => entry.namespace === 'LLT_AUTH'));
  assert.ok(providerDeletes.some((entry) => entry.namespace === 'LLT_LOGS'));
  assert.ok(providerDeletes.some((entry) => entry.namespace === 'LLT_OFFLINE'));
});

test('deleteCurrentAccount removes driver-owned internal chat and driver location state', async () => {
  const { deleteCurrentAccount } = loadService();
  const db = buildDb({
    internal_chats: {
      TOUR_1: {
        messages: {
          mine: {
            senderId: 'driver:D-7',
            senderStableId: 'driver:D-7',
            text: 'driver note',
          },
          other: {
            senderId: 'driver:D-8',
            senderStableId: 'driver:D-8',
            text: 'other note',
          },
        },
      },
    },
  });

  const result = await deleteCurrentAccount({
    currentUser: { uid: 'driver-auth-1' },
    db,
    tourData: { id: 'tour 1' },
    bookingData: { id: 'D-7' },
    canonicalIdentity: {
      principalId: 'driver:D-7',
      principalType: 'driver',
      authUid: 'driver-auth-1',
      driverId: 'D-7',
    },
    isDriverSession: true,
    sessionStorage: { multiRemove: async () => {} },
    localStorage: { multiRemove: async () => {} },
    providerFactory: () => ({ multiDeleteAsync: async () => true }),
    photoApi: {},
    authHelpersOverride: {
      clearAuthData: async () => {},
      ensureAuthenticated: async () => ({ uid: 'fresh-driver-auth' }),
    },
    deleteUserFn: async () => {},
  });

  assert.equal(result.success, true);

  const updatePayload = db.updates[0].payload;
  assert.equal(updatePayload['users/driver-auth-1'], null);
  assert.equal(updatePayload['drivers/D-7/authUid'], null);
  assert.equal(updatePayload['tours/TOUR_1/driverLocation'], null);
  assert.equal(updatePayload['internal_chats/TOUR_1/messages/mine'], null);
  assert.equal(updatePayload['internal_chats/TOUR_1/messages/other'], undefined);
});

test('deleteCurrentAccount returns a user-facing error when there is no signed-in app account', async () => {
  const { deleteCurrentAccount } = loadService();

  const result = await deleteCurrentAccount({
    currentUser: null,
    db: buildDb({}),
  });

  assert.equal(result.success, false);
  assert.match(result.error, /No signed-in app account/);
});
