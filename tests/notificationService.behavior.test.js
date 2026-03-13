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

const buildNotificationService = ({ permission = 'granted', token = 'ExponentPushToken[test-token]' } = {}) => {
  const updates = [];
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
        realtimeDb: {
          ref: () => ({
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
          }),
        },
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/notificationService')];
  const service = require('../services/notificationService');
  return { service, updates, setPermission: (next) => { permissionStatus = next; } };
};

test.after(() => {
  Module._load = originalLoad;
});

test('saveUserPreferences normalizes legacy preference shape and persists token metadata', async () => {
  const { service, updates } = buildNotificationService({ permission: 'granted' });

  const result = await service.saveUserPreferences('user-1', {
    notifications: { messages: 'enabled', tripUpdates: 0 },
  });

  assert.equal(result.success, true);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].__tokenRequestOptions, { projectId: 'test-project-id' });
  assert.equal(updates[1].pushTokenStatus, 'ACTIVE');
  assert.equal(updates[1].pushTokenProvider, 'expo');
  assert.deepEqual(updates[1].preferences, {
    chatNotifications: true,
    itineraryNotifications: false,
    ops: {
      driver_updates: true,
      itinerary_changes: false,
      group_chat: true,
      group_photos: true,
    },
    marketing: {
      steam_trains: false,
      mystery_tours: true,
      scotland_classics: false,
      vip_experiences: false,
      hiking_nature: false,
    },
  });
});

test('saveUserPreferences handles denied permission path without throwing and marks token unavailable', async () => {
  const { service, updates, setPermission } = buildNotificationService({ permission: 'denied' });
  setPermission('denied');

  const result = await service.saveUserPreferences('user-2', {
    chatNotifications: true,
    itineraryNotifications: true,
  });

  assert.equal(result.success, true);
  assert.ok(result.warning.includes('notifications are disabled'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].pushTokenStatus, 'UNAVAILABLE');
  assert.equal(updates[0].preferences.chatNotifications, true);
  assert.equal(updates[0].preferences.itineraryNotifications, true);
  assert.equal(updates[0].preferences.ops.group_chat, true);
  assert.equal(updates[0].preferences.ops.itinerary_changes, true);
  assert.equal(updates[0].preferences.marketing.mystery_tours, true);
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
