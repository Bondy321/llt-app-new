const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

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

test('validateBookingReference returns driver tour payload when current tour exists', async () => {
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

test('validateBookingReference returns null tour and UNASSIGNED for drivers without assignment', async () => {
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
