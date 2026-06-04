const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const FIREBASE_PATH = path.resolve(__dirname, '../firebase.js');

const createMockRealtimeDb = (state) => {
  const rootState = state;
  const updatesHistory = [];

  const getValue = (segments) => segments.reduce((node, key) => (node || {})[key], rootState);

  const setPathValue = (path, value) => {
    const segments = path.split('/').filter(Boolean);
    let node = rootState;

    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      node[segment] = node[segment] || {};
      node = node[segment];
    }

    node[segments[segments.length - 1]] = value;
  };

  return {
    updatesHistory,
    ref(dbPath = '') {
      const segments = dbPath.split('/').filter(Boolean);

      return {
        async once() {
          const value = getValue(segments);
          return {
            exists: () => value !== undefined && value !== null,
            val: () => value,
          };
        },
        async update(updates) {
          updatesHistory.push(updates);
          Object.entries(updates).forEach(([updatePath, value]) => {
            setPathValue(updatePath, value);
          });
        },
      };
    },
  };
};

const loadServiceWithState = (state) => {
  const previousNodeEnv = process.env.NODE_ENV;

  delete require.cache[SERVICE_PATH];
  delete require.cache[FIREBASE_PATH];

  const mockDb = createMockRealtimeDb(state);
  process.env.NODE_ENV = 'development';
  require.cache[FIREBASE_PATH] = {
    id: FIREBASE_PATH,
    filename: FIREBASE_PATH,
    loaded: true,
    exports: {
      realtimeDb: mockDb,
      auth: { currentUser: { uid: 'dispatcher-uid-1' } },
    },
  };

  const service = require(SERVICE_PATH);

  process.env.NODE_ENV = previousNodeEnv;
  return { service, mockDb };
};

test('assignDriverToTour clears previous manifest assignment when switching tours', async () => {
  const { service, mockDb } = loadServiceWithState({
    drivers: {
      'D-BONDY': {
        name: 'Bondy',
        currentTourId: '5112D 8',
      },
    },
    tours: {
      '5112D_8': { name: 'Highlands AM' },
      '6000A_1': { name: 'Edinburgh PM' },
    },
    tour_manifests: {
      '5112D_8': {
        assigned_drivers: {
          'D-BONDY': true,
        },
        assigned_driver_codes: {
          'D-BONDY': {
            tourId: '5112D_8',
            tourCode: '5112D 8',
          },
        },
      },
    },
  });

  const result = await service.assignDriverToTour('D-BONDY', '6000A 1');

  assert.equal(result.success, true);
  assert.equal(result.tourId, '6000A_1');

  const latestUpdates = mockDb.updatesHistory.at(-1);
  assert.equal(latestUpdates['drivers/D-BONDY/currentTourId'], '6000A_1');
  assert.equal(latestUpdates['drivers/D-BONDY/currentTourCode'], '6000A 1');
  assert.equal(latestUpdates['users/dispatcher-uid-1/driverId'], 'D-BONDY');
  assert.equal(latestUpdates['users/dispatcher-uid-1/driverPrincipalId'], 'driver:D-BONDY');
  assert.equal(latestUpdates['users/dispatcher-uid-1/driverAssignedTourId'], '6000A_1');
  assert.equal(latestUpdates['users/dispatcher-uid-1/principalType'], 'driver');
  assert.equal(latestUpdates['tour_manifests/6000A_1/assigned_drivers/D-BONDY'], true);
  assert.equal(latestUpdates['tour_manifests/6000A_1/assigned_driver_codes/D-BONDY'].driverId, 'D-BONDY');
  assert.equal(latestUpdates['tour_manifests/5112D_8/assigned_drivers/D-BONDY'], null);
  assert.equal(latestUpdates['tour_manifests/5112D_8/assigned_driver_codes/D-BONDY'], null);
});

test('assignDriverToTour keeps assignment stable when re-assigning to the same tour', async () => {
  const { service, mockDb } = loadServiceWithState({
    drivers: {
      'D-SMITH': {
        name: 'Smith',
        currentTourId: '5112D 8',
      },
    },
    tours: {
      '5112D_8': { name: 'Highlands AM' },
    },
  });

  const result = await service.assignDriverToTour('D-SMITH', '5112D 8');

  assert.equal(result.success, true);

  const latestUpdates = mockDb.updatesHistory.at(-1);
  assert.equal(latestUpdates['tour_manifests/5112D_8/assigned_drivers/D-SMITH'], true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      latestUpdates,
      'tour_manifests/5112D_8/assigned_driver_codes/D-SMITH'
    ),
    true
  );
  assert.equal(
    Object.keys(latestUpdates).some((key) => key.startsWith('tour_manifests/5112D_8/') && latestUpdates[key] === null),
    false
  );
});

test('assignDriverToTour normalizes lowercase input and clears previous canonical links', async () => {
  const { service, mockDb } = loadServiceWithState({
    drivers: {
      'D-MAC': {
        name: 'Mac',
        currentTourId: '5112d 8',
      },
    },
    tours: {
      '5112D_8': { name: 'Highlands AM', tourCode: '5112D 8' },
      '6000A_1': { name: 'Edinburgh PM', tourCode: '6000A 1' },
    },
    tour_manifests: {
      '5112D_8': {
        assigned_drivers: {
          'D-MAC': true,
        },
        assigned_driver_codes: {
          'D-MAC': {
            tourId: '5112D_8',
            tourCode: '5112D 8',
          },
        },
      },
    },
  });

  const result = await service.assignDriverToTour('D-MAC', '6000a 1');

  assert.equal(result.success, true);
  assert.equal(result.tourId, '6000A_1');

  const latestUpdates = mockDb.updatesHistory.at(-1);
  assert.equal(latestUpdates['drivers/D-MAC/currentTourId'], '6000A_1');
  assert.equal(latestUpdates['drivers/D-MAC/currentTourCode'], '6000A 1');
  assert.equal(latestUpdates['tour_manifests/5112D_8/assigned_drivers/D-MAC'], null);
  assert.equal(latestUpdates['tour_manifests/5112D_8/assigned_driver_codes/D-MAC'], null);
  assert.equal(latestUpdates['tour_manifests/6000A_1/assigned_driver_codes/D-MAC'].tourCode, '6000A 1');
});
