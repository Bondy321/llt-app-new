const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const BOOKING_FIXTURES = {
  TOUR_ID_ONLY: {
    bookingRef: 'BOOK_TOUR_ID_ONLY',
    tourId: ' 5112d 8 ',
    passengerNames: ['Alex'],
    pickupPoints: [{ location: 'Balloch', time: '08:00' }],
  },
  TOUR_CODE_ONLY: {
    bookingRef: 'BOOK_TOUR_CODE_ONLY',
    tourCode: '5112D 8',
    passengerNames: ['Alex'],
    pickupPoints: [{ location: 'Balloch', time: '08:00' }],
  },
  BOTH_INCONSISTENT: {
    bookingRef: 'BOOK_BOTH_INCONSISTENT',
    tourId: '5134A_1',
    tourCode: '5112D 8',
    passengerNames: ['Alex'],
    pickupPoints: [{ location: 'Balloch', time: '08:00' }],
  },
  NO_TOUR_FIELDS: {
    bookingRef: 'BOOK_NO_TOUR_FIELDS',
    passengerNames: ['Alex'],
    pickupPoints: [{ location: 'Balloch', time: '08:00' }],
  },
};

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

test('validateBookingReference allows login when verifier succeeds without tourId/tourCode (booking tourId only)', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef,
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        [BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef]: BOOKING_FIXTURES.TOUR_ID_ONLY,
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference(BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef, 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5112D_8');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference resolves tour from bookings.tourId when both booking fields are present but inconsistent', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: BOOKING_FIXTURES.BOTH_INCONSISTENT.bookingRef,
        tourId: 'MALICIOUS_VERIFIER_TOUR',
        tourCode: 'SHOULD_NOT_BE_USED',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        [BOOKING_FIXTURES.BOTH_INCONSISTENT.bookingRef]: BOOKING_FIXTURES.BOTH_INCONSISTENT,
      },
      tours: {
        'MALICIOUS_VERIFIER_TOUR': { name: 'Incorrect tour', tourCode: 'VERIFIER', isActive: true, participants: {}, currentParticipants: 99 },
        '5112D_8': { name: 'Code fallback tour', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 7 },
        '5134A_1': { name: 'Canonical booking tour', tourCode: '5134A 1', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference(BOOKING_FIXTURES.BOTH_INCONSISTENT.bookingRef, 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5134A_1');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference resolves tour from sanitized bookings.tourCode when bookings.tourId is missing/invalid', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: BOOKING_FIXTURES.TOUR_CODE_ONLY.bookingRef,
        tourId: 'MALICIOUS_VERIFIER_TOUR',
        tourCode: 'MALICIOUS VERIFIER CODE',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        [BOOKING_FIXTURES.TOUR_CODE_ONLY.bookingRef]: {
          ...BOOKING_FIXTURES.TOUR_CODE_ONLY,
          tourId: '###',
        },
      },
      tours: {
        'MALICIOUS_VERIFIER_TOUR': { name: 'Incorrect verifier tour', tourCode: 'VERIFIER', isActive: true, participants: {}, currentParticipants: 999 },
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference(BOOKING_FIXTURES.TOUR_CODE_ONLY.bookingRef, 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5112D_8');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});




test('validateBookingReference rejects booking when canonical booking tour info is unavailable', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: BOOKING_FIXTURES.NO_TOUR_FIELDS.bookingRef,
        tourId: 'MALICIOUS_VERIFIER_TOUR',
        tourCode: 'MALICIOUS VERIFIER CODE',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        [BOOKING_FIXTURES.NO_TOUR_FIELDS.bookingRef]: BOOKING_FIXTURES.NO_TOUR_FIELDS,
      },
      tours: {
        MALICIOUS_VERIFIER_TOUR: { name: 'Incorrect verifier tour', tourCode: 'VERIFIER', isActive: true, participants: {}, currentParticipants: 9 },
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference(BOOKING_FIXTURES.NO_TOUR_FIELDS.bookingRef, 'traveller@example.com');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'Tour information not available for this booking.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});

test('validateBookingReference is tamper-resistant: conflicting verifier tourId never overrides booking canonical tour', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        valid: true,
        bookingRef: BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef,
        tourId: 'MALICIOUS_VERIFIER_TOUR',
        tourCode: 'MALICIOUS VERIFIER CODE',
      }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: {
        [BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef]: BOOKING_FIXTURES.TOUR_ID_ONLY,
      },
      tours: {
        MALICIOUS_VERIFIER_TOUR: { name: 'Incorrect verifier tour', tourCode: 'VERIFIER', isActive: true, participants: {}, currentParticipants: 9 },
        '5112D_8': { name: 'Canonical booking tour', tourCode: '5112D 8', isActive: true, participants: {}, currentParticipants: 0 },
      },
    });

    const result = await service.validateBookingReference(BOOKING_FIXTURES.TOUR_ID_ONLY.bookingRef, 'traveller@example.com');

    assert.equal(result.valid, true);
    assert.equal(result.tour.id, '5112D_8');
    assert.equal(result.tour.name, 'Canonical booking tour');
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


test('validateBookingReference keeps passenger flow for non D- codes', async () => {
  process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL = 'https://example.test/verify';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ valid: true, bookingRef: 'ABC123', tourId: '5112D_8' }),
    });

    const service = loadServiceWithDb({
      drivers: {},
      bookings: { ABC123: { bookingRef: 'ABC123', tourCode: '5112D 8' } },
      tours: { '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true } },
    });

    const result = await service.validateBookingReference('ABC123', 'traveller@example.com');
    assert.equal(result.valid, true);
    assert.equal(result.type, 'passenger');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL;
  }
});
