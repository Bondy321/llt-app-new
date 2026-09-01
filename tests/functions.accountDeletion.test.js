'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildDriverSessionRecord,
  buildPassengerSessionRecord,
} = require('../functions/lib/appSession');
const {
  deriveAccountDeletionId,
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
} = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const {
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
} = require('../functions/src/domains/account-deletion/accountDeletionCoordination');
const {
  reserveAccountDeletion,
} = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const {
  releaseOwnedDriverAuthority,
  releaseOwnedPassengerAuthority,
} = require('../functions/src/domains/account-deletion/accountDeletionWorker');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const parts = (path = '') => String(path).split('/').filter(Boolean);

const readPath = (root, path = '') => {
  let value = root;
  for (const part of parts(path)) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) {
      return undefined;
    }
    value = value[part];
  }
  return value;
};

const writePath = (root, path, value) => {
  const keys = parts(path);
  if (!keys.length) throw new Error('Root replacement is not supported by the test harness');
  let target = root;
  keys.slice(0, -1).forEach((key) => {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  });
  const leaf = keys.at(-1);
  if (value === null || value === undefined) delete target[leaf];
  else target[leaf] = clone(value);
};

const makeSnapshot = (value) => ({
  exists: () => value !== undefined && value !== null,
  val: () => clone(value === undefined ? null : value),
});

const createMemoryDb = (initial = {}, options = {}) => {
  const state = {};
  Object.entries(initial).forEach(([path, value]) => writePath(state, path, value));
  const controls = {
    failRootUpdates: Number(options.failRootUpdates || 0),
    beforeRootUpdate: options.beforeRootUpdate || null,
    beforeTransaction: options.beforeTransaction || null,
  };

  const createRef = (path = '', query = {}) => {
    const normalized = parts(path).join('/');
    const readQuery = () => {
      const raw = readPath(state, normalized);
      if (!query.orderByKey && !query.orderByChild) return raw;
      let entries = Object.entries(raw && typeof raw === 'object' ? raw : {});
      if (query.orderByKey) entries.sort(([left], [right]) => left.localeCompare(right));
      if (query.orderByChild) {
        entries.sort(([, left], [, right]) => Number(left?.[query.orderByChild] || 0)
          - Number(right?.[query.orderByChild] || 0));
      }
      if (query.startAt !== undefined) {
        entries = entries.filter(([key, value]) => query.orderByKey
          ? key >= query.startAt : Number(value?.[query.orderByChild]) >= Number(query.startAt));
      }
      if (query.endAt !== undefined) {
        entries = entries.filter(([key, value]) => query.orderByKey
          ? key <= query.endAt : Number(value?.[query.orderByChild]) <= Number(query.endAt));
      }
      if (query.equalTo !== undefined) {
        entries = entries.filter(([, value]) => value?.[query.orderByChild] === query.equalTo);
      }
      if (query.limitToFirst !== undefined) entries = entries.slice(0, query.limitToFirst);
      return Object.fromEntries(entries);
    };
    const ref = {
      key: parts(normalized).at(-1) || null,
      child(childPath) { return createRef([normalized, childPath].filter(Boolean).join('/')); },
      async get() { return makeSnapshot(readQuery()); },
      async once() { return makeSnapshot(readQuery()); },
      orderByKey() { return createRef(normalized, { ...query, orderByKey: true }); },
      orderByChild(child) { return createRef(normalized, { ...query, orderByChild: child }); },
      startAt(value) { return createRef(normalized, { ...query, startAt: value }); },
      endAt(value) { return createRef(normalized, { ...query, endAt: value }); },
      equalTo(value) { return createRef(normalized, { ...query, equalTo: value }); },
      limitToFirst(value) { return createRef(normalized, { ...query, limitToFirst: value }); },
      async set(value) { writePath(state, normalized, value); },
      async update(updates) {
        if (!normalized && controls.failRootUpdates > 0) {
          controls.failRootUpdates -= 1;
          throw new Error('injected atomic root update failure');
        }
        if (!normalized && controls.beforeRootUpdate) await controls.beforeRootUpdate({ state, updates });
        const next = clone(state);
        Object.entries(updates).forEach(([relativePath, value]) => {
          writePath(next, [normalized, relativePath].filter(Boolean).join('/'), value);
        });
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, next);
      },
      async transaction(updater) {
        if (controls.beforeTransaction) await controls.beforeTransaction({ path: normalized, state });
        const current = clone(readPath(state, normalized) ?? null);
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: makeSnapshot(current) };
        writePath(state, normalized, next);
        return { committed: true, snapshot: makeSnapshot(next) };
      },
    };
    return ref;
  };

  return {
    controls,
    ref: createRef,
    read: (path) => clone(readPath(state, path)),
    write: (path, value) => writePath(state, path, value),
    state,
  };
};

const NOW = 1_800_000_000_000;
const AUTH_UID = 'uid-account-delete';
const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;
const PASSENGER_ID = `pax_v2_${'b'.repeat(32)}`;
const BOOKING_REF = 'BOOK_DELETE';
const RECEIPT = `delrec_v1_${'c'.repeat(64)}`;

const passengerFixture = (overrides = {}) => {
  const session = buildPassengerSessionRecord({
    authUid: AUTH_UID,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_DELETE',
    sessionId: SESSION_ID,
    nowMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
  });
  const profile = {
    principalType: 'passenger',
    bookingRef: BOOKING_REF,
    stablePassengerId: PASSENGER_ID,
    stablePassengerKey: PASSENGER_ID,
    privatePhotoOwnerKey: PASSENGER_ID,
    pushToken: 'private-token',
  };
  return {
    'app_sessions/uid-account-delete': session,
    'users/uid-account-delete': profile,
    'notification_devices/uid-account-delete': {
      registrationRevision: 7,
      pushToken: 'ExponentPushToken[private]',
      tokenHash: 'private-hash',
      operationalEligible: true,
      operationalSessionId: SESSION_ID,
    },
    'notification_consents/uid-account-delete': { registrationRevision: 7, marketingEligible: true },
    'notification_marketing_audience/v1/day_trips/uid-account-delete': {
      schemaVersion: 1,
      registrationRevision: 7,
    },
    'notification_marketing_audience/v1/theatre_concerts/uid-account-delete': {
      schemaVersion: 1,
      registrationRevision: 7,
    },
    'passenger_identity_security/BOOK_DELETE': {
      authorizedAuthUid: AUTH_UID,
      passengerPrincipalId: PASSENGER_ID,
      immutableMetadata: 'preserve',
    },
    [`identity_bindings/${PASSENGER_ID}/${AUTH_UID}`]: true,
    'tours/TOUR_DELETE/participants/uid-account-delete': { sessionId: SESSION_ID },
    'tour_access_grants/TOUR_DELETE/uid-account-delete': { sessionId: SESSION_ID },
    'booking_access_grants/BOOK_DELETE/uid-account-delete': { sessionId: SESSION_ID },
    'bookings/BOOK_DELETE': { customerName: 'Must remain', tourId: 'TOUR_DELETE' },
    'tour_manifests/TOUR_DELETE/passengers/BOOK_DELETE': { name: 'Must remain' },
    ...overrides,
  };
};

test('reservation derives private passenger scope and atomically installs the durable barrier', async () => {
  const db = createMemoryDb(passengerFixture());
  const deletionId = deriveAccountDeletionId(RECEIPT);
  const result = await reserveAccountDeletion({
    db,
    authUid: AUTH_UID,
    deletionId,
    input: {
      expectedSessionId: SESSION_ID,
      deletionReceipt: RECEIPT,
      bookingRef: 'ATTACKER_SCOPE',
      tourId: 'ATTACKER_TOUR',
      driverId: 'ATTACKER_DRIVER',
    },
    nowMs: NOW,
  });

  assert.equal(result.status, 202);
  assert.equal(result.replay, false);
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}`).deletionId, deletionId);
  assert.equal(db.read(
    `account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey('BOOK_DELETE')}/deletionId`,
  ), deletionId);
  assert.equal(db.read(
    `account_deletion_uid_tombstones/v1/${deriveUidAccountDeletionTombstoneKey(AUTH_UID)}/permanent`,
  ), true);
  assert.equal(db.read(`account_deletion_queue/v1/${deletionId}`).deletionId, deletionId);
  assert.equal(db.read('app_sessions/uid-account-delete'), undefined);
  assert.equal(db.read('tours/TOUR_DELETE/participants/uid-account-delete'), undefined);
  assert.equal(db.read('tour_access_grants/TOUR_DELETE/uid-account-delete'), undefined);
  assert.equal(db.read('booking_access_grants/BOOK_DELETE/uid-account-delete'), undefined);
  assert.deepEqual(db.read('bookings/BOOK_DELETE'), { customerName: 'Must remain', tourId: 'TOUR_DELETE' });
  assert.equal(db.read(`account_deletion_jobs/v1/${deletionId}/privateScope/bookingRef`), 'BOOK_DELETE');
  assert.equal(JSON.stringify(db.read(`account_deletion_jobs/v1/${deletionId}`)).includes('ATTACKER_'), false);
  assert.equal(JSON.stringify(db.read(`account_deletion_jobs/v1/${deletionId}`)).includes(RECEIPT), false);
});

test('accepted reservation creates a monotonic permanent notification tombstone in the same atomic update', async () => {
  const db = createMemoryDb(passengerFixture({
    'notification_device_tombstones/uid-account-delete': {
      permanent: true,
      registrationRevision: 11,
      deletedAtMs: NOW - 10_000,
    },
  }));
  await reserveAccountDeletion({
    db,
    authUid: AUTH_UID,
    deletionId: deriveAccountDeletionId(RECEIPT),
    input: { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT },
    nowMs: NOW,
  });

  const tombstone = db.read('notification_device_tombstones/uid-account-delete');
  assert.equal(tombstone.permanent, true);
  assert.ok(tombstone.registrationRevision > 11);
  assert.equal(db.read('notification_devices/uid-account-delete'), undefined);
  assert.equal(db.read('notification_consents/uid-account-delete'), undefined);
  assert.equal(db.read('notification_marketing_audience/v1/day_trips/uid-account-delete'), undefined);
  assert.equal(db.read('notification_marketing_audience/v1/theatre_concerts/uid-account-delete'), undefined);
});

test('atomic reservation failure leaves session, authority, delivery, and workflow roots unchanged', async () => {
  const initial = passengerFixture();
  const db = createMemoryDb(initial, { failRootUpdates: 1 });
  await assert.rejects(() => reserveAccountDeletion({
    db,
    authUid: AUTH_UID,
    deletionId: deriveAccountDeletionId(RECEIPT),
    input: { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT },
    nowMs: NOW,
  }), /atomic root update failure/);

  assert.equal(db.read('app_sessions/uid-account-delete').sessionId, SESSION_ID);
  assert.equal(db.read('notification_devices/uid-account-delete').pushToken, 'ExponentPushToken[private]');
  assert.equal(db.read('notification_consents/uid-account-delete').registrationRevision, 7);
  assert.equal(db.read('notification_marketing_audience/v1/day_trips/uid-account-delete').registrationRevision, 7);
  assert.equal(db.read('notification_marketing_audience/v1/theatre_concerts/uid-account-delete').registrationRevision, 7);
  assert.equal(db.read('tours/TOUR_DELETE/participants/uid-account-delete').sessionId, SESSION_ID);
  assert.equal(db.read('passenger_identity_security/BOOK_DELETE/authorizedAuthUid'), AUTH_UID);
  assert.equal(db.read('account_deletion_jobs/v1'), undefined);
  assert.equal(db.read('account_deletion_queue/v1'), undefined);
  assert.equal(db.read('account_deletion_active/v1'), undefined);
  assert.equal(db.read('account_deletion_passenger_active/v1'), undefined);
  assert.equal(db.read('account_deletion_uid_tombstones/v1'), undefined);
  assert.equal(db.read(`account_deletion_locks/v1/${deriveAccountDeletionId(RECEIPT)}`), undefined);
  assert.equal(db.read(`app_session_locks/${AUTH_UID}`), undefined);
  assert.equal(db.read(`notification_device_locks/${AUTH_UID}`), undefined);
});

test('session mismatch fails before creating deletion state', async () => {
  const db = createMemoryDb(passengerFixture());
  const result = await reserveAccountDeletion({
    db,
    authUid: AUTH_UID,
    deletionId: deriveAccountDeletionId(RECEIPT),
    input: { expectedSessionId: `sess_v1_${'d'.repeat(32)}`, deletionReceipt: RECEIPT },
    nowMs: NOW,
  });
  assert.deepEqual(result, { status: 409, reason: 'SESSION_CHANGED' });
  assert.equal(db.read('account_deletion_jobs/v1'), undefined);
  assert.equal(db.read('app_sessions/uid-account-delete').sessionId, SESSION_ID);
});

test('reservation fails closed instead of overwriting malformed active barriers', async () => {
  for (const malformed of [false, 0]) {
    const db = createMemoryDb(passengerFixture({
      [`account_deletion_active/v1/${AUTH_UID}`]: malformed,
    }));
    const result = await reserveAccountDeletion({
      db,
      authUid: AUTH_UID,
      deletionId: deriveAccountDeletionId(RECEIPT),
      input: { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT },
      nowMs: NOW,
    });
    assert.deepEqual(result, { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
    assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}`), malformed);
    assert.equal(db.read(`app_sessions/${AUTH_UID}`).sessionId, SESSION_ID);
    assert.equal(db.read('account_deletion_jobs/v1'), undefined);
  }
});

test('lost accepted response replays the same receipt without requiring the removed app session', async () => {
  const db = createMemoryDb(passengerFixture());
  const deletionId = deriveAccountDeletionId(RECEIPT);
  const input = { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT };
  const accepted = await reserveAccountDeletion({ db, authUid: AUTH_UID, deletionId, input, nowMs: NOW });
  assert.equal(accepted.status, 202);
  assert.equal(db.read(`app_sessions/${AUTH_UID}`), undefined);

  const replay = await reserveAccountDeletion({ db, authUid: AUTH_UID, deletionId, input, nowMs: NOW + 1 });
  assert.equal(replay.status, 202);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.job, accepted.job);
  assert.equal(Object.keys(db.read('account_deletion_jobs/v1')).length, 1);
});

test('completed receipt replay is UID-independent for fresh anonymous recovery, while a new receipt still needs a session', async () => {
  const db = createMemoryDb(passengerFixture());
  const deletionId = deriveAccountDeletionId(RECEIPT);
  const input = { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT };
  const accepted = await reserveAccountDeletion({ db, authUid: AUTH_UID, deletionId, input, nowMs: NOW });
  const completed = {
    schemaVersion: 1,
    deletionId,
    status: 'completed',
    phase: 'completed',
    createdAtMs: accepted.job.createdAtMs,
    updatedAtMs: NOW + 10,
    completedAtMs: NOW + 10,
    retainUntilMs: NOW + 100_000,
    summary: accepted.job.summary,
  };
  db.write(`account_deletion_jobs/v1/${deletionId}`, completed);
  db.write(`account_deletion_active/v1/${AUTH_UID}`, null);
  db.write(`account_deletion_queue/v1/${deletionId}`, null);

  const anonymousReplay = await reserveAccountDeletion({
    db,
    authUid: 'fresh-anonymous-uid',
    deletionId,
    input,
    nowMs: NOW + 11,
  });
  assert.equal(anonymousReplay.status, 202);
  assert.equal(anonymousReplay.replay, true);
  assert.deepEqual(anonymousReplay.job, completed);

  const newReceipt = `delrec_v1_${'f'.repeat(64)}`;
  const newRequest = await reserveAccountDeletion({
    db,
    authUid: AUTH_UID,
    deletionId: deriveAccountDeletionId(newReceipt),
    input: { expectedSessionId: SESSION_ID, deletionReceipt: newReceipt },
    nowMs: NOW + 12,
  });
  assert.deepEqual(newRequest, { status: 422, reason: 'ACCOUNT_DELETION_SCOPE_INCOMPLETE' });
});

test('passenger authority release is compare-safe and preserves metadata and successors', async () => {
  const db = createMemoryDb(passengerFixture());
  const scope = {
    authUid: AUTH_UID,
    bookingRef: 'BOOK_DELETE',
    stablePassengerKey: PASSENGER_ID,
  };
  assert.equal(await releaseOwnedPassengerAuthority({ db, scope }), 2);
  assert.equal(db.read('passenger_identity_security/BOOK_DELETE/authorizedAuthUid'), undefined);
  assert.equal(db.read('passenger_identity_security/BOOK_DELETE/immutableMetadata'), 'preserve');
  assert.equal(db.read(`identity_bindings/${PASSENGER_ID}/${AUTH_UID}`), undefined);

  db.write('passenger_identity_security/BOOK_DELETE/authorizedAuthUid', 'successor-uid');
  db.write(`identity_bindings/${PASSENGER_ID}/${AUTH_UID}`, { successor: true });
  assert.equal(await releaseOwnedPassengerAuthority({ db, scope }), 0);
  assert.equal(db.read('passenger_identity_security/BOOK_DELETE/authorizedAuthUid'), 'successor-uid');
  assert.deepEqual(db.read(`identity_bindings/${PASSENGER_ID}/${AUTH_UID}`), { successor: true });
});

test('driver authority release preserves successor and policy-off secondary ownership', async () => {
  const assignedSession = buildDriverSessionRecord({
    authUid: 'driver-secondary',
    driverId: 'DRIVER_1',
    tourId: null,
    sessionId: `sess_v1_${'e'.repeat(32)}`,
    nowMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
  });
  const db = createMemoryDb({
    'app_sessions/driver-secondary': assignedSession,
    'drivers/DRIVER_1': { authUid: 'driver-primary', currentTourId: null, assignment: 'preserve' },
    'driver_login_policy/v1': { enforceSingleDevice: false, generation: 4 },
  });
  const scope = { authUid: 'driver-secondary', driverId: 'DRIVER_1' };

  assert.equal(await releaseOwnedDriverAuthority({ db, scope }), 0);
  assert.equal(db.read('drivers/DRIVER_1/authUid'), 'driver-primary');
  assert.equal(db.read('drivers/DRIVER_1/assignment'), 'preserve');

  db.write('drivers/DRIVER_1/authUid', 'driver-secondary');
  assert.equal(await releaseOwnedDriverAuthority({ db, scope }), 1);
  db.write('drivers/DRIVER_1/authUid', 'driver-successor');
  assert.equal(await releaseOwnedDriverAuthority({ db, scope }), 0);
  assert.equal(db.read('drivers/DRIVER_1/authUid'), 'driver-successor');
  assert.equal(db.read('drivers/DRIVER_1/currentTourId'), null);
});

test('malformed false and zero active barriers fail closed and block admission', async () => {
  for (const malformed of [false, 0]) {
    const db = createMemoryDb({ [`account_deletion_active/v1/${AUTH_UID}`]: malformed });
    await assert.rejects(() => ensureNoActiveAccountDeletion({ db, authUid: AUTH_UID }),
      (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS');
    const passengerDb = createMemoryDb({
      [`account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(BOOKING_REF)}`]: malformed,
    });
    await assert.rejects(
      () => ensureNoActivePassengerAccountDeletion({ db: passengerDb, bookingRef: BOOKING_REF }),
      (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS',
    );
  }
  const clearDb = createMemoryDb();
  assert.equal(await ensureNoActiveAccountDeletion({ db: clearDb, authUid: AUTH_UID }), true);
});
