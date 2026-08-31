'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPassengerSessionRecord } = require('../functions/lib/appSession');
const {
  ACCOUNT_DELETION_LEASE_MS,
} = require('../functions/src/domains/account-deletion/accountDeletionConstants');
const {
  deriveAccountDeletionId,
  derivePassengerAccountDeletionKey,
} = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const {
  acquireAccountDeletionJobLease,
  claimAccountDeletionQueueEntry,
} = require('../functions/src/domains/account-deletion/accountDeletionCoordination');
const {
  buildInitialAccountDeletionJob,
  reserveAccountDeletion,
} = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const { buildNotificationJobId } = require('../functions/src/domains/notifications/notificationJobs');
const {
  commitLeasedJobProgress,
  deleteGroupMediaPage,
  deletePrivateMediaPage,
  finalizeCompletedAccountDeletion,
  scrubAccountDeletionMessage,
  scrubChatPage,
} = require('../functions/src/domains/account-deletion/accountDeletionWorker');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const pathParts = (path = '') => String(path).split('/').filter(Boolean);
const get = (root, path = '') => pathParts(path).reduce((value, key) => (
  value && typeof value === 'object' ? value[key] : undefined
), root);
const put = (root, path, value) => {
  const keys = pathParts(path);
  let target = root;
  keys.slice(0, -1).forEach((key) => {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  });
  if (value === null || value === undefined) delete target[keys.at(-1)];
  else target[keys.at(-1)] = clone(value);
};
const snapshot = (value) => ({
  exists: () => value !== undefined && value !== null,
  val: () => clone(value === undefined ? null : value),
});

const createConcurrencyDb = (initial = {}, options = {}) => {
  const state = {};
  Object.entries(initial).forEach(([path, value]) => put(state, path, value));
  const controls = {
    failRootUpdates: Number(options.failRootUpdates || 0),
    failTransactions: new Map(Object.entries(options.failTransactions || {})),
    beforeTransaction: options.beforeTransaction || null,
  };
  const refFor = (path = '', query = {}) => {
    const normalized = pathParts(path).join('/');
    const queryValue = () => {
      const raw = get(state, normalized);
      if (!query.key && !query.child) return raw;
      let entries = Object.entries(raw && typeof raw === 'object' ? raw : {});
      if (query.key) entries.sort(([left], [right]) => left.localeCompare(right));
      if (query.child) entries.sort(([, left], [, right]) => (
        Number(left?.[query.child] || 0) - Number(right?.[query.child] || 0)
      ));
      if (query.start !== undefined) entries = entries.filter(([key, value]) => (
        query.key ? key >= query.start : Number(value?.[query.child]) >= Number(query.start)
      ));
      if (query.end !== undefined) entries = entries.filter(([key, value]) => (
        query.key ? key <= query.end : Number(value?.[query.child]) <= Number(query.end)
      ));
      if (query.limit !== undefined) entries = entries.slice(0, query.limit);
      return Object.fromEntries(entries);
    };
    const ref = {
      child(childPath) { return refFor(`${normalized}/${childPath}`); },
      async once() { return snapshot(queryValue()); },
      async get() { return snapshot(queryValue()); },
      orderByKey() { return refFor(normalized, { ...query, key: true }); },
      orderByChild(child) { return refFor(normalized, { ...query, child }); },
      startAt(value) { return refFor(normalized, { ...query, start: value }); },
      endAt(value) { return refFor(normalized, { ...query, end: value }); },
      limitToFirst(value) { return refFor(normalized, { ...query, limit: value }); },
      async update(updates) {
        if (!normalized && controls.failRootUpdates > 0) {
          controls.failRootUpdates -= 1;
          throw new Error('injected root update failure');
        }
        const nextState = clone(state);
        Object.entries(updates).forEach(([relative, value]) => {
          put(nextState, [normalized, relative].filter(Boolean).join('/'), value);
        });
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, nextState);
      },
      async transaction(updater) {
        const remaining = Number(controls.failTransactions.get(normalized) || 0);
        if (remaining > 0) {
          controls.failTransactions.set(normalized, remaining - 1);
          throw new Error(`injected transaction failure: ${normalized}`);
        }
        if (controls.beforeTransaction) await controls.beforeTransaction({ path: normalized, state });
        const current = clone(get(state, normalized) ?? null);
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: snapshot(current) };
        put(state, normalized, next);
        return { committed: true, snapshot: snapshot(next) };
      },
    };
    return ref;
  };
  return {
    controls,
    ref: refFor,
    read: (path) => clone(get(state, path)),
    write: (path, value) => put(state, path, value),
  };
};

const NOW = 1_800_100_000_000;
const AUTH_UID = 'uid-concurrent-delete';
const SESSION_ID = `sess_v1_${'1'.repeat(32)}`;
const PASSENGER_ID = `pax_v2_${'2'.repeat(32)}`;
const RECEIPT_A = `delrec_v1_${'3'.repeat(64)}`;
const RECEIPT_B = `delrec_v1_${'4'.repeat(64)}`;

const reservationFixture = () => ({
  [`app_sessions/${AUTH_UID}`]: buildPassengerSessionRecord({
    authUid: AUTH_UID,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_CONCURRENT',
    sessionId: SESSION_ID,
    nowMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
  }),
  [`users/${AUTH_UID}`]: {
    principalType: 'passenger',
    bookingRef: 'BOOK_CONCURRENT',
    stablePassengerId: PASSENGER_ID,
    stablePassengerKey: PASSENGER_ID,
    privatePhotoOwnerKey: PASSENGER_ID,
  },
  [`passenger_identity_security/BOOK_CONCURRENT`]: {
    authorizedAuthUid: AUTH_UID,
    passengerPrincipalId: PASSENGER_ID,
  },
  [`identity_bindings/${PASSENGER_ID}/${AUTH_UID}`]: true,
});

const reserve = (db, receipt) => reserveAccountDeletion({
  db,
  authUid: AUTH_UID,
  deletionId: deriveAccountDeletionId(receipt),
  input: { expectedSessionId: SESSION_ID, deletionReceipt: receipt },
  nowMs: NOW,
});

test('concurrent requests with the same receipt converge on the same accepted job', async () => {
  const db = createConcurrencyDb(reservationFixture());
  const [left, right] = await Promise.all([reserve(db, RECEIPT_A), reserve(db, RECEIPT_A)]);
  assert.deepEqual([left.status, right.status].sort(), [202, 202]);
  assert.equal(left.job.deletionId, right.job.deletionId);
  assert.equal(Object.keys(db.read('account_deletion_jobs/v1')).length, 1);
  assert.equal(Object.keys(db.read('account_deletion_queue/v1')).length, 1);
});

test('concurrent requests with different receipts create one job and return one generic in-progress result', async () => {
  const db = createConcurrencyDb(reservationFixture());
  const results = await Promise.all([reserve(db, RECEIPT_A), reserve(db, RECEIPT_B)]);
  const accepted = results.filter((result) => result.status === 202);
  const rejected = results.filter((result) => result.status !== 202);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], { status: 409, reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
  assert.equal(Object.keys(db.read('account_deletion_jobs/v1')).length, 1);
});

test('a login-held app-session lock prevents reservation without changing the active session', async () => {
  const db = createConcurrencyDb({
    ...reservationFixture(),
    [`app_session_locks/${AUTH_UID}`]: {
      owner: 'login-worker', operation: 'issue', createdAtMs: NOW, expiresAtMs: NOW + 60_000,
    },
  });
  const result = await reserve(db, RECEIPT_A);
  assert.deepEqual(result, { status: 409, reason: 'SESSION_IN_PROGRESS' });
  assert.equal(db.read(`app_sessions/${AUTH_UID}`).sessionId, SESSION_ID);
  assert.equal(db.read('account_deletion_jobs/v1'), undefined);
});

test('queue and job leases exclude contenders, allow expiry takeover, and fence a late worker', async () => {
  const deletionId = deriveAccountDeletionId(RECEIPT_A);
  const privateScope = {
    authUid: AUTH_UID,
    expectedSessionId: SESSION_ID,
    principalType: 'passenger',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_CONCURRENT',
    actorKeys: [AUTH_UID, PASSENGER_ID],
  };
  const job = buildInitialAccountDeletionJob({ deletionId, privateScope, nowMs: NOW });
  const db = createConcurrencyDb({
    [`account_deletion_jobs/v1/${deletionId}`]: job,
    [`account_deletion_queue/v1/${deletionId}`]: { deletionId, dueAtMs: NOW, lease: null },
  });

  assert.equal((await claimAccountDeletionQueueEntry({ db, deletionId, ownerId: 'old', nowMs: NOW })).claimed, true);
  assert.equal((await claimAccountDeletionQueueEntry({ db, deletionId, ownerId: 'new', nowMs: NOW + 1 })).claimed, false);
  assert.equal((await claimAccountDeletionQueueEntry({
    db, deletionId, ownerId: 'new', nowMs: NOW + ACCOUNT_DELETION_LEASE_MS + 1,
  })).claimed, true);

  const oldLease = await acquireAccountDeletionJobLease({ db, deletionId, ownerId: 'old', nowMs: NOW });
  assert.equal(oldLease.acquired, true);
  assert.equal((await acquireAccountDeletionJobLease({ db, deletionId, ownerId: 'new', nowMs: NOW + 1 })).acquired, false);
  const newLease = await acquireAccountDeletionJobLease({
    db, deletionId, ownerId: 'new', nowMs: NOW + ACCOUNT_DELETION_LEASE_MS + 1,
  });
  assert.equal(newLease.acquired, true);
  assert.ok(newLease.revision > oldLease.revision);

  const lateCommit = await commitLeasedJobProgress({
    ref: oldLease.ref,
    lease: { ownerId: 'old', revision: oldLease.revision, phase: 'reserved' },
    expectedPhase: 'reserved',
    next: 'live_state_cleanup',
    nowMs: NOW + ACCOUNT_DELETION_LEASE_MS + 2,
  });
  assert.equal(lateCommit, false);
  assert.equal(db.read(`account_deletion_jobs/v1/${deletionId}/phase`), 'reserved');
  assert.equal(db.read(`account_deletion_jobs/v1/${deletionId}/lease/ownerId`), 'new');
});

test('fresh clock expiry fences a stale worker before effects and before progress commit', async () => {
  const path = 'account_deletion_jobs/v1/clock-expired';
  const db = createConcurrencyDb({
    [path]: {
      status: 'pending',
      phase: 'group_media',
      leaseRevision: 7,
      lease: {
        ownerId: 'clock-worker', revision: 7, phase: 'group_media', expiresAtMs: NOW + 100,
      },
      cursors: { groupMediaAfterPhotoId: 'before' },
      summary: { recordsRemoved: 0, storageObjectsRemoved: 0, chatMessagesScrubbed: 0, reactionsRemoved: 0 },
    },
    'group_tour_photos/TOUR_CONCURRENT/clock-photo': {
      userId: PASSENGER_ID,
      storagePath: 'group_tour_photos/TOUR_CONCURRENT/clock-photo.jpg',
    },
  });
  const bucket = createBucket();
  const lease = {
    ownerId: 'clock-worker',
    revision: 7,
    phase: 'group_media',
    clock: () => NOW + 101,
  };
  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease: { ref: db.ref(path), lease, nowMs: NOW },
  }), (error) => error.code === 'ACCOUNT_DELETION_LEASE_LOST');
  assert.deepEqual(bucket.deletes, []);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/clock-photo/userId'), PASSENGER_ID);

  assert.equal(await commitLeasedJobProgress({
    ref: db.ref(path),
    lease,
    expectedPhase: 'group_media',
    next: 'private_media',
    cursorUpdates: { groupMediaAfterPhotoId: 'after' },
    nowMs: NOW,
  }), false);
  assert.equal(db.read(`${path}/phase`), 'group_media');
  assert.equal(db.read(`${path}/cursors/groupMediaAfterPhotoId`), 'before');
});

test('every pre-Auth phase retains phase, cursor, and counters on commit failure and replays once', async () => {
  const phases = [
    'reserved',
    'live_state_cleanup',
    'authority_release',
    'group_media',
    'private_media',
    'chat_scrub',
    'account_records',
  ];
  for (const [index, phase] of phases.entries()) {
    const deletionId = `acctdel_v1_${String(index + 5).repeat(64)}`;
    const path = `account_deletion_jobs/v1/${deletionId}`;
    const ownerId = `phase-worker-${index}`;
    const revision = index + 1;
    const db = createConcurrencyDb({
      [path]: {
        status: 'pending',
        phase,
        leaseRevision: revision,
        lease: { ownerId, revision, phase, expiresAtMs: NOW + 60_000 },
        cursors: { marker: 'before' },
        summary: {
          recordsRemoved: 3,
          storageObjectsRemoved: 2,
          chatMessagesScrubbed: 1,
          reactionsRemoved: 4,
        },
      },
    }, { failTransactions: { [path]: 1 } });
    const lease = { ref: db.ref(path), ownerId, revision, phase };
    await assert.rejects(() => commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: phase,
      next: index === phases.length - 1 ? 'auth_delete' : phases[index + 1],
      cursorUpdates: { marker: 'after' },
      summaryDelta: { recordsRemoved: 1 },
      nowMs: NOW,
    }), /injected transaction failure/);
    assert.equal(db.read(`${path}/phase`), phase);
    assert.equal(db.read(`${path}/cursors/marker`), 'before');
    assert.equal(db.read(`${path}/summary/recordsRemoved`), 3);

    assert.equal(await commitLeasedJobProgress({
      ref: lease.ref,
      lease,
      expectedPhase: phase,
      next: index === phases.length - 1 ? 'auth_delete' : phases[index + 1],
      cursorUpdates: { marker: 'after' },
      summaryDelta: { recordsRemoved: 1 },
      nowMs: NOW + 1,
    }), true);
    assert.equal(db.read(`${path}/cursors/marker`), 'after');
    assert.equal(db.read(`${path}/summary/recordsRemoved`), 4);
  }
});

const createBucket = ({ failures = {}, missing = [], onDelete = null } = {}) => {
  const deletes = [];
  const generations = new Map();
  return {
    deletes,
    file(path) {
      return {
        async getMetadata() {
          if (missing.includes(path)) {
            const error = new Error('missing');
            error.code = 404;
            throw error;
          }
          if (!generations.has(path)) generations.set(path, `generation:${path}`);
          return [{ generation: generations.get(path) }];
        },
        async delete(options = {}) {
          deletes.push({ path, options });
          if (onDelete) await onDelete(path);
          if (failures[path]) throw failures[path];
          if (options.ifGenerationMatch && options.ifGenerationMatch !== generations.get(path)) {
            const error = new Error('generation precondition failed');
            error.code = 412;
            throw error;
          }
        },
      };
    },
  };
};

const installLease = (db, suffix, phase) => {
  const ownerId = `worker-${suffix}`;
  const revision = 1;
  const path = `account_deletion_jobs/v1/media-${suffix}`;
  db.write(path, {
    status: 'pending',
    phase,
    leaseRevision: revision,
    lease: { ownerId, revision, phase, expiresAtMs: NOW + 60_000 },
  });
  return { ref: db.ref(path), ownerId, revision, phase };
};

test('group media removes only trusted owned paths, treats 404 as success, and preserves foreign records', async () => {
  const ownedPath = 'group_tour_photos/TOUR_CONCURRENT/owned.jpg';
  const missingPath = 'group_tour_photos/TOUR_CONCURRENT/viewers/owned.jpg';
  const db = createConcurrencyDb({
    'group_tour_photos/TOUR_CONCURRENT/a-owned': {
      userId: PASSENGER_ID,
      storagePath: ownedPath,
      viewerStoragePath: missingPath,
    },
    'group_tour_photos/TOUR_CONCURRENT/b-foreign': {
      userId: 'foreign-user',
      storagePath: 'group_tour_photos/TOUR_CONCURRENT/foreign.jpg',
    },
  });
  const bucket = createBucket({ missing: [missingPath] });
  const lease = installLease(db, 'group-success', 'group_media');
  const result = await deleteGroupMediaPage({
    db,
    bucket,
    scope: {
      principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [AUTH_UID, PASSENGER_ID],
    },
    cursor: null,
    lease,
  });
  assert.equal(result.recordsRemoved, 1);
  assert.equal(result.storageObjectsRemoved, 2);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/a-owned'), undefined);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/b-foreign/userId'), 'foreign-user');
  assert.deepEqual(bucket.deletes.map(({ path }) => path), [ownedPath]);
});

test('storage failure leaves metadata and cursor-owning work retryable', async () => {
  const storagePath = 'group_tour_photos/TOUR_CONCURRENT/fail.jpg';
  const db = createConcurrencyDb({
    'group_tour_photos/TOUR_CONCURRENT/photo-fail': { userId: PASSENGER_ID, storagePath },
  });
  const bucket = createBucket({ failures: { [storagePath]: new Error('storage unavailable') } });
  const lease = installLease(db, 'group-failure', 'group_media');
  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  }), /storage unavailable/);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-fail/userId'), PASSENGER_ID);
});

test('owned metadata with a foreign or traversal Storage path fails closed without deleting metadata', async () => {
  const db = createConcurrencyDb({
    'group_tour_photos/TOUR_CONCURRENT/photo-invalid-path': {
      userId: PASSENGER_ID,
      storagePath: 'group_tour_photos/OTHER_TOUR/private.jpg',
      viewerStoragePath: 'group_tour_photos/TOUR_CONCURRENT/../escape.jpg',
    },
  });
  const bucket = createBucket();
  const lease = installLease(db, 'group-invalid-path', 'group_media');
  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  }), (error) => error.code === 'MEDIA_PATH_INVALID');
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-invalid-path/userId'), PASSENGER_ID);
  assert.deepEqual(bucket.deletes, []);
});

test('media replacement between Storage deletion and metadata compare-delete survives and forces replay', async () => {
  const oldPath = 'group_tour_photos/TOUR_CONCURRENT/old.jpg';
  const db = createConcurrencyDb({
    'group_tour_photos/TOUR_CONCURRENT/photo-race': { userId: PASSENGER_ID, storagePath: oldPath },
  });
  let replaced = false;
  const bucket = createBucket({
    onDelete: () => {
      if (replaced) return;
      replaced = true;
      db.write('group_tour_photos/TOUR_CONCURRENT/photo-race', {
        userId: 'successor-user',
        storagePath: 'group_tour_photos/TOUR_CONCURRENT/successor.jpg',
      });
    },
  });
  const lease = installLease(db, 'group-race', 'group_media');
  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  }), (error) => error.code === 'MEDIA_RECORD_CHANGED');
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-race/userId'), 'successor-user');
  assert.equal(bucket.deletes.some(({ path }) => path.includes('successor')), false);
});

test('same-path successor generation returns 412 and preserves bytes and cursor until safe resolution', async () => {
  const sharedPath = 'group_tour_photos/TOUR_CONCURRENT/shared-generation.jpg';
  const db = createConcurrencyDb({
    'group_tour_photos/TOUR_CONCURRENT/photo-same-path': { userId: PASSENGER_ID, storagePath: sharedPath },
  });
  let objectExists = true;
  let currentGeneration = 'generation-1';
  let concurrentReuploadPending = true;
  const bucket = {
    file(path) {
      assert.equal(path, sharedPath);
      return {
        async getMetadata() {
          if (!objectExists) {
            const error = new Error('missing');
            error.code = 404;
            throw error;
          }
          return [{ generation: currentGeneration }];
        },
        async delete(options) {
          if (concurrentReuploadPending) {
            concurrentReuploadPending = false;
            currentGeneration = 'generation-2';
          }
          if (options.ifGenerationMatch !== currentGeneration) {
            const error = new Error('generation precondition failed');
            error.code = 412;
            throw error;
          }
          objectExists = false;
        },
      };
    },
  };
  const lease = installLease(db, 'group-same-path-race', 'group_media');
  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  }), (error) => error.code === 'MEDIA_OBJECT_CHANGED');
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-same-path/userId'), PASSENGER_ID);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-same-path/_serverDeletion/status'), 'deleting');
  assert.equal(objectExists, true, 'the successor Storage generation must survive');
  assert.equal(db.read('account_deletion_jobs/v1/media-group-same-path-race/cursors'), undefined);

  await assert.rejects(() => deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  }), (error) => error.code === 'MEDIA_OBJECT_CHANGED');
  assert.equal(objectExists, true);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-same-path/userId'), PASSENGER_ID);
  assert.equal(db.read('group_tour_photos/TOUR_CONCURRENT/photo-same-path/_serverDeletion/status'), 'deleting');
  assert.equal(db.read('account_deletion_jobs/v1/media-group-same-path-race/cursors'), undefined);

  db.write('group_tour_photos/TOUR_CONCURRENT/photo-same-path', null);
  const safelyResolved = await deleteGroupMediaPage({
    db,
    bucket,
    scope: { principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [PASSENGER_ID] },
    cursor: null,
    lease,
  });
  assert.equal(safelyResolved.done, true);
  assert.equal(safelyResolved.recordsRemoved, 0);
  assert.equal(objectExists, true, 'successor bytes remain after metadata is safely resolved');
});

test('private media uses the captured owner namespace and idempotently tolerates missing objects', async () => {
  const privatePath = `private_tour_photos/TOUR_CONCURRENT/${PASSENGER_ID}/source.jpg`;
  const db = createConcurrencyDb({
    [`private_tour_photos/TOUR_CONCURRENT/${PASSENGER_ID}/private-1`]: {
      userId: PASSENGER_ID,
      storagePath: privatePath,
    },
  });
  const bucket = createBucket({ missing: [privatePath] });
  const lease = installLease(db, 'private-success', 'private_media');
  const result = await deletePrivateMediaPage({
    db,
    bucket,
    scope: {
      principalType: 'passenger',
      tourId: 'TOUR_CONCURRENT',
      privatePhotoOwnerKey: PASSENGER_ID,
      actorKeys: [PASSENGER_ID],
    },
    cursor: null,
    lease,
  });
  assert.equal(result.recordsRemoved, 1);
  assert.equal(db.read(`private_tour_photos/TOUR_CONCURRENT/${PASSENGER_ID}/private-1`), undefined);
  assert.deepEqual(bucket.deletes, []);
});

test('chat scrub removes passenger content and exact reactions while preserving moderator and driver content', async () => {
  const db = createConcurrencyDb({
    'chats/TOUR_CONCURRENT/messages/passenger': {
      senderId: PASSENGER_ID,
      senderStableId: PASSENGER_ID,
      senderName: 'Private Passenger',
      text: 'private message',
      imageUrl: 'private image',
      caption: 'private caption',
      idempotencyKey: 'passenger',
      replyTo: { messageId: 'older', senderName: 'Other', previewText: 'quoted content' },
      reactions: { heart: { [PASSENGER_ID]: true, other: true } },
    },
    'chats/TOUR_CONCURRENT/messages/moderated': {
      senderId: PASSENGER_ID,
      text: '',
      deleted: true,
      deletedBy: 'moderator',
      deletedAt: '2026-01-01T00:00:00.000Z',
    },
    'chats/TOUR_CONCURRENT/messages/driver': {
      senderId: 'driver:D1',
      text: 'operational instruction',
      reactions: { ok: { [PASSENGER_ID]: true, driver: true } },
    },
  });
  const scope = { principalType: 'passenger', actorKeys: [AUTH_UID, PASSENGER_ID] };
  const passenger = await scrubAccountDeletionMessage({
    ref: db.ref('chats/TOUR_CONCURRENT/messages/passenger'), scope, nowMs: NOW,
  });
  const moderated = await scrubAccountDeletionMessage({
    ref: db.ref('chats/TOUR_CONCURRENT/messages/moderated'), scope, nowMs: NOW,
  });
  const driver = await scrubAccountDeletionMessage({
    ref: db.ref('chats/TOUR_CONCURRENT/messages/driver'), scope, nowMs: NOW,
  });

  assert.deepEqual(passenger, { chatMessagesScrubbed: 1, reactionsRemoved: 1 });
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/deletedBy'), 'account_deleted');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/text'), '');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/senderId'), 'account_deleted');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/senderStableId'), 'account_deleted');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/senderName'), 'Deleted account');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/caption'), undefined);
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/idempotencyKey'), undefined);
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/passenger/replyTo'), undefined);
  assert.deepEqual(db.read('chats/TOUR_CONCURRENT/messages/passenger/reactions/heart'), { other: true });
  assert.equal(moderated.chatMessagesScrubbed, 1);
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/moderated/deletedBy'), 'moderator');
  assert.equal(driver.chatMessagesScrubbed, 0);
  assert.equal(driver.reactionsRemoved, 1);
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/driver/text'), 'operational instruction');
  assert.deepEqual(db.read('chats/TOUR_CONCURRENT/messages/driver/reactions/ok'), { driver: true });
});

test('chat page removes copied reply attribution without deleting the replying message', async () => {
  const notificationJobId = buildNotificationJobId(
    'group_chat_message', 'TOUR_CONCURRENT:a-passenger',
  );
  const db = createConcurrencyDb({
    'chats/TOUR_CONCURRENT/messages/a-passenger': {
      senderId: PASSENGER_ID, senderStableId: PASSENGER_ID, senderName: 'Private Passenger',
      text: 'private quoted content', timestamp: NOW - 100,
    },
    'chats/TOUR_CONCURRENT/messages/b-other-reply': {
      senderId: 'other-passenger', senderStableId: 'other-passenger', senderName: 'Other Passenger',
      text: 'preserve this reply', timestamp: NOW,
      replyTo: {
        messageId: 'a-passenger', senderName: 'Private Passenger',
        previewText: 'private quoted content', idempotencyKey: 'a-passenger',
      },
    },
    [`notification_jobs/${notificationJobId}`]: {
      jobId: notificationJobId,
      sourceType: 'group_chat_message',
      sourceId: 'TOUR_CONCURRENT:a-passenger',
      senderAuthUid: AUTH_UID,
      senderPrincipalId: PASSENGER_ID,
      presentation: { title: 'New message', body: 'Private Passenger: private quoted content' },
      navigation: { screen: 'Chat', messageId: 'a-passenger' },
      status: 'queued',
      createdAtMs: NOW - 100,
      queueKind: 'fanout',
      queueKey: 'private-queue-key',
    },
    'notification_job_fanout_queue/private-queue-key': { targetId: notificationJobId },
  });
  const result = await scrubChatPage({
    db,
    scope: {
      principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [AUTH_UID, PASSENGER_ID],
    },
    cursor: null,
    nowMs: NOW,
    lease: null,
  });

  assert.equal(result.chatMessagesScrubbed, 1);
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/b-other-reply/text'), 'preserve this reply');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/b-other-reply/senderName'), 'Other Passenger');
  assert.equal(db.read('chats/TOUR_CONCURRENT/messages/b-other-reply/replyTo'), undefined);
  const privacyTombstone = db.read(`notification_jobs/${notificationJobId}`);
  assert.deepEqual(Object.keys(privacyTombstone).sort(), [
    'completedAtMs', 'createdAtMs', 'expiresAtMs', 'jobId', 'schemaVersion', 'status', 'updatedAtMs',
  ]);
  assert.equal(privacyTombstone.status, 'privacy_deleted');
  assert.equal(JSON.stringify(privacyTombstone).includes('Private Passenger'), false);
  assert.equal(db.read('notification_job_fanout_queue/private-queue-key'), undefined);
});

test('chat reply cleanup preserves a concurrently replaced reply context', async () => {
  let replaced = false;
  const db = createConcurrencyDb({
    'chats/TOUR_CONCURRENT/messages/a-passenger': {
      senderId: PASSENGER_ID, senderStableId: PASSENGER_ID, text: 'private quoted content',
    },
    'chats/TOUR_CONCURRENT/messages/b-other-reply': {
      senderId: 'other-passenger', senderStableId: 'other-passenger', text: 'preserve reply',
      replyTo: { messageId: 'a-passenger', previewText: 'private quoted content' },
    },
  }, {
    beforeTransaction: ({ path, state }) => {
      if (replaced || path !== 'chats/TOUR_CONCURRENT/messages/b-other-reply') return;
      replaced = true;
      put(state, `${path}/replyTo`, { messageId: 'new-unrelated-message', previewText: 'new context' });
    },
  });
  await scrubChatPage({
    db,
    scope: {
      principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [AUTH_UID, PASSENGER_ID],
    },
    cursor: null,
    nowMs: NOW,
    lease: null,
  });
  assert.deepEqual(db.read('chats/TOUR_CONCURRENT/messages/b-other-reply/replyTo'), {
    messageId: 'new-unrelated-message', previewText: 'new context',
  });
});

test('chat scrub waits for a live notification lease before removing authored content', async () => {
  const notificationJobId = buildNotificationJobId(
    'group_chat_message', 'TOUR_CONCURRENT:leased-message',
  );
  const db = createConcurrencyDb({
    'chats/TOUR_CONCURRENT/messages/leased-message': {
      senderId: PASSENGER_ID,
      senderStableId: PASSENGER_ID,
      senderName: 'Private Passenger',
      text: 'must remain until delivery exits',
    },
    [`notification_jobs/${notificationJobId}`]: {
      jobId: notificationJobId,
      status: 'fanout_in_progress',
      presentation: { title: 'New message', body: 'Private Passenger: must remain until delivery exits' },
      lease: { ownerId: 'notification-worker', expiresAtMs: NOW + 60_000 },
    },
  });
  await assert.rejects(() => scrubChatPage({
    db,
    scope: {
      principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [AUTH_UID, PASSENGER_ID],
    },
    cursor: null,
    nowMs: NOW,
    lease: null,
  }), (error) => error.code === 'ACCOUNT_DELETION_NOTIFICATION_BUSY');
  assert.equal(
    db.read('chats/TOUR_CONCURRENT/messages/leased-message/text'),
    'must remain until delivery exits',
  );
  assert.equal(db.read(`notification_jobs/${notificationJobId}/status`), 'fanout_in_progress');
});

test('photo notification tombstone uses the producer canonical ID for whitespace-valid photo IDs', async () => {
  const notificationJobId = buildNotificationJobId(
    'group_photo_message', 'TOUR_CONCURRENT:photo-message:photo_1',
  );
  const db = createConcurrencyDb({
    'chats/TOUR_CONCURRENT/messages/photo-message': {
      schemaVersion: 2,
      type: 'image',
      photoId: '  photo_1  ',
      senderId: PASSENGER_ID,
      senderStableId: PASSENGER_ID,
      senderName: 'Private Passenger',
      text: '',
    },
    [`notification_jobs/${notificationJobId}`]: {
      jobId: notificationJobId,
      status: 'queued',
      presentation: { title: 'Photo', body: 'Private Passenger: Shared a photo' },
    },
  });
  await scrubChatPage({
    db,
    scope: {
      principalType: 'passenger', tourId: 'TOUR_CONCURRENT', actorKeys: [AUTH_UID, PASSENGER_ID],
    },
    cursor: null,
    nowMs: NOW,
    lease: null,
  });
  assert.equal(db.read(`notification_jobs/${notificationJobId}/status`), 'privacy_deleted');
  assert.equal(JSON.stringify(db.read(`notification_jobs/${notificationJobId}`)).includes('Private Passenger'), false);
});

test('stale finalizer cannot overwrite completion or clear successor barriers', async () => {
  const deletionId = 'acctdel_v1_stale_finalizer';
  const passengerBarrierKey = derivePassengerAccountDeletionKey('BOOK_CONCURRENT');
  const path = `account_deletion_jobs/v1/${deletionId}`;
  const job = {
    status: 'pending', phase: 'auth_delete', createdAtMs: NOW - 1_000,
    leaseRevision: 4,
    lease: { ownerId: 'stale-worker', phase: 'auth_delete', expiresAtMs: NOW + 60_000 },
    privateScope: { authUid: AUTH_UID, principalType: 'passenger', passengerBarrierKey },
    summary: {},
  };
  let successorCompleted = false;
  const db = createConcurrencyDb({
    [path]: job,
    [`account_deletion_active/v1/${AUTH_UID}`]: { deletionId },
    [`account_deletion_passenger_active/v1/${passengerBarrierKey}`]: { deletionId },
  }, {
    beforeTransaction: ({ path: transactionPath, state }) => {
      if (successorCompleted || transactionPath !== path) return;
      successorCompleted = true;
      put(state, path, {
        status: 'completed', phase: 'completed', completedAtMs: NOW, updatedAtMs: NOW,
      });
      put(state, `account_deletion_active/v1/${AUTH_UID}`, { deletionId: 'successor-deletion' });
      put(state, `account_deletion_passenger_active/v1/${passengerBarrierKey}`, {
        deletionId: 'successor-deletion',
      });
    },
  });
  await assert.rejects(() => finalizeCompletedAccountDeletion({
    db,
    deletionId,
    lease: {
      ref: db.ref(path), ownerId: 'stale-worker', revision: 4, phase: 'auth_delete', clock: () => NOW,
    },
    job,
    nowMs: NOW,
  }), (error) => error.code === 'ACCOUNT_DELETION_FINALIZATION_CHANGED');
  assert.equal(db.read(`${path}/status`), 'completed');
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), 'successor-deletion');
  assert.equal(
    db.read(`account_deletion_passenger_active/v1/${passengerBarrierKey}/deletionId`),
    'successor-deletion',
  );
});
