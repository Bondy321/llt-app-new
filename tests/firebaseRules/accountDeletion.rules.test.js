'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { toRealtimeKeySegment } = require('../../services/identityService');
const { passengerAuthorityUpdates, driverAuthorityUpdates } = require('./sessionFixtures');

const PROJECT_ID = 'demo-llt-account-deletion-rules';
const TOUR_ID = 'TOUR_DELETE_001';
const BOOKING_REF = 'T123456';
const PASSENGER_AUTH_UID = 'passenger-delete-auth-1';
const PASSENGER_STABLE_ID = 'pax_v2_66666666666666666666666666666666';
const PASSENGER_STABLE_KEY = toRealtimeKeySegment(PASSENGER_STABLE_ID);
const DRIVER_AUTH_UID = 'driver-delete-auth-1';
const SECOND_DRIVER_AUTH_UID = 'driver-delete-auth-2';
const DRIVER_ID = 'D-REVIEW';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const DELEGATED_ADMIN_UID = 'delegated-delete-admin';

const VALID_COMPATIBILITY = {
  schemaVersion: 1,
  phase: 'compatibility',
  revision: 1,
  updatedAtMs: 1787900000000,
};
const VALID_SERVER_ONLY = {
  ...VALID_COMPATIBILITY,
  phase: 'server_only',
  revision: 2,
};

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
const unauthenticatedDb = () => testEnv.unauthenticatedContext().database(dbUrl);

const seedState = async (rollout) => {
  await testEnv.clearDatabase();
  const nowMs = Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    const updates = {
      ...passengerAuthorityUpdates({
        uid: PASSENGER_AUTH_UID,
        tourId: TOUR_ID,
        principalId: PASSENGER_STABLE_ID,
        bookingRef: BOOKING_REF,
        nowMs,
      }),
      ...driverAuthorityUpdates({
        uid: DRIVER_AUTH_UID,
        driverId: DRIVER_ID,
        tourId: TOUR_ID,
        nowMs,
      }),
      [`identity_bindings/${PASSENGER_STABLE_KEY}/${PASSENGER_AUTH_UID}`]: true,
      [`passenger_identity_security/${BOOKING_REF}/passengerPrincipalId`]: PASSENGER_STABLE_ID,
      [`passenger_identity_security/${BOOKING_REF}/passengerIdentityVersion`]: 'pax_v2',
      [`passenger_identity_security/${BOOKING_REF}/authorizedAuthUid`]: PASSENGER_AUTH_UID,
      [`logs/${PASSENGER_AUTH_UID}/session_1/log_1`]: { level: 'INFO', message: 'passenger log' },
      [`logs/${DRIVER_AUTH_UID}/session_1/log_1`]: { level: 'INFO', message: 'driver log' },
      [`drivers/${DRIVER_ID}/name`]: 'Review Driver',
      [`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`]: {
        userId: PASSENGER_AUTH_UID,
        isSharing: true,
        lastUpdate: '2026-08-29T08:00:00.000Z',
        coords: { latitude: 56.1, longitude: -4.6 },
      },
      [`chats/${TOUR_ID}/messages/passenger-owned`]: {
        schemaVersion: 2,
        senderId: PASSENGER_STABLE_ID,
        senderStableId: PASSENGER_STABLE_ID,
        senderName: 'Passenger',
        senderType: 'passenger',
        text: 'keep normal message controls working',
        timestamp: 1787980000000,
        clientCreatedAt: 1787980000000,
        isDriver: false,
        status: 'sent',
        idempotencyKey: 'passenger-owned',
        type: 'text',
      },
      [`chats/${TOUR_ID}/messages/reaction-target`]: {
        schemaVersion: 2,
        senderId: 'pax_v2_77777777777777777777777777777777',
        senderStableId: 'pax_v2_77777777777777777777777777777777',
        senderName: 'Other Passenger',
        senderType: 'passenger',
        text: 'reaction target',
        timestamp: 1787980000001,
        clientCreatedAt: 1787980000001,
        isDriver: false,
        status: 'sent',
        idempotencyKey: 'reaction-target',
        type: 'text',
      },
      [`group_tour_photos/${TOUR_ID}/photo-1`]: {
        userId: PASSENGER_STABLE_ID,
        storagePath: `group_tour_photos/${TOUR_ID}/photo-1.jpg`,
        timestamp: 1787980000002,
        variantStatus: 'ready',
        variantVersion: 2,
        caption: 'before',
      },
      [`tour_notifications/${TOUR_ID}/notice-1`]: {
        noticeId: 'notice-1',
        version: 1,
        type: 'announcement',
        title: 'Notice',
        body: 'Normal read-state writes stay available.',
        tourId: TOUR_ID,
        screen: 'Chat',
        sourceId: 'source-1',
        priority: 'normal',
        createdAt: '2026-08-29T08:00:00.000Z',
        createdAtMs: 1787980000003,
      },
      [`admin_users/${DELEGATED_ADMIN_UID}`]: true,
      'operations_terminal_warnings/v1/warning-test': {
        schemaVersion: 1,
        warningId: 'warning-test',
        jobType: 'account_deletion',
        reason: 'requires_attention',
        identifierHashes: { authUidHash: 'a'.repeat(24) },
        attemptCount: 3,
        firstAttemptAtMs: 1787900000000,
        lastAttemptAtMs: 1787900100000,
        expiresAtMs: 1787900200000,
        createdAtMs: 1787900000000,
        updatedAtMs: 1787900100000,
        status: 'open',
        acknowledged: false,
        resolved: false,
        retainUntilMs: 1790492200000,
      },
      'account_deletion_jobs/v1/private-job': { status: 'pending', authUid: PASSENGER_AUTH_UID },
      'account_deletion_queue/v1/private-job': { availableAtMs: 1787900000000 },
      [`account_deletion_active/v1/${PASSENGER_AUTH_UID}`]: 'private-job',
      [`account_deletion_locks/v1/${PASSENGER_AUTH_UID}`]: { owner: 'private-job' },
    };
    if (rollout !== undefined) updates['account_deletion_rollout/v1'] = rollout;
    await db.ref().update(updates);
  });
};

const legacyDeletionAttempts = () => [
  { label: 'full self user record', uid: PASSENGER_AUTH_UID, path: `users/${PASSENGER_AUTH_UID}` },
  { label: 'whole self log branch', uid: PASSENGER_AUTH_UID, path: `logs/${PASSENGER_AUTH_UID}` },
  { label: 'driver ownership scalar', uid: DRIVER_AUTH_UID, path: `drivers/${DRIVER_ID}/authUid` },
  { label: 'identity binding', uid: PASSENGER_AUTH_UID, path: `identity_bindings/${PASSENGER_STABLE_KEY}/${PASSENGER_AUTH_UID}` },
  { label: 'passenger authorization scalar', uid: PASSENGER_AUTH_UID, path: `passenger_identity_security/${BOOKING_REF}/authorizedAuthUid` },
];

const assertLegacyDeletionMatrix = async ({ rollout, allowed }) => {
  for (const attempt of legacyDeletionAttempts()) {
    await seedState(rollout);
    const operation = dbFor(attempt.uid).ref(attempt.path).remove();
    try {
      if (allowed) await assertSucceeds(operation);
      else await assertFails(operation);
    } catch (error) {
      error.message = `${attempt.label}: ${error.message}`;
      throw error;
    }
  }
};

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
});

test.beforeEach(async () => {
  await seedState(undefined);
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('all account-deletion infrastructure roots deny every client, including admins', async () => {
  const roots = [
    'account_deletion_jobs',
    'account_deletion_queue',
    'account_deletion_active',
    'account_deletion_completion_tombstones',
    'account_deletion_locks',
    'account_deletion_passenger_active',
    'account_deletion_passenger_locks',
    'account_deletion_uid_tombstones',
    'account_deletion_rollout',
    'media_record_locks',
  ];
  const clients = [
    unauthenticatedDb(),
    dbFor(PASSENGER_AUTH_UID),
    dbFor(DRIVER_AUTH_UID),
    dbFor(ADMIN_UID),
    dbFor(DELEGATED_ADMIN_UID),
  ];

  for (const client of clients) {
    for (const rootName of roots) {
      await assertFails(client.ref(rootName).get());
      await assertFails(client.ref(`${rootName}/client-probe`).set(true));
    }
  }
});

test('terminal warnings remain operations-readable and client-write denied', async () => {
  const warningPath = 'operations_terminal_warnings/v1/warning-test';
  await assertSucceeds(dbFor(ADMIN_UID).ref(warningPath).get());
  await assertSucceeds(dbFor(DELEGATED_ADMIN_UID).ref(warningPath).get());
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(warningPath).get());
  await assertFails(dbFor(ADMIN_UID).ref(`${warningPath}/status`).set('acknowledged'));
  await assertFails(dbFor(DELEGATED_ADMIN_UID).ref(warningPath).remove());
});

test('missing rollout preserves all five compatibility deletion permissions', async () => {
  await assertLegacyDeletionMatrix({ rollout: undefined, allowed: true });
});

test('valid explicit compatibility rollout preserves all five deletion permissions', async () => {
  await assertLegacyDeletionMatrix({ rollout: VALID_COMPATIBILITY, allowed: true });
});

test('valid server-only rollout blocks all five legacy deletion permissions', async () => {
  await assertLegacyDeletionMatrix({ rollout: VALID_SERVER_ONLY, allowed: false });
});

test('malformed, partial, and unknown rollout records fail closed', async () => {
  const malformedRecords = [
    { ...VALID_COMPATIBILITY, schemaVersion: 2 },
    { schemaVersion: 1, phase: 'compatibility', revision: 1 },
    { ...VALID_COMPATIBILITY, phase: 'legacy' },
    { ...VALID_COMPATIBILITY, revision: 0 },
    { ...VALID_COMPATIBILITY, updatedAtMs: 'not-a-number' },
  ];

  for (const rollout of malformedRecords) {
    await seedState(rollout);
    for (const attempt of legacyDeletionAttempts()) {
      await assertFails(dbFor(attempt.uid).ref(attempt.path).remove(), attempt.label);
    }
  }
});

test('server-only rejects passenger and driver multi-location legacy cleanup atomically', async () => {
  await seedState(VALID_SERVER_ONLY);
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref().update({
    [`users/${PASSENGER_AUTH_UID}`]: null,
    [`logs/${PASSENGER_AUTH_UID}`]: null,
    [`identity_bindings/${PASSENGER_STABLE_KEY}/${PASSENGER_AUTH_UID}`]: null,
    [`passenger_identity_security/${BOOKING_REF}/authorizedAuthUid`]: null,
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref().update({
    [`users/${DRIVER_AUTH_UID}`]: null,
    [`logs/${DRIVER_AUTH_UID}`]: null,
    [`drivers/${DRIVER_ID}/authUid`]: null,
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    for (const attempt of legacyDeletionAttempts()) {
      assert.equal((await db.ref(attempt.path).get()).exists(), true, attempt.label);
    }
    assert.equal((await db.ref(`users/${DRIVER_AUTH_UID}`).get()).exists(), true);
    assert.equal((await db.ref(`logs/${DRIVER_AUTH_UID}`).get()).exists(), true);
  });
});

test('unassigned drivers receive no compatibility or server-only scalar-unlink exception', async () => {
  for (const rollout of [VALID_COMPATIBILITY, VALID_SERVER_ONLY]) {
    await seedState(rollout);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.database(dbUrl).ref().update({
        [`app_sessions/${DRIVER_AUTH_UID}/tourId`]: null,
        [`users/${DRIVER_AUTH_UID}/driverAssignedTourId`]: null,
        [`drivers/${DRIVER_ID}/currentTourId`]: null,
        [`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`]: null,
      });
    });
    await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}/authUid`).remove());
  }
});

test('a second handset cannot remove another driver session ownership scalar', async () => {
  for (const rollout of [VALID_COMPATIBILITY, VALID_SERVER_ONLY]) {
    await seedState(rollout);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.database(dbUrl);
      await db.ref().update({
        ...driverAuthorityUpdates({
          uid: SECOND_DRIVER_AUTH_UID,
          driverId: DRIVER_ID,
          tourId: TOUR_ID,
          nowMs: Date.now(),
        }),
        [`drivers/${DRIVER_ID}/authUid`]: DRIVER_AUTH_UID,
      });
    });
    await assertFails(dbFor(SECOND_DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}/authUid`).remove());
    await testEnv.withSecurityRulesDisabled(async (context) => {
      assert.equal(
        (await context.database(dbUrl).ref(`drivers/${DRIVER_ID}/authUid`).get()).val(),
        DRIVER_AUTH_UID,
      );
    });
  }
});

test('ordinary profile, log, chat, caption, notification, and live-state writes survive both rollout phases', async () => {
  for (const rollout of [VALID_COMPATIBILITY, VALID_SERVER_ONLY]) {
    await seedState(rollout);
    const db = dbFor(PASSENGER_AUTH_UID);

    await assertSucceeds(db.ref(`users/${PASSENGER_AUTH_UID}/appVersion`).set('1.2.3'));
    await assertSucceeds(db.ref(`logs/${PASSENGER_AUTH_UID}/session_1/log_2`).set({ level: 'INFO', message: 'normal append' }));
    await assertSucceeds(db.ref(`chats/${TOUR_ID}/messages/reaction-target/reactions/wave/${PASSENGER_STABLE_ID}`).set(true));
    await assertSucceeds(db.ref(`chats/${TOUR_ID}/messages/reaction-target/reactions/wave/${PASSENGER_STABLE_ID}`).remove());
    await assertSucceeds(db.ref(`chats/${TOUR_ID}/messages/passenger-owned`).update({
      text: '',
      deleted: true,
      deletedAt: '2026-08-29T08:01:00.000Z',
      deletedBy: PASSENGER_STABLE_ID,
    }));
    await assertSucceeds(db.ref(`group_tour_photos/${TOUR_ID}/photo-1/caption`).set('after'));
    await assertSucceeds(db.ref(`notification_read_state/${TOUR_ID}/${PASSENGER_STABLE_ID}/notice-1`).set(Date.now() - 1));
    await assertSucceeds(db.ref(`notification_read_state/${TOUR_ID}/${PASSENGER_STABLE_ID}/notice-1`).remove());
    await assertSucceeds(db.ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`).remove());

    // Logout remains server-owned through app_sessions; rollout never creates a client exception.
    await assertFails(db.ref(`app_sessions/${PASSENGER_AUTH_UID}`).remove());
  }
});
