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
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};

const flush = async (turns = 12) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const clearCoordinator = () => {
  delete require.cache[require.resolve('../services/notifications/notificationRegistrationCoordinator')];
};

const buildCoordinator = ({
  permission = { state: 'granted', granted: true, canAskAgain: true },
  token = 'ExponentPushToken[canonical-expo-token]',
  storageValues = {},
  permissionPromise = null,
  reconcilePromise = null,
  now = () => 1_000,
} = {}) => {
  const reconciliations = [];
  const storageWrites = [];
  const storageRemovals = [];
  const subscriptions = {};
  const appStateListeners = [];
  const timers = [];
  let registrationCalls = 0;
  let channelsCalls = 0;

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };

  Module._load = function mocked(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return {
        __esModule: true,
        default: {
          getItem: async (key) => storageValues[key] || null,
          setItem: async (key, value) => { storageValues[key] = value; storageWrites.push({ key, value }); },
          removeItem: async (key) => { delete storageValues[key]; storageRemovals.push(key); },
        },
      };
    }
    if (request === 'expo-notifications') {
      return {
        addPushTokenListener: (handler) => {
          subscriptions.token = { handler, removed: false };
          return { remove: () => { subscriptions.token.removed = true; } };
        },
      };
    }
    if (request === 'expo-constants') return { __esModule: true, default: { expoConfig: { version: '1.2.3' } } };
    if (request === 'react-native') {
      return {
        Platform: { OS: 'ios' },
        AppState: {
          addEventListener: (_event, handler) => {
            const subscription = { handler, removed: false };
            appStateListeners.push(subscription);
            return { remove: () => { subscription.removed = true; } };
          },
        },
      };
    }
    if (request.endsWith('/loggerService')) {
      return { __esModule: true, default: { warn: () => {} } };
    }
    if (request.endsWith('/notificationRegistrationService')) {
      return {
        initializeNotificationChannels: async () => { channelsCalls += 1; },
        primeNotificationPermissions: async () => (permissionPromise ? permissionPromise.promise : { success: true, data: permission }),
        registerForPushNotificationsAsync: async () => {
          registrationCalls += 1;
          return token;
        },
      };
    }
    if (request.endsWith('/notificationDeviceApiService')) {
      return {
        reconcileNotificationDevice: async (input) => {
          reconciliations.push(input);
          return reconcilePromise ? reconcilePromise.promise : { success: true };
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  clearCoordinator();
  const { createNotificationRegistrationCoordinator } = require('../services/notifications/notificationRegistrationCoordinator');
  const coordinator = createNotificationRegistrationCoordinator({ now });
  return {
    coordinator,
    reconciliations,
    storageWrites,
    storageRemovals,
    subscriptions,
    appStateListeners,
    timers,
    getRegistrationCalls: () => registrationCalls,
    getChannelsCalls: () => channelsCalls,
  };
};

const activeState = (overrides = {}) => ({
  authUid: 'auth-1', sessionId: 'sess-1', isConnected: true, operationalEligible: true, tourId: 'TOUR_1', ...overrides,
});

test.afterEach(() => {
  Module._load = originalLoad;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  clearCoordinator();
});

test('coalesces overlapping reconciliation requests into one Expo registration and server call', async () => {
  const gate = deferred();
  const harness = buildCoordinator({ reconcilePromise: gate });
  const first = harness.coordinator.start(activeState());
  await flush();
  const second = harness.coordinator.reconcile('manual');
  assert.equal(harness.getRegistrationCalls(), 1);
  assert.equal(harness.reconciliations.length, 1);
  gate.resolve({ success: true });
  await first;
  await second;
  assert.equal(harness.getChannelsCalls(), 1);
});

test('foreground activation and reconnect reconcile the current authenticated device', async () => {
  const harness = buildCoordinator();
  await harness.coordinator.start(activeState({ isConnected: false }));
  assert.equal(harness.reconciliations.length, 0);
  await harness.coordinator.update(activeState());
  harness.appStateListeners[0].handler('active');
  await flush();
  assert.equal(harness.reconciliations.length, 2);
  assert.equal(harness.reconciliations.every((entry) => entry.pushToken === 'ExponentPushToken[canonical-expo-token]'), true);
});

test('native token rotation causes an Expo-token reconcile and never persists the native listener token', async () => {
  const harness = buildCoordinator();
  await harness.coordinator.start(activeState());
  harness.subscriptions.token.handler({ data: 'native-apns-token-must-not-be-persisted' });
  await flush();
  assert.equal(harness.reconciliations.length, 2);
  assert.equal(harness.reconciliations[1].pushToken, 'ExponentPushToken[canonical-expo-token]');
  assert.equal(JSON.stringify(harness.reconciliations).includes('native-apns-token-must-not-be-persisted'), false);
});

test('persists a bounded durable retry after temporary Expo-token failure and replays it', async () => {
  const harness = buildCoordinator({ token: null });
  const result = await harness.coordinator.start(activeState());
  assert.equal(result.success, false);
  assert.equal(harness.storageWrites.length, 1);
  assert.match(harness.storageWrites[0].key, /notification-registration-retry/);
  assert.equal(harness.timers[0].delay, 60_000);
  harness.timers[0].callback();
  await flush();
  assert.equal(harness.getRegistrationCalls(), 2);
});

test('ignores stale permission work and immediately reconciles the replacement session', async () => {
  const permissionGate = deferred();
  const harness = buildCoordinator({ permissionPromise: permissionGate });
  const first = harness.coordinator.start(activeState({ authUid: 'old-user', sessionId: 'old-session' }));
  await flush();
  const second = harness.coordinator.update(activeState({
    authUid: 'new-user', sessionId: 'new-session', tourId: 'NEW_TOUR',
  }));
  permissionGate.resolve({ success: true, data: { state: 'granted', granted: true, canAskAgain: true } });
  const firstResult = await first;
  await second;
  assert.equal(firstResult.success, true);
  assert.equal(harness.reconciliations.length, 1);
  assert.equal(harness.reconciliations[0].tourId, 'NEW_TOUR');
});

test('stop removes native and foreground listeners and prevents restored retry from using a cleared session', async () => {
  const harness = buildCoordinator({
    storageValues: { '@LLT:notification-registration-retry:v1': JSON.stringify({ attempt: 2, availableAtMs: 2_000 }) },
  });
  await harness.coordinator.start(activeState());
  await flush();
  const restoredTimer = harness.timers.find((timer) => timer.delay === 1_000);
  assert.ok(restoredTimer);
  harness.coordinator.stop();
  assert.equal(harness.subscriptions.token.removed, true);
  assert.equal(harness.appStateListeners[0].removed, true);
  assert.equal(restoredTimer.cleared, true);
  restoredTimer.callback();
  await flush();
  assert.equal(harness.reconciliations.length, 1);
});
