const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { passengerAuthorityUpdates, driverAuthorityUpdates } = require('./sessionFixtures');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-manifest-rules';
const TOUR_ID = '5203L_22';
const TOUR_CODE = '5203L 22';
const BOOKING_REF = 'T123456';
const OTHER_BOOKING_REF = 'TOTHER1';
const MANIFEST_PATH = `tour_manifests/${TOUR_ID}/bookings/${BOOKING_REF}`;
const OTHER_MANIFEST_PATH = `tour_manifests/${TOUR_ID}/bookings/${OTHER_BOOKING_REF}`;
const DRIVER_ID = 'D-DPALMER';
const DRIVER_AUTH_UID = 'driver-auth-1';
const OTHER_DRIVER_ID = 'D-OTHER';
const OTHER_DRIVER_AUTH_UID = 'driver-auth-2';
const PASSENGER_AUTH_UID = 'passenger-auth-1';

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const manifestUpdate = {
  status: 'BOARDED',
  passengerStatus: ['BOARDED'],
  lastUpdated: '2026-05-23T19:47:04.237Z',
  idempotencyKey: 'manifest-test-1',
};

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
    await db.ref(`bookings/${BOOKING_REF}`).set({ tourId: TOUR_ID });
    await db.ref(`bookings/${OTHER_BOOKING_REF}`).set({ tourId: TOUR_ID });
    await db.ref(`tours/${TOUR_ID}/tourCode`).set(TOUR_CODE);
    await db.ref(`tours/${TOUR_ID}/participants/${PASSENGER_AUTH_UID}`).set({
      userId: PASSENGER_AUTH_UID,
      joinedAt: '2026-05-23T19:40:00.000Z',
    });
    await db.ref(`users/${PASSENGER_AUTH_UID}`).set({
      bookingRef: BOOKING_REF,
      principalType: 'passenger',
    });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Palmer',
      authUid: DRIVER_AUTH_UID,
      currentTourId: TOUR_ID,
    });
    await db.ref(`drivers/${OTHER_DRIVER_ID}`).set({
      name: 'Other Driver',
      authUid: OTHER_DRIVER_AUTH_UID,
      currentTourId: 'OTHER_TOUR',
    });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({
      driverId: DRIVER_ID,
      driverPrincipalId: `driver:${DRIVER_ID}`,
      driverAssignedTourId: TOUR_ID,
      principalType: 'driver',
    });
    await db.ref(`users/${OTHER_DRIVER_AUTH_UID}`).set({
      driverId: OTHER_DRIVER_ID,
      driverPrincipalId: `driver:${OTHER_DRIVER_ID}`,
      driverAssignedTourId: 'OTHER_TOUR',
      principalType: 'driver',
    });
    await db.ref().update({
      ...passengerAuthorityUpdates({ uid: PASSENGER_AUTH_UID, tourId: TOUR_ID, bookingRef: BOOKING_REF }),
      ...driverAuthorityUpdates({ uid: DRIVER_AUTH_UID, driverId: DRIVER_ID, tourId: TOUR_ID }),
    });
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows assigned driver auth UID to update passenger manifest booking rows', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).update(manifestUpdate));
});

test('allows exact tour manifest reads but denies listing all manifests', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tour_manifests/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tour_manifests/${TOUR_ID}/bookings/${BOOKING_REF}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('tour_manifests').get());
});

test('allows exact booking reads for tour members but denies listing all bookings', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`bookings/${BOOKING_REF}`).get());
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`bookings/${BOOKING_REF}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('bookings').get());
});

test('keeps passenger participant manifest updates working', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-passenger',
  }));
});

test('denies passenger manifest updates for another booking on the same tour', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(OTHER_MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-passenger-other-booking',
  }));
});

test('denies unassigned driver auth UID from updating another tour manifest', async () => {
  await assertFails(dbFor(OTHER_DRIVER_AUTH_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-unassigned-driver',
  }));
});

test('allows admin manifest update', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-admin',
  }));
});

test('source-managed boarding requires the exact current revision and aligned passenger IDs', async () => {
  const ids = ['a','b'].map(char => `srcpax_v1_${char.repeat(64)}`);
  const firstRevision = 'a'.repeat(64);
  const secondRevision = 'b'.repeat(64);
  const seed = async updates => testEnv.withSecurityRulesDisabled(context => context.database(dbUrl).ref().update(updates));
  await seed({
    [`bookings/${BOOKING_REF}/sourceRoster`]: {schemaVersion:1,state:'active',revision:firstRevision,passengerIds:ids,
      passengerCount:2,passengerIdsJson:JSON.stringify(ids)},
    [`tours/${TOUR_ID}/rosterSync`]: {schemaVersion:1,state:'ready',generation:firstRevision,reportDate:'2026-10-10'},
  });
  const current = {...manifestUpdate,rosterRevision:firstRevision,passengerIds:ids,passengerStatus:['BOARDED','PENDING'],
    passengerIdsJson:JSON.stringify(ids),passengerStatusCodes:'BP'};
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(manifestUpdate));
  for (const codes of ['B','BPP','BX','']) {
    await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set({...current,passengerStatusCodes:codes}));
  }
  for (const field of ['passengerIdsJson','passengerStatusCodes','rosterRevision']) {
    const incomplete = {...current};
    delete incomplete[field];
    await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(incomplete));
  }
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(current));
  await seed({[`bookings/${BOOKING_REF}/sourceRoster/revision`]:secondRevision,
    [`bookings/${BOOKING_REF}/sourceRoster/passengerIds`]:[ids[1],ids[0]],
    [`bookings/${BOOKING_REF}/sourceRoster/passengerIdsJson`]:JSON.stringify([ids[1],ids[0]])});
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(current));
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set({...current,rosterRevision:secondRevision}));
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set({
    ...current,rosterRevision:secondRevision,passengerIds:[ids[1],ids[0]],passengerStatus:['PENDING','BOARDED'],
    passengerIdsJson:JSON.stringify([ids[1],ids[0]]),passengerStatusCodes:'PB',
  }));
  await seed({[`tours/${TOUR_ID}/rosterSync/state`]:'updating'});
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(current));
  await seed({[`tours/${TOUR_ID}/rosterSync/state`]:'ready',
    [`bookings/${BOOKING_REF}/sourceRoster/state`]:'not_in_report'});
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).set(current));
  await seed({[`bookings/${BOOKING_REF}/sourceRoster`]:null,[`tours/${TOUR_ID}/rosterSync`]:null});
});

test('archive and publisher control are server-private for every app role including browser admin', async () => {
  await testEnv.withSecurityRulesDisabled(context => context.database(dbUrl).ref().update({
    'sync_roster_archive/SYNTHETIC/hash':{snapshot:{passengerNames:['Synthetic archived row']}},
    'sync_roster_control/SYNTHETIC':{owner:'opaque-owner'},
  }));
  for (const uid of [ADMIN_UID,DRIVER_AUTH_UID,PASSENGER_AUTH_UID]) {
    for (const root of ['sync_roster_archive','sync_roster_control']) {
      await assertFails(dbFor(uid).ref(root).once('value'));
      await assertFails(dbFor(uid).ref(`${root}/SYNTHETIC`).set({forged:true}));
    }
  }
});
