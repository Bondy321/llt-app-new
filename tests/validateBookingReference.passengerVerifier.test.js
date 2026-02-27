const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const createMockRealtimeDb = (state) => {
  const buildRef = (dbPath = '') => {
    const segments = dbPath.split('/').filter(Boolean);
    const getValue = () => segments.reduce((node, key) => (node || {})[key], state);
    const setValue = (pathSegments, value) => {
      if (pathSegments.length === 0) {
        return;
      }

      let cursor = state;
      for (let index = 0; index < pathSegments.length - 1; index += 1) {
        const key = pathSegments[index];
        if (!cursor[key] || typeof cursor[key] !== 'object') {
          cursor[key] = {};
        }
        cursor = cursor[key];
      }

      cursor[pathSegments[pathSegments.length - 1]] = value;
    };

    return {
      async once() {
        const value = getValue();
        return {
          exists: () => value !== undefined && value !== null,
          val: () => value,
        };
      },
      async update(updates) {
        Object.entries(updates || {}).forEach(([pathKey, value]) => {
          const pathSegments = [...segments, ...pathKey.split('/').filter(Boolean)];
          setValue(pathSegments, value);
        });
      },
      child(childPath) {
        const nextPath = [...segments, ...String(childPath).split('/').filter(Boolean)].join('/');
        return buildRef(nextPath);
      }
    };
  };

  return {
    ref: buildRef,
  };
};

const loadServiceWithDb = (state, options = {}) => {
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
      getCurrentAppCheckToken: options.getCurrentAppCheckToken,
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

test('validateBookingReference normalizes verifier tourId before tour lookup', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: 'ABC123',
        tourId: ' 5112d 8 ',
        tourCode: 'SHOULD_NOT_BE_USED',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        ABC123: {
          bookingRef: 'ABC123',
          tourCode: '5112D 8',
          passengerNames: ['Alex'],
          pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference('abc123', 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5112D_8');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference derives tourId from verifier tourCode when tourId is invalid', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: 'ABC123',
        tourId: '$$$',
        tourCode: ' 5112d 8 ',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        ABC123: {
          bookingRef: 'ABC123',
          tourCode: '5112D 8',
          passengerNames: ['Alex'],
          pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5112D_8');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});


test('validateBookingReference sends x-firebase-appcheck header when token is available', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK = 'true';

  const originalFetch = global.fetch;
  try {
    let capturedHeaders;
    global.fetch = async (_url, options) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({
          valid: true,
          bookingRef: 'ABC123',
          tourId: '5112D_8',
        }),
      };
    };

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        ABC123: {
          bookingRef: 'ABC123',
          tourCode: '5112D 8',
          passengerNames: ['Alex'],
          pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    }, {
      getCurrentAppCheckToken: async () => 'mock-app-check-token',
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(capturedHeaders['x-firebase-appcheck'], 'mock-app-check-token');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK;
  }
});


test('validateBookingReference does not send x-firebase-appcheck header when App Check is disabled', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    let capturedHeaders;
    global.fetch = async (_url, options) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({
          valid: true,
          bookingRef: 'ABC123',
          tourId: '5112D_8',
        }),
      };
    };

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        ABC123: {
          bookingRef: 'ABC123',
          tourCode: '5112D 8',
          passengerNames: ['Alex'],
          pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    }, {
      getCurrentAppCheckToken: async () => 'mock-app-check-token',
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, 'x-firebase-appcheck'), false);
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK;
  }
});


test('validateBookingReference maps INVALID_CREDENTIALS to non-enumerating safe copy', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      json: async () => ({
        valid: false,
        reason: 'INVALID_CREDENTIALS',
      }),
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Login details could not be verified. Please check your details and try again.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference maps TRY_AGAIN_LATER to rate-limit retry guidance', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      json: async () => ({
        valid: false,
        reason: 'TRY_AGAIN_LATER',
      }),
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Too many verification attempts. Please wait a moment and try again.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference maps INTERNAL_ERROR to transient backend failure copy', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      json: async () => ({
        valid: false,
        reason: 'INTERNAL_ERROR',
      }),
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Verification service is temporarily unavailable. Please try again shortly.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference maps METHOD_NOT_ALLOWED defensively', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      json: async () => ({
        valid: false,
        reason: 'METHOD_NOT_ALLOWED',
      }),
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Verification service is currently unavailable. Please update the app and try again shortly.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});



test('validateBookingReference retries with derived verifier URL when explicit URL returns 404', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://invalid.test/verify';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-project';

  const originalFetch = global.fetch;
  try {
    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(url);

      if (url === 'https://invalid.test/verify') {
        return {
          ok: false,
          status: 404,
          json: async () => ({ valid: false, reason: 'NOT_FOUND' }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          bookingRef: 'ABC123',
          tourId: '5112D_8',
        }),
      };
    };

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        ABC123: {
          bookingRef: 'ABC123',
          tourCode: '5112D 8',
          passengerNames: ['Alex'],
          pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.deepEqual(fetchCalls, [
      'https://invalid.test/verify',
      'https://europe-west1-demo-project.cloudfunctions.net/verifyPassengerLogin',
    ]);
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
    delete process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  }
});


test('validateBookingReference maps verifier endpoint-not-found to actionable copy', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://invalid.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ valid: false, reason: 'NOT_FOUND' }),
    });

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} });
    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Passenger verification service endpoint is unavailable. Please update app settings or try again later.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference maps missing App Check token to actionable copy when strict mode is enabled', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK = 'true';
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK = 'true';

  const originalFetch = global.fetch;
  try {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when strict app check fails');
    };

    const service = loadServiceWithDb({ drivers: {}, bookings: {}, tours: {} }, {
      getCurrentAppCheckToken: async () => null,
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'App security check could not be completed. Update the app or reconnect and try again.');
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK;
  }
});
