const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const loadService = (options = {}) => {
  const previousNodeEnv = process.env.NODE_ENV;

  delete require.cache[SERVICE_PATH];
  delete require.cache[FIREBASE_PATH];

  process.env.NODE_ENV = 'development';
  require.cache[FIREBASE_PATH] = {
    id: FIREBASE_PATH,
    filename: FIREBASE_PATH,
    loaded: true,
    exports: {
      realtimeDb: {
        ref() {
          throw new Error('direct database manifest scan should not be used');
        },
      },
      auth: options.auth || {
        currentUser: {
          uid: 'driver-auth-1',
          getIdToken: async () => 'mock-firebase-id-token',
        },
      },
    },
  };

  const service = require(SERVICE_PATH);
  process.env.NODE_ENV = previousNodeEnv;
  return service;
};

test('getTourManifest loads passenger manifest through verified HTTPS endpoint', async () => {
  process.env.EXPO_PUBLIC_GET_TOUR_MANIFEST_URL = 'https://example.test/getTourManifest';

  const originalFetch = global.fetch;
  try {
    let capturedRequest;
    global.fetch = async (url, options) => {
      capturedRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tourId: '5112D_8',
          tourCode: '5112D 8',
          bookings: [
            { id: 'ABC123', passengerNames: ['Alex'], status: 'PENDING' },
          ],
          stats: { totalBookings: 1, totalPax: 1, checkedIn: 0, noShows: 0 },
        }),
      };
    };

    const service = loadService();
    const manifest = await service.getTourManifest('5112D_8');

    assert.equal(capturedRequest.url, 'https://example.test/getTourManifest');
    assert.equal(capturedRequest.options.headers.Authorization, 'Bearer mock-firebase-id-token');
    assert.deepEqual(JSON.parse(capturedRequest.options.body), { tourId: '5112D_8' });
    assert.equal(manifest.tourId, '5112D_8');
    assert.equal(manifest.bookings.length, 1);
    assert.equal(manifest.stats.totalPax, 1);
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_GET_TOUR_MANIFEST_URL;
  }
});

test('getTourManifest surfaces authorization failures with customer-safe copy', async () => {
  process.env.EXPO_PUBLIC_GET_TOUR_MANIFEST_URL = 'https://example.test/getTourManifest';

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false, reason: 'NOT_AUTHORIZED' }),
    });

    const service = loadService();

    await assert.rejects(
      service.getTourManifest('5112D_8'),
      /You do not have access to this passenger manifest/,
    );
  } finally {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_GET_TOUR_MANIFEST_URL;
  }
});
