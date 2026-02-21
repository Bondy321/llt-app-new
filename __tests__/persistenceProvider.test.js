const test = require('node:test');
const assert = require('node:assert');
const { createPersistenceProvider } = require('../services/persistenceProvider');

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
    ALWAYS_THIS_DEVICE_ONLY: 'always',
    data: {},
    async setItemAsync(key, value) { this.data[key] = value; },
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

test('falls back to memory-mock when selected adapter errors', async () => {
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
    runtime: { isReactNative: false, nodeEnv: 'production' },
  });

  assert.equal(provider.mode, 'async-storage');
  await provider.setItemAsync('a', '1');
  await provider.setItemAsync('a', '2');
  assert.equal(await provider.getItemAsync('a'), '2');

  const warnEvent = logger.events.find((event) => event.level === 'warn' && event.msg.includes('async-storage failed'));
  assert.ok(warnEvent);
  const fallbackEvent = logger.events.find((event) => event.level === 'info' && event.msg.includes('Falling back to in-memory'));
  assert.ok(fallbackEvent);
  assert.equal(logger.events.some((event) => event.level === 'error'), false);
});
