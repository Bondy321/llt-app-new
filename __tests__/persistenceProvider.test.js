const test = require('node:test');
const assert = require('node:assert');
const {
  createPersistenceProvider,
  isBrowserRuntime,
  isReactNativeRuntime,
} = require('../services/persistenceProvider');

test('browser runtime detection recognizes web globals and explicit overrides', () => {
  assert.equal(isBrowserRuntime({ isWeb: true }), true);
  assert.equal(isBrowserRuntime({ isWeb: false, globalObject: { window: {}, document: {} } }), false);
  assert.equal(isBrowserRuntime({ globalObject: { window: {}, document: {} } }), true);
  assert.equal(isBrowserRuntime({ globalObject: {} }), false);
});

test('native runtime detection never reads React Native bridge accessors on web', () => {
  const globalObject = { window: {}, document: {} };
  Object.defineProperty(globalObject, '__fbBatchedBridgeConfig', {
    get() {
      throw new Error('React Native bridge accessed from web');
    },
  });

  assert.equal(isReactNativeRuntime({ globalObject }), false);
  assert.equal(isReactNativeRuntime({ isReactNative: true, globalObject }), true);
});

const createMockLogger = () => {
  const events = [];
  return {
    events,
    debug: (msg, data) => events.push({ level: 'debug', msg, data }),
    info: (msg, data) => events.push({ level: 'info', msg, data }),
    warn: (msg, data) => events.push({ level: 'warn', msg, data }),
    error: (msg, data) => events.push({ level: 'error', msg, data }),
  };
};

test('selects secure-store in native-like runtime when available', async () => {
  const logger = createMockLogger();
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device',
    data: {},
    optionsByKey: {},
    async setItemAsync(key, value, options) {
      this.data[key] = value;
      this.optionsByKey[key] = options;
    },
    async getItemAsync(key) { return this.data[key] || null; },
    async deleteItemAsync(key) { delete this.data[key]; },
  };

  const provider = createPersistenceProvider({
    namespace: 'TEST',
    logger,
    secureStoreAdapter: secureStore,
    runtime: { isReactNative: true, nodeEnv: 'production' },
  });

  assert.equal(provider.mode, 'secure-store');
  await provider.setItemAsync('token', 'abc');
  assert.equal(await provider.getItemAsync('token'), 'abc');
  assert.equal(secureStore.data.TEST_token, 'abc');
  assert.deepEqual(secureStore.optionsByKey.TEST_token, {
    keychainAccessible: 'when-unlocked-this-device',
  });
});

test('uses memory-mock by default in NODE_ENV=test when no adapter is injected', async () => {
  const logger = createMockLogger();

  const provider = createPersistenceProvider({
    namespace: 'TEST',
    logger,
    runtime: { nodeEnv: 'test', isReactNative: false },
  });

  assert.equal(provider.mode, 'memory-mock');
  await provider.setItemAsync('k', 'v');
  assert.equal(await provider.getItemAsync('k'), 'v');
  assert.ok(logger.events.some((event) => event.level === 'debug' && event.msg.includes('forced to memory')));
});

test('durable providers surface an error instead of silently becoming memory-only', async () => {
  const logger = createMockLogger();
  const asyncStorage = {
    setItem: async () => { throw new Error('write failed'); },
    getItem: async () => null,
    removeItem: async () => {},
  };

  const provider = createPersistenceProvider({
    namespace: 'TEST',
    logger,
    asyncStorageAdapter: asyncStorage,
    preferredStorage: 'async-storage',
    allowMemoryFallback: false,
    runtime: { isReactNative: false, nodeEnv: 'production' },
  });

  assert.equal(provider.mode, 'async-storage');
  await assert.rejects(
    provider.setItemAsync('a', '1'),
    (error) => error?.code === 'PERSISTENCE_UNAVAILABLE'
  );
  assert.equal(provider.mode, 'async-storage');
  assert.equal(provider.health.degraded, true);
  assert.equal(provider.health.durable, true);

  const warnEvent = logger.events.find((event) => event.level === 'warn' && event.msg.includes('async-storage failed'));
  assert.ok(warnEvent);
  assert.equal(logger.events.some((event) => event.msg.includes('memory')), false);
});

test('large durable data prefers AsyncStorage and migrates legacy SecureStore values', async () => {
  const logger = createMockLogger();
  const secureStore = {
    data: { TEST_queue_v1: '[{"id":"legacy-action"}]' },
    async setItemAsync(key, value) { this.data[key] = value; },
    async getItemAsync(key) { return this.data[key] || null; },
    async deleteItemAsync(key) { delete this.data[key]; },
  };
  const asyncStorage = {
    data: {},
    async setItem(key, value) { this.data[key] = value; },
    async getItem(key) { return this.data[key] || null; },
    async removeItem(key) { delete this.data[key]; },
  };

  const provider = createPersistenceProvider({
    namespace: 'TEST',
    logger,
    secureStoreAdapter: secureStore,
    asyncStorageAdapter: asyncStorage,
    preferredStorage: 'async-storage',
    allowMemoryFallback: false,
    migrateFrom: ['secure-store'],
    runtime: { isReactNative: true, nodeEnv: 'production' },
  });

  assert.equal(provider.mode, 'async-storage');
  assert.equal(await provider.getItemAsync('queue_v1'), '[{"id":"legacy-action"}]');
  assert.equal(asyncStorage.data.TEST_queue_v1, '[{"id":"legacy-action"}]');
  assert.equal(secureStore.data.TEST_queue_v1, undefined);
  assert.ok(logger.events.some((event) => event.msg.includes('Migrated persisted value')));
});
