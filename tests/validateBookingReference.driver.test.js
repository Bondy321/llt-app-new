const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const withEnv = async (patch, callback) => {
  const previous = {};
  Object.keys(patch).forEach((key) => {
    previous[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    return await callback();
  } finally {
    Object.keys(patch).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
};

const withoutDriverVerifierConfig = (callback) => withEnv({
  EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL: undefined,
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: undefined,
}, callback);

const createMockRealtimeDb = (state) => ({
  ref(dbPath) {
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
    };
  },
});

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
      auth: options.auth || { currentUser: { uid: 'test-user', getIdToken: async () => 'mock-firebase-id-token' } },
    },
  };

  const service = require(SERVICE_PATH);

  process.env.NODE_ENV = previousNodeEnv;
  return service;
};

test('validateBookingReference returns driver tour payload when current tour exists', async () => {
  await withoutDriverVerifierConfig(async () => {
    const service = loadServiceWithDb({
      drivers: {
        'D-BONDY': { name: 'Bondy', currentTourId: '5112D 8' },
      },
      tours: {
        '5112D_8': { name: 'Highlands', tourCode: '5112D 8', isActive: true },
      },
    });

    const result = await service.validateBookingReference('d-bondy');

    assert.equal(result.valid, true);
    assert.equal(result.type, 'driver');
    assert.equal(result.driver.id, 'D-BONDY');
    assert.equal(result.driver.assignedTourId, '5112D_8');
    assert.equal(result.driver.hasAssignedTour, true);
    assert.equal(result.assignmentStatus, 'ASSIGNED');
    assert.equal(result.tour.id, '5112D_8');
    assert.equal(result.tour.name, 'Highlands');
  });
});

test('validateBookingReference returns null tour and UNASSIGNED for drivers without assignment', async () => {
  await withoutDriverVerifierConfig(async () => {
    const service = loadServiceWithDb({
      drivers: {
        'D-SMITH': { name: 'Smith', currentTourId: null },
      },
      tours: {},
    });

    const result = await service.validateBookingReference('D-SMITH');

    assert.equal(result.valid, true);
    assert.equal(result.type, 'driver');
    assert.equal(result.driver.assignedTourId, null);
    assert.equal(result.driver.hasAssignedTour, false);
    assert.equal(result.tour, null);
    assert.equal(result.assignmentStatus, 'UNASSIGNED');
  });
});

test('validateBookingReference keeps driver auto-detect based on D- prefix', async () => {
  await withoutDriverVerifierConfig(async () => {
    const service = loadServiceWithDb({
      drivers: {
        'D-MACLEOD': { name: 'Macleod', currentTourId: null },
      },
      tours: {},
    });

    const result = await service.validateBookingReference('d-macleod');

    assert.equal(result.valid, true);
    assert.equal(result.type, 'driver');
    assert.equal(result.driver.id, 'D-MACLEOD');
  });
});

test('validateBookingReference uses verified driver endpoint when configured', async () => {
  process.env.EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL = 'https://example.test/verifyDriverLogin';

  const originalFetch = global.fetch;
  try {
    let capturedRequest;
    global.fetch = async (url, options) => {
      capturedRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          type: 'driver',
          driver: {
            id: 'D-BONDY',
            name: 'Bondy',
            assignedTourId: '5112D_8',
            assignedTourCode: '5112D 8',
            hasAssignedTour: true,
          },
          tour: { id: '5112D_8', name: 'Highlands', tourCode: '5112D 8', isActive: true },
          assignmentStatus: 'ASSIGNED',
        }),
      };
    };

    const service = loadServiceWithDb({
      drivers: {
        'D-BONDY': { name: 'Old direct record should not be used', currentTourId: null },
      },
      tours: {},
      tour_manifests: {},
    });

    const result = await service.validateBookingReference('d-bondy');

    assert.equal(capturedRequest.url, 'https://example.test/verifyDriverLogin');
    assert.equal(capturedRequest.options.headers.Authorization, 'Bearer mock-firebase-id-token');
    assert.deepEqual(JSON.parse(capturedRequest.options.body), { driverId: 'D-BONDY' });
    assert.equal(result.valid, true);
    assert.equal(result.tour.name, 'Highlands');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL;
  }
});

test('validateBookingReference maps claimed driver verifier failures to support copy', async () => {
  process.env.EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL = 'https://example.test/verifyDriverLogin';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ valid: false, reason: 'DRIVER_ALREADY_LINKED' }),
    });

    const service = loadServiceWithDb({ drivers: {}, tours: {}, tour_manifests: {} });
    const result = await service.validateBookingReference('D-BONDY');

    assert.equal(result.valid, false);
    assert.equal(result.error, 'This driver code is already linked to another device. Please contact dispatch if this is unexpected.');
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL;
  }
});
