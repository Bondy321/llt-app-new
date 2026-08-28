const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { driverAuthorityUpdates } = require('./sessionFixtures');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-driver-rules';
const DRIVER_ID = 'D-DPALMER';
const CLAIMED_DRIVER_ID = 'D-CLAIMED';
const DRIVER_AUTH_UID = 'driver-auth-1';
const OTHER_AUTH_UID = 'driver-auth-2';
const DELEGATED_ADMIN_UID = 'delegated-admin-1';

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

const findDriverAuthorityRulesWithoutPolicy = (value, currentPath = [], missing = []) => {
  if (typeof value === 'string') {
    if (value.includes("root.child('app_sessions/' + auth.uid + '/principalType').val() === 'driver'")
      && !value.includes('driver_login_policy/v1')) {
      missing.push(currentPath.join('/'));
    }
    return missing;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      findDriverAuthorityRulesWithoutPolicy(child, [...currentPath, key], missing);
    });
  }
  return missing;
};

let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: emulator.host,
      port: emulator.port,
      rules,
    },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Palmer',
      currentTourId: '5203L_22',
    });
    await db.ref(`drivers/${CLAIMED_DRIVER_ID}`).set({
      name: 'Claimed Driver',
      authUid: DRIVER_AUTH_UID,
      currentTourId: '5203L_22',
    });
    await db.ref('admin_users/delegated-admin-1').set(true);
    await db.ref('driver_login_policy/v1').set({
      schemaVersion: 1,
      enforceSingleDevice: false,
      generation: 0,
      revision: 1,
      updatedAtMs: Date.now(),
    });
    await db.ref('tours/TOUR_1').set({
      tourCode: 'TOUR 1',
      driverName: 'TBA',
      driverPhone: '',
    });
    await db.ref('tour_manifests/TOUR_1').set({ assigned_drivers: {} });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({ driverId: CLAIMED_DRIVER_ID });
    await db.ref().update(driverAuthorityUpdates({
      uid: DRIVER_AUTH_UID,
      driverId: CLAIMED_DRIVER_ID,
      tourId: '5203L_22',
    }));
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('every RTDB driver authority branch applies the device policy generation', () => {
  assert.deepEqual(findDriverAuthorityRulesWithoutPolicy(JSON.parse(rules)), []);
});

test('denies arbitrary driver record creation by authenticated clients', async () => {
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('drivers/D-FAKE').set({
    name: 'Fake Driver',
    authUid: DRIVER_AUTH_UID,
  }));
});

test('allows claimed driver self reads but denies unclaimed exact reads and driver listing', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}`).get());
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('drivers').get());
});

test('allows admin driver record creation', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref('drivers/D-ADMIN').set({
    name: 'Admin Created',
    authUid: ADMIN_UID,
  }));
});

test('allows operations admins to list portal collections but denies every canonical assignment leaf', async () => {
  for (const adminUid of [ADMIN_UID, DELEGATED_ADMIN_UID]) {
    const adminDb = dbFor(adminUid);
    await assertSucceeds(adminDb.ref('drivers').get());
    await assertSucceeds(adminDb.ref('tours').get());
    await assertSucceeds(adminDb.ref('tour_manifests').get());

    const deniedWrites = [
      adminDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourId`).set('TOUR_1'),
      adminDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourCode`).set('TOUR 1'),
      adminDb.ref(`drivers/${CLAIMED_DRIVER_ID}/assignments/TOUR_1`).set(true),
      adminDb.ref(`drivers/${CLAIMED_DRIVER_ID}/assignmentRevision`).set(2),
      adminDb.ref('tours/TOUR_1/driverName').set('Claimed Driver'),
      adminDb.ref('tours/TOUR_1/driverPhone').set('+44 7700 900000'),
      adminDb.ref('tours/TOUR_1/driverId').set(CLAIMED_DRIVER_ID),
      adminDb.ref('tours/TOUR_1/driverAssignmentRevision').set(2),
      adminDb.ref(`tour_manifests/TOUR_1/assigned_drivers/${CLAIMED_DRIVER_ID}`).set(true),
      adminDb.ref(`tour_manifests/TOUR_1/assigned_driver_codes/${CLAIMED_DRIVER_ID}`).set({
        driverId: CLAIMED_DRIVER_ID,
        tourId: 'TOUR_1',
        tourCode: 'TOUR 1',
        assignedAt: '2026-08-12T10:00:00.000Z',
        assignedBy: adminUid,
      }),
      adminDb.ref(`users/${DRIVER_AUTH_UID}/driverAssignedTourId`).set('TOUR_1'),
    ];
    for (const write of deniedWrites) await assertFails(write);
  }
});

test('denies canonical assignment changes hidden inside otherwise safe parent updates', async () => {
  for (const adminUid of [ADMIN_UID, DELEGATED_ADMIN_UID]) {
    const adminDb = dbFor(adminUid);
    await assertFails(adminDb.ref(`drivers/${CLAIMED_DRIVER_ID}`).update({
      name: 'Safe-looking name',
      currentTourId: 'TOUR_1',
    }));
    await assertFails(adminDb.ref('tours/TOUR_1').update({
      name: 'Safe-looking tour name',
      driverName: 'Forged assignment projection',
    }));
    await assertFails(adminDb.ref('tour_manifests/TOUR_1').update({
      assigned_drivers: { [CLAIMED_DRIVER_ID]: true },
    }));
    await assertFails(adminDb.ref(`users/${DRIVER_AUTH_UID}`).update({
      lastUpdated: 1786538400000,
      driverAssignedTourId: 'TOUR_1',
    }));
  }
});

test('preserves narrowly safe operations-admin driver profile writes', async () => {
  for (const adminUid of [ADMIN_UID, DELEGATED_ADMIN_UID]) {
    const driverId = `D-SAFE-${adminUid === ADMIN_UID ? 'PRIMARY' : 'DELEGATED'}`;
    const adminDb = dbFor(adminUid);
    await assertSucceeds(adminDb.ref(`drivers/${driverId}`).set({
      id: driverId,
      name: 'Safe Driver',
      phone: '+44 7700 900001',
      createdAt: '2026-08-28T10:00:00.000Z',
    }));
    await assertSucceeds(adminDb.ref(`drivers/${driverId}`).update({
      name: 'Updated Safe Driver',
      phone: '+44 7700 900002',
    }));
  }
});

test('delegated operations admins cannot grant or revoke admin access', async () => {
  const delegatedDb = dbFor(DELEGATED_ADMIN_UID);
  await assertFails(delegatedDb.ref('admin_users/delegated-admin-2').set(true));
  await assertFails(delegatedDb.ref(`admin_users/${DELEGATED_ADMIN_UID}`).remove());
  await assertSucceeds(dbFor(ADMIN_UID).ref('admin_users/delegated-admin-2').set(true));
});

test('denies client-side claiming of an unclaimed driver record', async () => {
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}`).update({
    authUid: DRIVER_AUTH_UID,
    lastActive: '2026-05-23T19:45:00.000Z',
  }));
});

test('allows claimed drivers to update their own activity fields', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).update({
    lastActive: '2026-05-23T19:46:00.000Z',
  }));
});

test('denies other users from taking over claimed driver records', async () => {
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).update({
    authUid: OTHER_AUTH_UID,
    lastActive: '2026-05-23T19:47:00.000Z',
  }));
});

test('denies claimed drivers from editing assignment or profile authority fields directly', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourId`).set('OTHER_TOUR'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourCode`).set('OTHER TOUR'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/name`).set('Forged Name'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/assignments/OTHER_TOUR`).set(true));
});

test('off permits a second current handset while on requires the claimed handset and current generation', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      ...driverAuthorityUpdates({
        uid: DRIVER_AUTH_UID,
        driverId: CLAIMED_DRIVER_ID,
        tourId: '5203L_22',
        driverLoginPolicyGeneration: 3,
      }),
      ...driverAuthorityUpdates({
        uid: OTHER_AUTH_UID,
        driverId: CLAIMED_DRIVER_ID,
        tourId: '5203L_22',
        driverLoginPolicyGeneration: 3,
      }),
      [`drivers/${CLAIMED_DRIVER_ID}/authUid`]: DRIVER_AUTH_UID,
      'driver_login_policy/v1': {
        schemaVersion: 1,
        enforceSingleDevice: false,
        generation: 3,
        revision: 1,
        updatedAtMs: Date.now(),
      },
    });
  });

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertSucceeds(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      'driver_login_policy/v1/enforceSingleDevice': true,
      'driver_login_policy/v1/generation': 4,
      'driver_login_policy/v1/revision': 2,
      'driver_login_policy/v1/updatedAtMs': Date.now(),
      [`drivers/${CLAIMED_DRIVER_ID}/authUid`]: null,
    });
  });
  const staleDriverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(staleDriverDb.ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());

  for (const path of [
    'tours/5203L_22/driverLocation',
    'tours/5203L_22/itinerary',
    'tours/5203L_22/safetyAlerts',
    'tours/5203L_22/liveTracking/passenger-1',
    'group_tour_photos/5203L_22',
    'broadcasts/5203L_22',
    'tour_notifications/5203L_22',
    `notification_read_state/5203L_22/driver:${CLAIMED_DRIVER_ID}`,
  ]) {
    await assertFails(staleDriverDb.ref(path).get(), `${path} must reject the stale handset`);
  }
  await assertFails(staleDriverDb.ref('content_reports/stale-driver-report').set({
    reportId: 'stale-driver-report',
    reporterAuthUid: DRIVER_AUTH_UID,
    tourId: '5203L_22',
    status: 'open',
  }));
  await assertFails(
    staleDriverDb.ref(`notification_read_state/5203L_22/driver:${CLAIMED_DRIVER_ID}/notice-1`).set(true),
  );

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      [`app_sessions/${DRIVER_AUTH_UID}/driverLoginPolicyGeneration`]: 4,
      [`drivers/${CLAIMED_DRIVER_ID}/authUid`]: DRIVER_AUTH_UID,
    });
  });
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    await db.ref('driver_login_policy').remove();
    await db.ref(`app_sessions/${OTHER_AUTH_UID}`).remove();
    await db.ref(`users/${OTHER_AUTH_UID}`).remove();
    await db.ref(`app_sessions/${DRIVER_AUTH_UID}/driverLoginPolicyGeneration`).remove();
  });

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('driver_login_policy/v1').get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('driver_login_policy/v1').set({
    schemaVersion: 1,
    enforceSingleDevice: true,
    generation: 999,
    revision: 999,
    updatedAtMs: Date.now(),
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref('driver_login_policy/v1').set({
      schemaVersion: 1,
      enforceSingleDevice: false,
      generation: 'invalid',
      revision: 3,
      updatedAtMs: Date.now(),
    });
  });
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref('driver_login_policy').remove();
  });
});

test('driverAssignedTourId is server-owned even when a client proposes the current assignment', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(driverDb.ref(`users/${DRIVER_AUTH_UID}/driverAssignedTourId`).set('5203L_22'));
  await assertFails(driverDb.ref(`users/${DRIVER_AUTH_UID}/driverAssignedTourId`).set('OTHER_TOUR'));
});

test('claimed drivers cannot manufacture manifest assignment authority', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(
    driverDb.ref(`tour_manifests/FORGED_TOUR/assigned_drivers/${CLAIMED_DRIVER_ID}`).set(true),
  );
  await assertFails(
    driverDb.ref(`tour_manifests/FORGED_TOUR/assigned_driver_codes/${CLAIMED_DRIVER_ID}`).set({
      driverId: CLAIMED_DRIVER_ID,
      tourId: 'FORGED_TOUR',
      tourCode: 'FORGED TOUR',
      assignedAt: '2026-08-12T10:00:00.000Z',
      assignedBy: DRIVER_AUTH_UID,
    }),
  );
});

test('allows a claimed driver to unlink only their own auth uid for account deletion', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      'driver_login_policy/v1': {
        schemaVersion: 1,
        enforceSingleDevice: false,
        generation: 0,
        revision: 4,
        updatedAtMs: Date.now(),
      },
      [`app_sessions/${DRIVER_AUTH_UID}/driverLoginPolicyGeneration`]: 0,
    });
  });
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}/authUid`).remove());
});
