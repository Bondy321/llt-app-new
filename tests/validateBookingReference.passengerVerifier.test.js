const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const createMockRealtimeDb = (state) => ({
  ref(dbPath = '') {
    const segments = dbPath.split('/').filter(Boolean);
    const getValue = () => segments.reduce((node, key) => (node || {})[key], state);

    return {
      async once() {
        const value = getValue();
        return {
          exists: () => value !== undefined && value !== null,
          val: () => value,
        };
      },
      async update(updates) {
        Object.assign(state, updates);
      },
    };
  },
});

const loadServiceWithDb = (state) => {
  const previousNodeEnv = process.env.NODE_ENV;

  delete require.cache[SERVICE_PATH];
  delete require.cache[FIREBASE_PATH];

  process.env.NODE_ENV = 'development';
  require.cache[FIREBASE_PATH] = {
    id: FIREBASE_PATH,
    filename: FIREBASE_PATH,
    loaded: true,
    exports: {
      realtimeDb: createMockRealtimeDb(state),
      auth: { currentUser: { uid: 'test-user' } },
    },
  };

  const service = require(SERVICE_PATH);
  process.env.NODE_ENV = previousNodeEnv;
  return service;
};

test('validateBookingReference maps verifier timeouts to actionable copy', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS = '20';

  const originalFetch = global.fetch;
  try {
    global.fetch = (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Verification is taking longer than expected. Please check your connection and try again.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS;
  }
});

test('validateBookingReference handles non-JSON verifier responses deterministically', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Verification service returned an unexpected response. Please try again.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});
