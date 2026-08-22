const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-driver-assignment',
  storageBucket: 'demo-llt-driver-assignment.appspot.com',
});

const { __testables } = require('../functions/index.js');

test('driver self-assignment update keeps every canonical path coherent and removes the old tour links', () => {
  const result = __testables.buildDriverSelfAssignmentUpdates({
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
    driverData: {
      name: 'Alex Bond',
      phone: '+44 7700 900000',
      currentTourId: '5112D_8',
    },
    tourId: '6000A_1',
    tourData: { tourCode: '6000A 1', isActive: true },
    previousTourData: { driverId: 'D-BONDY', driverName: 'Alex Bond' },
    nowMs: Date.parse('2026-08-12T15:00:00.000Z'),
  });

  assert.equal(result.previousTourId, '5112D_8');
  assert.equal(result.canonicalTourCode, '6000A 1');
  assert.equal(result.updates['tours/6000A_1/driverId'], 'D-BONDY');
  assert.equal(result.updates['tours/6000A_1/driverName'], 'Alex Bond');
  assert.equal(result.updates['tours/6000A_1/driverPhone'], '+44 7700 900000');
  assert.equal(result.updates['drivers/D-BONDY/currentTourId'], '6000A_1');
  assert.equal(result.updates['drivers/D-BONDY/assignments/6000A_1'], true);
  assert.equal(result.updates['drivers/D-BONDY/assignments/5112D_8'], null);
  assert.equal(result.updates['users/driver-auth-1/driverAssignedTourId'], '6000A_1');
  assert.equal(result.updates['tour_manifests/6000A_1/assigned_drivers/D-BONDY'], true);
  assert.deepEqual(result.updates['tour_manifests/6000A_1/assigned_driver_codes/D-BONDY'], {
    driverId: 'D-BONDY',
    tourId: '6000A_1',
    tourCode: '6000A 1',
    assignedAt: '2026-08-12T15:00:00.000Z',
    assignedBy: 'driver-auth-1',
  });
  assert.equal(result.updates['tour_manifests/5112D_8/assigned_drivers/D-BONDY'], null);
  assert.equal(result.updates['tours/5112D_8/driverId'], null);
  assert.equal(result.updates['tours/5112D_8/driverName'], null);
  assert.equal(result.updates['tours/5112D_8/driverPhone'], null);
  assert.equal(result.updates['tours/5112D_8/driverLocation'], null);
  assert.equal(result.updates['tours/6000A_1/driverLocation'], null);
});

test('driver self-assignment does not erase old tour metadata owned by another driver', () => {
  const result = __testables.buildDriverSelfAssignmentUpdates({
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
    driverData: { name: 'Alex', currentTourId: 'OLD_TOUR' },
    tourId: 'NEW_TOUR',
    tourData: { tourCode: 'NEW TOUR' },
    previousTourData: { driverId: 'D-OTHER', driverName: 'Other Driver' },
    nowMs: 1_786_550_400_000,
  });

  assert.equal(result.updates['tour_manifests/OLD_TOUR/assigned_drivers/D-BONDY'], null);
  assert.equal(result.updates['tours/OLD_TOUR/driverId'], undefined);
  assert.equal(result.updates['tours/OLD_TOUR/driverName'], undefined);
  assert.equal(result.updates['tours/OLD_TOUR/driverLocation'], undefined);
});

test('idempotent self-assignment preserves the current driver location', () => {
  const result = __testables.buildDriverSelfAssignmentUpdates({
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
    driverData: { name: 'Alex', currentTourId: 'TOUR_1' },
    tourId: 'TOUR_1',
    tourData: { tourCode: 'TOUR 1', driverId: 'D-BONDY' },
    nowMs: 1_786_550_400_000,
  });

  assert.equal(result.updates['tours/TOUR_1/driverLocation'], undefined);
});

test('driver assignment conflict detection checks both tour metadata and manifest links', () => {
  assert.deepEqual(__testables.collectDriverAssignmentConflicts({
    driverId: 'D-BONDY',
    tourData: { driverId: 'd-other' },
    manifestData: {
      assigned_drivers: {
        'D-BONDY': true,
        'D-SECOND': true,
        'D-INACTIVE': false,
      },
    },
  }), ['D-OTHER', 'D-SECOND']);
});

test('driver claim transaction is idempotent for the owner and rejects a competing uid', async () => {
  let currentValue = null;
  const db = {
    ref(path) {
      assert.equal(path, 'drivers/D-BONDY/authUid');
      return {
        async transaction(updater) {
          const nextValue = updater(currentValue);
          if (nextValue === undefined) {
            return { committed: false, snapshot: { val: () => currentValue } };
          }
          currentValue = nextValue;
          return { committed: true, snapshot: { val: () => currentValue } };
        },
      };
    },
  };

  assert.deepEqual(await __testables.claimDriverAuthUid({
    db,
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
  }), { claimed: true, authUid: 'driver-auth-1' });
  assert.deepEqual(await __testables.claimDriverAuthUid({
    db,
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
  }), { claimed: true, authUid: 'driver-auth-1' });
  assert.deepEqual(await __testables.claimDriverAuthUid({
    db,
    driverId: 'D-BONDY',
    authUid: 'driver-auth-2',
  }), { claimed: false, authUid: 'driver-auth-1' });
});

test('verified driver identity persistence is complete for assigned and unassigned drivers', () => {
  const assigned = __testables.buildDriverIdentityProfileUpdates({
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
    assignedTourId: 'TOUR_1',
    nowMs: Date.parse('2026-08-12T15:30:00.000Z'),
  });
  assert.deepEqual(assigned, {
    'drivers/D-BONDY/lastActive': '2026-08-12T15:30:00.000Z',
    'users/driver-auth-1/driverId': 'D-BONDY',
    'users/driver-auth-1/driverPrincipalId': 'driver:D-BONDY',
    'users/driver-auth-1/driverAssignedTourId': 'TOUR_1',
    'users/driver-auth-1/principalType': 'driver',
    'users/driver-auth-1/lastUpdated': Date.parse('2026-08-12T15:30:00.000Z'),
  });

  const unassigned = __testables.buildDriverIdentityProfileUpdates({
    driverId: 'D-BONDY',
    authUid: 'driver-auth-1',
    nowMs: 123,
  });
  assert.equal(unassigned['users/driver-auth-1/driverAssignedTourId'], null);
});

test('driver login limiter enforces credential, account, and network dimensions independently', async () => {
  const calls = [];
  const allowed = await __testables.checkDriverLoginRateLimits({
    authUid: 'auth-1',
    clientKey: 'network-1',
    driverId: 'D-BONDY',
    limiter: (key, maxRequests, windowMs) => {
      calls.push({ key, maxRequests, windowMs });
      return true;
    },
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(calls.map(({ maxRequests }) => maxRequests), [8, 24, 200]);
  assert.ok(calls.every(({ windowMs }) => windowMs === 60000));

  const denied = await __testables.checkDriverLoginRateLimits({
    authUid: 'auth-1',
    clientKey: 'network-1',
    driverId: 'D-BONDY',
    limiter: (key) => !key.includes('_account_'),
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'account');
});

test('invalid push token cleanup is awaited and isolates per-recipient failures', async () => {
  const calls = [];
  const result = await __testables.cleanupInvalidTokens([
    { userId: 'user-1', token: 'token-1' },
    { userId: 'user-2', token: 'token-2', reason: 'DEVICE_NOT_REGISTERED' },
  ], async (userId, token, options) => {
    calls.push({ userId, token, options });
    if (userId === 'user-2') throw new Error('transient cleanup failure');
  });

  assert.deepEqual(result, { attempted: 2, failed: 1 });
  assert.deepEqual(calls, [
    { userId: 'user-1', token: 'token-1', options: undefined },
    { userId: 'user-2', token: 'token-2', options: { reason: 'DEVICE_NOT_REGISTERED' } },
  ]);
  assert.deepEqual(await __testables.cleanupInvalidTokens(null, async () => {}), {
    attempted: 0,
    failed: 0,
  });
});
