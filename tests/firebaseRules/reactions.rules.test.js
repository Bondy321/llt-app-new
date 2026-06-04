const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { sendInternalDriverMessage } = require('../../services/chatService');
const { toRealtimeKeySegment } = require('../../services/identityService');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-rules';
const TOUR_ID = 'TOUR_001';
const MESSAGE_ID = 'MSG_001';
const MESSAGE_PATH = `chats/${TOUR_ID}/messages/${MESSAGE_ID}`;
const REACTION_PATH = `${MESSAGE_PATH}/reactions/👍`;
const INCOMPLETE_MESSAGE_ID = 'MSG_INCOMPLETE_001';
const INCOMPLETE_MESSAGE_PATH = `chats/${TOUR_ID}/messages/${INCOMPLETE_MESSAGE_ID}`;
const INCOMPLETE_REACTION_PATH = `${INCOMPLETE_MESSAGE_PATH}/reactions/incomplete_like`;
const INCOMPLETE_SENDER_UID = 'incomplete-sender-1';
const DRIVER_MESSAGE_ID = 'MSG_DRIVER_001';
const DRIVER_MESSAGE_PATH = `chats/${TOUR_ID}/messages/${DRIVER_MESSAGE_ID}`;
const DRIVER_AUTH_UID = 'driver-auth-1';
const DRIVER_ID = 'BONDY';
const DRIVER_PRINCIPAL_ID = `driver:${DRIVER_ID}`;
const PASSENGER_AUTH_UID = 'passenger-auth-1';
const PASSENGER_PRINCIPAL_ID = 'pax_v1:ABC123:demo@example.com';
const PASSENGER_PRINCIPAL_KEY = toRealtimeKeySegment(PASSENGER_PRINCIPAL_ID);
const UNATTACHED_AUTH_UID = 'unattached-auth-1';
const INTERNAL_TOUR_ID = 'TOUR_INTERNAL_001';

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs
  .readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8')
  .replace(/\\s/g, ' ');

let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const seedMessage = async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(MESSAGE_PATH).set({
      senderId: 'userB',
      senderStableId: 'userB',
      senderName: 'User B',
      text: 'original text',
      timestamp: 1710000000000,
      isDriver: false,
      status: 'sent',
    });
    await context.database(dbUrl).ref(INCOMPLETE_MESSAGE_PATH).set({
      senderId: INCOMPLETE_SENDER_UID,
      senderName: 'Incomplete Sender',
      text: 'message without stable sender identity',
      timestamp: 1710000000001,
      isDriver: false,
      status: 'sent',
    });

    await context.database(dbUrl).ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Bondy',
      authUid: DRIVER_AUTH_UID,
    });
    await context.database(dbUrl).ref(`tours/${TOUR_ID}/participants/userA`).set({
      userId: 'userA',
      joinedAt: 1710000000000,
    });
    await context.database(dbUrl).ref(`tours/${TOUR_ID}/participants/${PASSENGER_AUTH_UID}`).set({
      userId: PASSENGER_AUTH_UID,
      joinedAt: 1710000000000,
    });
    await context.database(dbUrl).ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await context.database(dbUrl).ref(`tour_manifests/${INTERNAL_TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await context.database(dbUrl).ref(`users/${DRIVER_AUTH_UID}`).set({
      driverId: DRIVER_ID,
      driverPrincipalId: DRIVER_PRINCIPAL_ID,
      principalType: 'driver',
    });
    await context.database(dbUrl).ref(`identity_bindings/${PASSENGER_PRINCIPAL_KEY}/${PASSENGER_AUTH_UID}`).set(true);
    await context.database(dbUrl).ref(`users/${PASSENGER_AUTH_UID}`).set({
      stablePassengerId: PASSENGER_PRINCIPAL_ID,
      privatePhotoOwnerId: PASSENGER_PRINCIPAL_ID,
    });
  });
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

  await seedMessage();
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows user A to write own reaction leaf on message sent by user B', async () => {
  await assertSucceeds(dbFor('userA').ref(`${REACTION_PATH}/userA`).set(true));
});

test('allows user A to remove own reaction leaf', async () => {
  const ownLeaf = dbFor('userA').ref(`${REACTION_PATH}/userA`);
  await assertSucceeds(ownLeaf.set(true));
  await assertSucceeds(ownLeaf.remove());
});

test('denies reaction leaf writes on messages missing senderStableId', async () => {
  await assertFails(dbFor('userA').ref(`${INCOMPLETE_REACTION_PATH}/userA`).set(true));
});

test('denies unattached signed-in users from reading or writing another tour chat', async () => {
  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`chats/${TOUR_ID}/messages`).get());
  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`chats/${TOUR_ID}/typing/${UNATTACHED_AUTH_UID}`).set({
    name: 'Unattached User',
    timestamp: Date.now(),
  }));
});

test('denies editing message text when required identity fields are missing', async () => {
  await assertFails(dbFor(INCOMPLETE_SENDER_UID).ref(`${INCOMPLETE_MESSAGE_PATH}/text`).set('edited message text'));
});

test('allows verified driver principals to create group chat messages without driver identity bindings', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(DRIVER_MESSAGE_PATH).set({
    senderId: DRIVER_PRINCIPAL_ID,
    senderStableId: DRIVER_PRINCIPAL_ID,
    senderName: 'Driver Bondy',
    text: 'Driver update',
    timestamp: 1710000000002,
    isDriver: true,
    status: 'sent',
  }));
});

test('allows verified sender to soft-delete a group chat message tombstone', async () => {
  const softDeletePath = `chats/${TOUR_ID}/messages/MSG_SOFT_DELETE_DRIVER`;
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(softDeletePath).set({
    senderId: DRIVER_PRINCIPAL_ID,
    senderStableId: DRIVER_PRINCIPAL_ID,
    senderName: 'Driver Bondy',
    text: 'Delete me',
    timestamp: 1710000000005,
    isDriver: true,
    status: 'sent',
  }));

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(softDeletePath).update({
    deleted: true,
    text: '',
    deletedAt: new Date(1710000000006).toISOString(),
    deletedBy: DRIVER_PRINCIPAL_ID,
  }));

  const snapshot = await dbFor(DRIVER_AUTH_UID).ref(softDeletePath).get();
  assert.equal(snapshot.child('deleted').val(), true);
  assert.equal(snapshot.child('text').val(), '');
});

test('denies unverified callers creating group chat messages as a driver principal', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`${DRIVER_MESSAGE_PATH}_foreign`).set({
    senderId: DRIVER_PRINCIPAL_ID,
    senderStableId: DRIVER_PRINCIPAL_ID,
    senderName: 'Driver Bondy',
    text: 'Spoofed driver update',
    timestamp: 1710000000003,
    isDriver: true,
    status: 'sent',
  }));
});

test('denies user A writing reaction leaf for user B', async () => {
  await assertFails(dbFor('userA').ref(`${REACTION_PATH}/userB`).set(true));
});

test('denies user A overwriting emoji reaction object directly', async () => {
  await assertFails(dbFor('userA').ref(REACTION_PATH).set({ userA: true }));
});

test('denies user A editing message text on message by user B', async () => {
  await assertFails(dbFor('userA').ref(`${MESSAGE_PATH}/text`).set('tampered text'));
});

test('allows principal-based reaction leaf writes via users/{auth.uid} + identity_bindings', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`${REACTION_PATH}/${PASSENGER_PRINCIPAL_KEY}`).set(true));
});

test('allows driver principal reaction leaf writes via verified driver auth profile', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`${REACTION_PATH}/${DRIVER_PRINCIPAL_ID}`).set(true));
});

test('denies driver principal reaction leaf writes when driver auth profile does not match', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`${REACTION_PATH}/${DRIVER_PRINCIPAL_ID}`).set(true));
});

test('allows principal-based typing writes via users/{auth.uid} + identity_bindings', async () => {
  await assertSucceeds(
    dbFor(PASSENGER_AUTH_UID).ref(`chats/${TOUR_ID}/typing/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      timestamp: Date.now(),
    })
  );
});

test('allows principal-based presence writes via users/{auth.uid} + identity_bindings', async () => {
  await assertSucceeds(
    dbFor(PASSENGER_AUTH_UID).ref(`chats/${TOUR_ID}/presence/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      lastSeen: Date.now(),
      online: true,
    })
  );
});

test('allows driver principal typing and presence writes via verified driver auth profile', async () => {
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID).ref(`chats/${TOUR_ID}/typing/${DRIVER_PRINCIPAL_ID}`).set({
      name: 'Driver Bondy',
      timestamp: Date.now(),
      isDriver: true,
    })
  );
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID).ref(`chats/${TOUR_ID}/presence/${DRIVER_PRINCIPAL_ID}`).set({
      name: 'Driver Bondy',
      lastSeen: Date.now(),
      online: true,
      isDriver: true,
    })
  );
});

test('denies principal-based chat writes when identity_bindings ownership is missing', async () => {
  const foreignPrincipalId = 'pax:FOREIGN';

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(`users/${PASSENGER_AUTH_UID}/stablePassengerId`).set(foreignPrincipalId);
    await context.database(dbUrl).ref(`users/${PASSENGER_AUTH_UID}/privatePhotoOwnerId`).set(foreignPrincipalId);
    await context.database(dbUrl).ref(`identity_bindings/${PASSENGER_PRINCIPAL_KEY}/${PASSENGER_AUTH_UID}`).remove();
  });

  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`${REACTION_PATH}/${PASSENGER_PRINCIPAL_KEY}`).set(true));
  await assertFails(
    dbFor(PASSENGER_AUTH_UID).ref(`chats/${TOUR_ID}/typing/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      timestamp: Date.now(),
    })
  );
  await assertFails(
    dbFor(PASSENGER_AUTH_UID).ref(`chats/${TOUR_ID}/presence/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      lastSeen: Date.now(),
      online: true,
    })
  );
});

test('allows admin actions per existing policy (message text edit)', async () => {
  const adminTextRef = dbFor(ADMIN_UID).ref(`${MESSAGE_PATH}/text`);
  await assertSucceeds(adminTextRef.set('admin text update'));

  const snapshot = await adminTextRef.get();
  assert.equal(snapshot.val(), 'admin text update');
});

test('service-generated internal driver message payload is accepted by rules', async () => {
  const senderInfo = {
    name: 'Driver Bondy',
    principalId: DRIVER_PRINCIPAL_ID,
    principalType: 'driver',
    isDriver: true,
  };

  const result = await sendInternalDriverMessage(
    INTERNAL_TOUR_ID,
    'Internal operations update',
    senderInfo,
    dbFor(DRIVER_AUTH_UID),
    { messageId: 'int_rules_001' }
  );

  assert.equal(result.success, true);
  const written = await dbFor(DRIVER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/messages/int_rules_001`).get();
  assert.equal(written.exists(), true);
  assert.equal(written.child('senderType').val(), 'driver');
  assert.equal(written.child('senderStableId').val(), DRIVER_PRINCIPAL_ID);
});

test('denies passenger principals from creating internal driver chat messages', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/messages/passenger_probe`).set({
    senderId: PASSENGER_PRINCIPAL_ID,
    senderStableId: PASSENGER_PRINCIPAL_ID,
    senderName: 'Passenger One',
    text: 'Passenger should not be in the internal driver chat',
    timestamp: 1710000000004,
    isDriver: true,
    status: 'sent',
  }));
});

test('allows internal driver lastRead writes through canonical driver identity', async () => {
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID)
      .ref(`internal_chats/${INTERNAL_TOUR_ID}/lastRead/${DRIVER_PRINCIPAL_ID}`)
      .set(Date.now())
  );
  await assertFails(
    dbFor(PASSENGER_AUTH_UID)
      .ref(`internal_chats/${INTERNAL_TOUR_ID}/lastRead/${PASSENGER_PRINCIPAL_KEY}`)
      .set(Date.now())
  );
});

test('allows internal driver typing and presence only for assigned driver principals', async () => {
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/typing/${DRIVER_PRINCIPAL_ID}`).set({
      name: 'Driver Bondy',
      timestamp: Date.now(),
      isDriver: true,
    })
  );
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/presence/${DRIVER_PRINCIPAL_ID}`).set({
      name: 'Driver Bondy',
      lastSeen: Date.now(),
      online: true,
      isDriver: true,
    })
  );

  await assertFails(
    dbFor(PASSENGER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/typing/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      timestamp: Date.now(),
    })
  );
  await assertFails(
    dbFor(PASSENGER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/presence/${PASSENGER_PRINCIPAL_KEY}`).set({
      name: 'Passenger One',
      lastSeen: Date.now(),
      online: true,
    })
  );
});
