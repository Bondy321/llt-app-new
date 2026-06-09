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

const buildNotificationService = ({
  permission = 'granted',
  token = 'ExponentPushToken[test-token]',
  authUid = null,
} = {}) => {
  const updates = [];
  const refPaths = [];
  let permissionStatus = permission;

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-device') {
      return { isDevice: true, modelName: 'Test Device' };
    }

    if (request === 'expo-notifications') {
      return {
        AndroidImportance: { MAX: 'MAX' },
        IosAuthorizationStatus: {
          PROVISIONAL: 3,
          EPHEMERAL: 4,
        },
        setNotificationHandler: () => {},
        setNotificationChannelAsync: async () => {},
        getPermissionsAsync: async () => ({ status: permissionStatus }),
        requestPermissionsAsync: async () => ({ status: permissionStatus }),
        getExpoPushTokenAsync: async (options) => {
          updates.push({ __tokenRequestOptions: options ?? null });
          return { data: token };
        },
      };
    }

    if (request === 'expo-constants') {
      return {
        expoConfig: {
          extra: {
            eas: {
              projectId: 'test-project-id',
            },
          },
        },
        easConfig: null,
      };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        auth: authUid ? { currentUser: { uid: authUid } } : { currentUser: null },
        realtimeDb: {
          ref: (path = '') => {
            refPaths.push(path);
            return {
              once: async () => ({
                val: () => ({
                  preferences: {
                    ops: { group_photos: true },
                    marketing: { mystery_tours: true },
                  },
                  pushTokenProvider: 'expo',
                }),
              }),
              update: async (payload) => {
                updates.push(payload);
              },
            };
          },
        },
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/notificationService')];
  const service = require('../services/notificationService');
  return { service, updates, refPaths, setPermission: (next) => { permissionStatus = next; } };
};

test.after(() => {
  Module._load = originalLoad;
});

test('saveUserPreferences persists canonical preference schema and token metadata', async () => {
  const { service, updates } = buildNotificationService({ permission: 'granted' });

  const result = await service.saveUserPreferences('user-1', {
    ops: {
      group_chat: true,
      itinerary_changes: false,
      group_photos: true,
    },
    marketing: {
      mystery_tours: true,
    },
  });

  assert.equal(result.success, true);
  assert.equal(updates.length, 3);
  assert.equal(updates[0].pushPermissionState, 'granted');
  assert.deepEqual(updates[1].__tokenRequestOptions, { projectId: 'test-project-id' });
  assert.equal(updates[2].pushToken, 'ExponentPushToken[test-token]');
  assert.equal(updates[2].pushTokenStatus, 'ACTIVE');
  assert.equal(updates[2].pushTokenProvider, 'expo');
  assert.equal(updates[2].pushTokenInvalidReason, null);
  assert.equal(updates[2].pushPermissionState, 'granted');
  assert.deepEqual(updates[2].preferences, {
    ops: {
      driver_updates: true,
      itinerary_changes: false,
      group_chat: true,
      group_photos: true,
    },
    marketing: {
      day_trips: false,
      mystery_breaks: true,
      scotland_highlands_islands: false,
      isle_of_ireland: false,
      european_breaks: false,
      steam_train_tours: false,
      cruises_ferries: false,
      theatre_concerts: false,
      sporting_breaks: false,
      history_military_breaks: false,
    },
  });
});

test('saveUserPreferences handles denied permission path without throwing and marks token unavailable', async () => {
  const { service, updates, setPermission } = buildNotificationService({ permission: 'denied' });
  setPermission('denied');

  const result = await service.saveUserPreferences('user-2', {
    ops: {
      group_chat: true,
      itinerary_changes: true,
    },
  });

  assert.equal(result.success, true);
  assert.ok(result.warning.includes('notifications are disabled'));
  assert.equal(updates.length, 2);
  assert.equal(updates[0].pushPermissionState, 'denied');
  assert.equal(updates[1].pushToken, null);
  assert.equal(updates[1].pushTokenStatus, 'UNAVAILABLE');
  assert.equal(updates[1].pushTokenInvalidReason, null);
  assert.equal(updates.some((entry) => entry.__tokenRequestOptions), false);
  assert.equal(updates[1].pushPermissionState, 'denied');
  assert.equal(updates[1].preferences.ops.group_chat, true);
  assert.equal(updates[1].preferences.ops.itinerary_changes, true);
  assert.equal(updates[1].preferences.marketing.mystery_breaks, true);
});

test('primeNotificationPermissions reports denied state when permission can still be requested later', async () => {
  const { service, setPermission } = buildNotificationService({ permission: 'undetermined' });
  setPermission('undetermined');

  const result = await service.primeNotificationPermissions({
    userId: 'user-4',
    requestIfNeeded: false,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.state, 'denied');
  assert.equal(result.data.granted, false);
  assert.equal(result.data.canAskAgain, true);
});

test('registerForPushNotificationsAsync accepts iOS provisional permissions and still returns a token', async () => {
  const original = Module._load;
  const tokenRequests = [];

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-device') {
      return { isDevice: true, modelName: 'Test Device' };
    }

    if (request === 'expo-notifications') {
      return {
        AndroidImportance: { MAX: 'MAX' },
        IosAuthorizationStatus: {
          PROVISIONAL: 3,
          EPHEMERAL: 4,
        },
        setNotificationHandler: () => {},
        setNotificationChannelAsync: async () => {},
        getPermissionsAsync: async () => ({
          status: 'undetermined',
          ios: { status: 3 },
        }),
        requestPermissionsAsync: async () => ({
          status: 'undetermined',
          ios: { status: 3 },
        }),
        getExpoPushTokenAsync: async (options) => {
          tokenRequests.push(options ?? null);
          return { data: 'ExponentPushToken[provisional]' };
        },
      };
    }

    if (request === 'expo-constants') {
      return {
        expoConfig: {
          extra: {
            eas: {
              projectId: 'test-project-id',
            },
          },
        },
        easConfig: null,
      };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        realtimeDb: {
          ref: () => ({
            update: async () => {},
            once: async () => ({ val: () => null }),
          }),
        },
      };
    }

    return original(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/notificationService')];
  const service = require('../services/notificationService');

  const token = await service.registerForPushNotificationsAsync();
  assert.equal(token, 'ExponentPushToken[provisional]');
  assert.deepEqual(tokenRequests, [{ projectId: 'test-project-id' }]);

  Module._load = original;
});

test('getUserPreferences can throw explicit fetch errors for UI empty/error state handling', async () => {
  const original = Module._load;

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-device') {
      return { isDevice: true, modelName: 'Test Device' };
    }

    if (request === 'expo-notifications') {
      return {
        AndroidImportance: { MAX: 'MAX' },
        setNotificationHandler: () => {},
        setNotificationChannelAsync: async () => {},
        getPermissionsAsync: async () => ({ status: 'granted' }),
        requestPermissionsAsync: async () => ({ status: 'granted' }),
        getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[test-token]' }),
      };
    }

    if (request === 'expo-constants') {
      return { expoConfig: { extra: { eas: { projectId: 'test-project-id' } } }, easConfig: null };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        realtimeDb: {
          ref: () => ({
            once: async () => {
              throw new Error('simulated fetch failure');
            },
          }),
        },
      };
    }

    return original(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/notificationService')];
  const service = require('../services/notificationService');

  await assert.rejects(
    () => service.getUserPreferences('user-3', { throwOnError: true }),
    /simulated fetch failure/
  );

  Module._load = original;
});

test('getUserPreferences uses authenticated uid when provided userId is principal-scoped', async () => {
  const { service, refPaths } = buildNotificationService({ authUid: 'auth-uid-42' });

  await service.getUserPreferences('driver:D-BONDY', { throwOnError: true });

  assert.ok(refPaths.includes('users/auth-uid-42/preferences'));
  assert.equal(refPaths.includes('users/driver:D-BONDY/preferences'), false);
});

test('getUserPreferences normalizes legacy marketing preference keys', async () => {
  const { service } = buildNotificationService();

  const preferences = await service.getUserPreferences('user-legacy', { throwOnError: true });

  assert.equal(preferences.marketing.mystery_breaks, true);
  assert.equal(preferences.marketing.mystery_tours, undefined);
  assert.equal(Object.keys(preferences.marketing).length, 10);
});

test('saveUserPreferences writes to authenticated uid when provided userId is principal-scoped', async () => {
  const { service, refPaths } = buildNotificationService({ authUid: 'auth-uid-99' });

  const result = await service.saveUserPreferences('stable-passenger-123', {
    ops: { group_chat: true },
  });

  assert.equal(result.success, true);
  assert.ok(refPaths.includes('users/auth-uid-99'));
  assert.equal(refPaths.includes('users/stable-passenger-123'), false);
});
