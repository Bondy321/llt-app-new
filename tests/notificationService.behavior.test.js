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
  lastNotificationResponse = null,
  existingUserData = null,
  profileFetchError = null,
} = {}) => {
  const updates = [];
  const refPaths = [];
  let permissionStatus = permission;
  let permissionChecks = 0;
  let responseHandler = null;
  let responseListenerRemoved = false;

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
        getPermissionsAsync: async () => { permissionChecks += 1; return { status: permissionStatus }; },
        requestPermissionsAsync: async () => { permissionChecks += 1; return { status: permissionStatus }; },
        getLastNotificationResponseAsync: async () => lastNotificationResponse,
        addNotificationResponseReceivedListener: (handler) => {
          responseHandler = handler;
          return { remove: () => { responseListenerRemoved = true; } };
        },
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
              once: async () => {
                if (profileFetchError) throw profileFetchError;
                return ({
                val: () => existingUserData || ({
                  preferences: {
                    ops: { group_photos: true },
                    marketing: { mystery_tours: true },
                  },
                  pushTokenProvider: 'expo',
                }),
              });
              },
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
  return {
    service,
    updates,
    refPaths,
    setPermission: (next) => { permissionStatus = next; },
    emitNotificationResponse: (response) => responseHandler?.(response),
    wasResponseListenerRemoved: () => responseListenerRemoved,
    getPermissionCheckCount: () => permissionChecks,
  };
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
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].__tokenRequestOptions, { projectId: 'test-project-id' });
  assert.equal(updates[1].pushToken, 'ExponentPushToken[test-token]');
  assert.equal(updates[1].pushTokenStatus, 'ACTIVE');
  assert.equal(updates[1].pushTokenProvider, 'expo');
  assert.equal(updates[1].pushTokenInvalidReason, null);
  assert.equal(updates[1].pushPermissionState, 'granted');
  assert.deepEqual(updates[1].preferences, {
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
  assert.equal(updates.length, 1);
  assert.equal(updates[0].pushToken, null);
  assert.equal(updates[0].pushTokenStatus, 'UNAVAILABLE');
  assert.equal(updates[0].pushTokenInvalidReason, null);
  assert.equal(updates.some((entry) => entry.__tokenRequestOptions), false);
  assert.equal(updates[0].pushPermissionState, 'denied');
  assert.equal(updates[0].preferences.ops.group_chat, true);
  assert.equal(updates[0].preferences.ops.itinerary_changes, true);
  assert.equal(updates[0].preferences.marketing.mystery_breaks, true);
});

test('saveUserPreferences reuses a resolved onboarding permission without probing twice', async () => {
  const { service, getPermissionCheckCount, updates } = buildNotificationService({ permission: 'granted' });

  const result = await service.saveUserPreferences('user-onboarding', {
    ops: { group_chat: true },
  }, {
    permissionState: {
      state: 'granted',
      granted: true,
      canAskAgain: true,
      status: 'granted',
      description: 'Notifications are enabled.',
    },
  });

  assert.equal(result.success, true);
  assert.equal(getPermissionCheckCount(), 0);
  assert.equal(updates.filter((entry) => entry.__tokenRequestOptions).length, 1);
  assert.equal(updates.at(-1).pushPermissionState, 'granted');
});

test('saveUserPreferences does not prompt when the remote profile cannot be loaded', async () => {
  const { service, getPermissionCheckCount } = buildNotificationService({
    permission: 'undetermined',
    profileFetchError: new Error('offline'),
  });

  const result = await service.saveUserPreferences('user-offline', { ops: { group_chat: true } });

  assert.equal(result.success, false);
  assert.equal(getPermissionCheckCount(), 0);
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

test('deactivatePushToken suppresses delivery for the authenticated signed-out session', async () => {
  const { service, updates, refPaths } = buildNotificationService({ authUid: 'auth-logout-1' });

  const result = await service.deactivatePushToken('stable-passenger-ignored');

  assert.equal(result.success, true);
  assert.ok(refPaths.includes('users/auth-logout-1'));
  assert.equal(refPaths.includes('users/stable-passenger-ignored'), false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].pushToken, null);
  assert.equal(updates[0].pushTokenStatus, 'UNAVAILABLE');
  assert.equal(updates[0].pushTokenInvalidReason, 'SIGNED_OUT');
  assert.match(updates[0].pushTokenUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('restorePushTokenForSession silently reactivates a token after the next successful login', async () => {
  const { service, updates } = buildNotificationService({
    authUid: 'auth-restore-1',
    existingUserData: {
      preferences: { ops: { group_chat: true } },
      pushTokenStatus: 'UNAVAILABLE',
      pushTokenInvalidReason: 'SIGNED_OUT',
    },
  });

  const result = await service.restorePushTokenForSession('auth-restore-1');

  assert.equal(result.success, true);
  assert.equal(result.restored, true);
  const restoredPatch = updates.at(-1);
  assert.equal(restoredPatch.pushToken, 'ExponentPushToken[test-token]');
  assert.equal(restoredPatch.pushTokenStatus, 'ACTIVE');
  assert.equal(restoredPatch.pushTokenInvalidReason, null);
  assert.equal(restoredPatch.pushPermissionState, 'granted');
  assert.equal(restoredPatch.pushPermissionCanAskAgain, true);
  assert.match(restoredPatch.pushPermissionUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('notification response subscription routes active-tour taps once and removes its listener', async () => {
  const response = {
    notification: {
      request: {
        identifier: 'tap-contract-1',
        content: { data: { screen: 'Itinerary', tourId: 'TOUR_1', noticeId: 'notice-1' } },
      },
    },
  };
  const harness = buildNotificationService({ lastNotificationResponse: response });
  const routes = [];
  const rejected = [];
  const unsubscribe = harness.service.subscribeToNotificationResponses({
    getContext: () => ({ activeTourId: 'TOUR_1', isDriver: false }),
    onNavigate: async (route) => routes.push(route),
    onRejected: (reason) => rejected.push(reason),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.emitNotificationResponse(response);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].screen, 'Itinerary');
  assert.equal(routes[0].params.noticeId, 'notice-1');
  assert.deepEqual(rejected, []);

  unsubscribe();
  assert.equal(harness.wasResponseListenerRemoved(), true);
});

test('notification response can retry after navigation fails and deduplicates only after success', async () => {
  const response = {
    notification: {
      request: {
        identifier: 'tap-retry-contract-1',
        content: { data: { screen: 'Chat', tourId: 'TOUR_1', messageId: 'message-1' } },
      },
    },
  };
  const harness = buildNotificationService();
  let attempts = 0;
  const unsubscribe = harness.service.subscribeToNotificationResponses({
    getContext: () => ({ activeTourId: 'TOUR_1', isDriver: false }),
    onNavigate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('navigation not ready');
    },
  });

  await harness.emitNotificationResponse(response);
  await harness.emitNotificationResponse(response);
  await harness.emitNotificationResponse(response);

  assert.equal(attempts, 2);
  unsubscribe();
});
