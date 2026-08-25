const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const clearBookingServiceCache = require('./helpers/clearBookingServiceCache');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');
const CURRENT_SESSION = {
  schemaVersion: 1,
  sessionId: 'sess_v1_0123456789abcdef0123456789abcdef',
  principalType: 'driver',
  principalId: 'driver:D-BONDY',
  driverId: 'D-BONDY',
  tourId: '5112D_8',
  issuedAtMs: Date.now() - 1_000,
  expiresAtMs: Date.now() + 60_000,
  sessionRevision: 1,
};
const UPDATED_SESSION = { ...CURRENT_SESSION, tourId: '6000A_1', sessionRevision: 2 };
const createSessionApi = () => ({
  readSession: async () => CURRENT_SESSION,
  persistSession: async (session) => session,
});

const loadService = ({ currentUser = { uid: 'driver-auth-1', getIdToken: async () => 'driver-id-token' } } = {}) => {
  const previousNodeEnv = process.env.NODE_ENV;
  clearBookingServiceCache(SERVICE_PATH);
  delete require.cache[FIREBASE_PATH];
  process.env.NODE_ENV = 'development';
  require.cache[FIREBASE_PATH] = {
    id: FIREBASE_PATH,
    filename: FIREBASE_PATH,
    loaded: true,
    exports: {
      realtimeDb: null,
      auth: { currentUser },
    },
  };

  const service = require(SERVICE_PATH);
  process.env.NODE_ENV = previousNodeEnv;
  return service;
};

const withAssignmentEnvironment = async (callback) => {
  const previousProjectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  const previousEndpoint = process.env.EXPO_PUBLIC_ASSIGN_DRIVER_TO_TOUR_URL;
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-project';
  delete process.env.EXPO_PUBLIC_ASSIGN_DRIVER_TO_TOUR_URL;
  try {
    return await callback();
  } finally {
    if (previousProjectId === undefined) delete process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
    else process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = previousProjectId;
    if (previousEndpoint === undefined) delete process.env.EXPO_PUBLIC_ASSIGN_DRIVER_TO_TOUR_URL;
    else process.env.EXPO_PUBLIC_ASSIGN_DRIVER_TO_TOUR_URL = previousEndpoint;
  }
};

test('assignDriverToTour uses the authenticated server endpoint and returns canonical assignment data', async () => {
  await withAssignmentEnvironment(async () => {
    const originalFetch = global.fetch;
    let capturedRequest;
    try {
      global.fetch = async (url, options) => {
        capturedRequest = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            tourId: '6000A_1',
            tourCode: '6000A 1',
            previousTourId: '5112D_8',
            session: UPDATED_SESSION,
          }),
        };
      };

      const service = loadService();
      const result = await service.assignDriverToTour('d-bondy', '6000a 1', {
        appSessionService: createSessionApi(),
      });

      assert.equal(capturedRequest.url, 'https://europe-west1-demo-project.cloudfunctions.net/assignDriverToTour');
      assert.equal(capturedRequest.options.headers.Authorization, 'Bearer driver-id-token');
      assert.deepEqual(JSON.parse(capturedRequest.options.body), {
        driverId: 'D-BONDY',
        tourCode: '6000a 1',
        expectedSessionId: CURRENT_SESSION.sessionId,
      });
      assert.deepEqual(result, {
        success: true,
        tourId: '6000A_1',
        tourCode: '6000A 1',
        previousTourId: '5112D_8',
        session: UPDATED_SESSION,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('assignDriverToTour maps an occupied tour to dispatch-safe user copy', async () => {
  await withAssignmentEnvironment(async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: false,
        status: 409,
        json: async () => ({ success: false, reason: 'TOUR_ALREADY_ASSIGNED' }),
      });
      const service = loadService();

      await assert.rejects(
        service.assignDriverToTour('D-BONDY', '6000A 1', { appSessionService: createSessionApi() }),
        /already has another driver assigned/i,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('assignDriverToTour refuses to call the backend without an authenticated token', async () => {
  await withAssignmentEnvironment(async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    try {
      global.fetch = async () => {
        fetchCalled = true;
        throw new Error('fetch must not be called');
      };
      const service = loadService({ currentUser: { uid: 'driver-auth-1' } });

      await assert.rejects(
        service.assignDriverToTour('D-BONDY', '6000A 1', { appSessionService: createSessionApi() }),
        /secure driver access is still starting/i,
      );
      assert.equal(fetchCalled, false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('assignDriverToTour rejects malformed backend responses without changing local state', async () => {
  await withAssignmentEnvironment(async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => null,
      });
      const service = loadService();

      await assert.rejects(
        service.assignDriverToTour('D-BONDY', '6000A 1', { appSessionService: createSessionApi() }),
        /unexpected response/i,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
