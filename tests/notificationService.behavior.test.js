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
    if (request === 'expo-constants') {
      return {
        easConfig: { projectId: 'test-eas-project-id' },
        expoConfig: { extra: { eas: { projectId: 'test-eas-project-id' } } },
      };
    }

    if (request === 'expo-device') {
      return { isDevice: true, modelName: 'Test Device' };
    }

    if (request === 'expo-notifications') {
      return {
        AndroidImportance: { MAX: 'MAX' },
        setNotificationHandler: () => {},
        setNotificationChannelAsync: async () => {},
        getPermissionsAsync: async () => ({ status: permissionStatus }),
        requestPermissionsAsync: async () => ({ status: permissionStatus }),
        getExpoPushTokenAsync: async () => ({ data: token }),
      };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        realtimeDb: {
          ref: () => ({
            once: async () => ({ val: () => ({ preferences: { chat: 'off' }, pushTokenProvider: 'expo' }) }),
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
  assert.equal(updates.length, 1);
  assert.equal(updates[0].pushTokenStatus, 'ACTIVE');
  assert.equal(updates[0].pushTokenProvider, 'expo');
  assert.deepEqual(updates[0].preferences, {
    chatNotifications: true,
    itineraryNotifications: false,
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
});

test('registerForPushNotificationsAsync passes EAS projectId to Expo token API when available', async () => {
  const tokenCalls = [];

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-constants') {
      return {
        easConfig: { projectId: 'test-eas-project-id' },
        expoConfig: { extra: { eas: { projectId: 'fallback-project-id' } } },
      };
    }

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
        getExpoPushTokenAsync: async (options) => {
          tokenCalls.push(options);
          return { data: 'ExponentPushToken[test-token]' };
        },
      };
    }

    if (request === 'react-native') {
      return { Platform: { OS: 'ios', Version: '18.0' } };
    }

    if (request.endsWith('/firebase') || request === '../firebase') {
      return {
        realtimeDb: {
          ref: () => ({
            once: async () => ({ val: () => ({}) }),
            update: async () => {},
          }),
        },
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/notificationService')];
  const service = require('../services/notificationService');
  const token = await service.registerForPushNotificationsAsync();

  assert.equal(token, 'ExponentPushToken[test-token]');
  assert.deepEqual(tokenCalls[0], { projectId: 'test-eas-project-id' });
});
