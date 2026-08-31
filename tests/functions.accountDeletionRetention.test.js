'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES,
  ACCOUNT_DELETION_PHASES,
} = require('../functions/src/domains/account-deletion/accountDeletionConstants');
const {
  deriveAccountDeletionId,
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
  toPublicAccountDeletionStatus,
} = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const {
  projectValidatedStatusResponse,
  readAccountDeletionStatusRecord,
  retryAccountDeletionJob,
} = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const {
  cleanupCompletedAccountDeletionJobs,
  processAccountDeletionJob,
  processLeasedAccountDeletionPhase,
  repairAccountDeletionRetryQueues,
  recordAccountDeletionFailure,
} = require('../functions/src/domains/account-deletion/accountDeletionWorker');
const {
  buildOperationsTerminalWarning,
  cleanupExpiredOperationsTerminalWarnings,
} = require('../functions/lib/operationsTerminalWarnings');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const segments = (path = '') => String(path).split('/').filter(Boolean);
const at = (root, path = '') => segments(path).reduce((value, key) => (
  value && typeof value === 'object' ? value[key] : undefined
), root);
const assign = (root, path, value) => {
  const keys = segments(path);
  let target = root;
  keys.slice(0, -1).forEach((key) => {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  });
  if (value === null || value === undefined) delete target[keys.at(-1)];
  else target[keys.at(-1)] = clone(value);
};
const snap = (value) => ({
  exists: () => value !== undefined && value !== null,
  val: () => clone(value === undefined ? null : value),
});

const createRetentionDb = (initial = {}, options = {}) => {
  const state = {};
  Object.entries(initial).forEach(([path, value]) => assign(state, path, value));
  const controls = {
    failRootUpdates: Number(options.failRootUpdates || 0),
    transactionError: options.transactionError || null,
    afterTransaction: options.afterTransaction || null,
  };
  const makeRef = (path = '', query = {}) => {
    const normalized = segments(path).join('/');
    const queryValue = () => {
      const raw = at(state, normalized);
      if (!query.child) return raw;
      let entries = Object.entries(raw && typeof raw === 'object' ? raw : {});
      entries.sort(([, left], [, right]) => Number(left?.[query.child] || 0)
        - Number(right?.[query.child] || 0));
      if (query.end !== undefined) {
        entries = entries.filter(([, value]) => Number(value?.[query.child] || 0) <= Number(query.end));
      }
      if (query.start !== undefined) {
        entries = entries.filter(([, value]) => Number(value?.[query.child] || 0) >= Number(query.start));
      }
      if (query.limit !== undefined) entries = entries.slice(0, query.limit);
      return Object.fromEntries(entries);
    };
    const ref = {
      child(childPath) { return makeRef(`${normalized}/${childPath}`); },
      async once() { return snap(queryValue()); },
      orderByChild(child) { return makeRef(normalized, { ...query, child }); },
      startAt(value) { return makeRef(normalized, { ...query, start: value }); },
      endAt(value) { return makeRef(normalized, { ...query, end: value }); },
      limitToFirst(value) { return makeRef(normalized, { ...query, limit: value }); },
      async update(updates) {
        if (!normalized && controls.failRootUpdates > 0) {
          controls.failRootUpdates -= 1;
          throw new Error('injected completion update failure');
        }
        const next = clone(state);
        Object.entries(updates).forEach(([relative, value]) => {
          assign(next, [normalized, relative].filter(Boolean).join('/'), value);
        });
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, next);
      },
      async transaction(updater) {
        const error = controls.transactionError?.(normalized);
        if (error) throw error;
        const current = clone(at(state, normalized) ?? null);
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: snap(current) };
        assign(state, normalized, next);
        controls.afterTransaction?.({ path: normalized, state });
        return { committed: true, snapshot: snap(next) };
      },
    };
    return ref;
  };
  return {
    controls,
    ref: makeRef,
    read: (path) => clone(at(state, path)),
    write: (path, value) => assign(state, path, value),
  };
};

const NOW = 1_800_200_000_000;
const AUTH_UID = 'uid-auth-delete-private';
const SESSION_ID = `sess_v1_${'5'.repeat(32)}`;
const RECEIPT = `delrec_v1_${'6'.repeat(64)}`;
const DELETION_ID = deriveAccountDeletionId(RECEIPT);
const SCOPE = {
  authUid: AUTH_UID,
  expectedSessionId: SESSION_ID,
  principalType: 'passenger',
  principalId: `pax_v2_${'7'.repeat(32)}`,
  tourId: 'TOUR_PRIVATE',
  bookingRef: 'BOOK_PRIVATE',
  stablePassengerId: `pax_v2_${'7'.repeat(32)}`,
  stablePassengerKey: `pax_v2_${'7'.repeat(32)}`,
  privatePhotoOwnerKey: `pax_v2_${'7'.repeat(32)}`,
  actorKeys: [AUTH_UID, `pax_v2_${'7'.repeat(32)}`],
};

const authDeleteJob = (overrides = {}) => ({
  schemaVersion: 1,
  deletionId: DELETION_ID,
  status: 'pending',
  phase: 'auth_delete',
  createdAtMs: NOW - 10_000,
  updatedAtMs: NOW - 1_000,
  destructiveStartedAtMs: NOW - 10_000,
  expiresAtMs: NOW - 1,
  availableAtMs: NOW,
  attemptCount: 3,
  consecutiveFailureCount: 0,
  firstAttemptAtMs: NOW - 9_000,
  lastAttemptAtMs: NOW - 1_000,
  lastFailureReason: null,
  leaseRevision: 4,
  lease: {
    ownerId: 'auth-worker', revision: 4, phase: 'auth_delete', acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
  },
  privateScope: {
    authUid: AUTH_UID,
    principalType: 'passenger',
    passengerBarrierKey: derivePassengerAccountDeletionKey(SCOPE.bookingRef),
  },
  cursors: {
    groupMediaAfterPhotoId: 'group-last',
    privateMediaAfterPhotoId: 'private-last',
    chatAfterMessageId: 'chat-last',
  },
  summary: {
    recordsRemoved: 9,
    storageObjectsRemoved: 3,
    chatMessagesScrubbed: 2,
    reactionsRemoved: 1,
  },
  ...overrides,
});

const authFixture = (job = authDeleteJob()) => ({
  [`account_deletion_jobs/v1/${DELETION_ID}`]: job,
  [`account_deletion_active/v1/${AUTH_UID}`]: { deletionId: DELETION_ID, createdAtMs: NOW - 10_000 },
  [`account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(SCOPE.bookingRef)}`]: {
    deletionId: DELETION_ID, createdAtMs: NOW - 10_000,
  },
  [`account_deletion_uid_tombstones/v1/${deriveUidAccountDeletionTombstoneKey(AUTH_UID)}`]: {
    schemaVersion: 1, permanent: true, createdAtMs: NOW - 10_000,
  },
  [`account_deletion_queue/v1/${DELETION_ID}`]: { deletionId: DELETION_ID, dueAtMs: NOW, lease: { ownerId: 'auth-worker' } },
});

const leaseFor = (db) => ({
  ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
  ownerId: 'auth-worker',
  revision: 4,
  phase: 'auth_delete',
});

test('all durable phases are explicit and Auth deletion remains last before completion', () => {
  assert.deepEqual(ACCOUNT_DELETION_PHASES, [
    'reserved',
    'live_state_cleanup',
    'authority_release',
    'group_media',
    'private_media',
    'chat_scrub',
    'account_records',
    'auth_delete',
    'completed',
  ]);
});

test('transition to Auth deletion shreds booking, session, tour, principal and actor scope', async () => {
  const job = authDeleteJob({
    phase: 'account_records',
    substage: 'uid_records_deleted',
    privateScope: SCOPE,
    lease: {
      ownerId: 'auth-worker', revision: 4, phase: 'account_records',
      acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
  });
  const db = createRetentionDb(authFixture(job));
  const committed = await processLeasedAccountDeletionPhase({
    db,
    bucket: {},
    auth: {},
    deletionId: DELETION_ID,
    job,
    lease: {
      ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
      ownerId: 'auth-worker', revision: 4, phase: 'account_records',
    },
    nowMs: NOW,
  });
  assert.equal(committed, true);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/phase`), 'auth_delete');
  assert.deepEqual(db.read(`account_deletion_jobs/v1/${DELETION_ID}/privateScope`), {
    authUid: AUTH_UID,
    principalType: 'passenger',
    passengerBarrierKey: derivePassengerAccountDeletionKey(SCOPE.bookingRef),
  });
});

test('transient Auth failure leaves the job, barrier, queue, cursors, and private scope retryable', async () => {
  const job = authDeleteJob();
  const db = createRetentionDb(authFixture(job));
  const auth = {
    async deleteUser(uid) {
      assert.equal(uid, AUTH_UID);
      const error = new Error('transient auth outage');
      error.code = 'auth/internal-error';
      throw error;
    },
  };
  await assert.rejects(() => processLeasedAccountDeletionPhase({
    db, bucket: {}, auth, deletionId: DELETION_ID, job, lease: leaseFor(db), nowMs: NOW,
  }), (error) => error.code === 'auth/internal-error');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/phase`), 'auth_delete');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/cursors/chatAfterMessageId`), 'chat-last');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/privateScope/authUid`), AUTH_UID);
  assert.deepEqual(Object.keys(db.read(`account_deletion_jobs/v1/${DELETION_ID}/privateScope`)).sort(), [
    'authUid', 'passengerBarrierKey', 'principalType',
  ]);
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
});

test('Auth user-not-found is replay success and completion compare-cleans barrier and queue', async () => {
  const job = authDeleteJob();
  const db = createRetentionDb(authFixture(job));
  const auth = {
    async deleteUser() {
      const error = new Error('already absent');
      error.code = 'auth/user-not-found';
      throw error;
    },
  };
  const result = await processLeasedAccountDeletionPhase({
    db, bucket: {}, auth, deletionId: DELETION_ID, job, lease: leaseFor(db), nowMs: NOW,
  });
  assert.equal(result.status, 'completed');
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}`), undefined);
  assert.equal(db.read(
    `account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(SCOPE.bookingRef)}`,
  ), undefined);
  assert.equal(db.read(
    `account_deletion_uid_tombstones/v1/${deriveUidAccountDeletionTombstoneKey(AUTH_UID)}/permanent`,
  ), true);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}`), undefined);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'completed');
  assert.equal(db.read(`account_deletion_completion_tombstones/v1/${DELETION_ID}/status`), 'completed');
});

test('completion removes the exact account-deletion warning after it is no longer actionable', async () => {
  const warning = buildOperationsTerminalWarning({
    jobType: 'account_deletion',
    reason: 'storage_unavailable',
    identifiers: { deletionId: DELETION_ID, leaseRevision: 4 },
    attemptCount: 3,
    firstAttemptAtMs: NOW - 9_000,
    lastAttemptAtMs: NOW - 1_000,
    expiresAtMs: NOW - 1,
    nowMs: NOW - 1_000,
  });
  const job = authDeleteJob({ terminalWarningId: warning.warningId });
  const db = createRetentionDb({
    ...authFixture(job),
    [`operations_terminal_warnings/v1/${warning.warningId}`]: warning,
  });
  await processLeasedAccountDeletionPhase({
    db, bucket: {}, auth: { deleteUser: async () => {} }, deletionId: DELETION_ID,
    job, lease: leaseFor(db), nowMs: NOW,
  });
  assert.equal(db.read(`operations_terminal_warnings/v1/${warning.warningId}`), undefined);
});

test('crash after durable completion but before barrier cleanup is reconciled without reopening login', async () => {
  const job = authDeleteJob();
  let failCompletionCleanup = true;
  const db = createRetentionDb(authFixture(job), {
    transactionError: (path) => {
      if (!failCompletionCleanup
        || path !== `account_deletion_active/v1/${AUTH_UID}`) return null;
      failCompletionCleanup = false;
      return new Error('injected completion reconciliation failure');
    },
  });
  let userExists = true;
  let authDeleteCalls = 0;
  const auth = {
    async deleteUser() {
      authDeleteCalls += 1;
      if (userExists) {
        userExists = false;
        return;
      }
      const error = new Error('already absent');
      error.code = 'auth/user-not-found';
      throw error;
    },
  };
  await assert.rejects(() => processLeasedAccountDeletionPhase({
    db, bucket: {}, auth, deletionId: DELETION_ID, job, lease: leaseFor(db), nowMs: NOW,
  }), /completion reconciliation failure/);
  assert.equal(userExists, false);
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_completion_tombstones/v1/${DELETION_ID}/status`), 'completed');
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'completed');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/phase`), 'completed');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/completionCleanup/authUid`), AUTH_UID);
  assert.equal(projectValidatedStatusResponse(
    db.read(`account_deletion_jobs/v1/${DELETION_ID}`),
  ).status, 'pending');

  const recovered = await processAccountDeletionJob({
    db, bucket: {}, auth, deletionId: DELETION_ID, ownerId: 'auth-worker', nowMs: NOW + 1,
  });
  assert.equal(recovered.reason, 'JOB_NOT_CLAIMED');
  assert.equal(authDeleteCalls, 1);
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}`), undefined);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'completed');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/completionCleanup`), undefined);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}`), undefined);
});

test('crash after both admission barriers are removed retains durable completion evidence and resumes', async () => {
  const job = authDeleteJob();
  const jobPath = `account_deletion_jobs/v1/${DELETION_ID}`;
  let jobTransactions = 0;
  const db = createRetentionDb(authFixture(job), {
    transactionError: (path) => {
      if (path !== jobPath) return null;
      jobTransactions += 1;
      return jobTransactions === 2 ? new Error('injected completion marker removal failure') : null;
    },
  });

  await assert.rejects(() => processLeasedAccountDeletionPhase({
    db,
    bucket: {},
    auth: { deleteUser: async () => {} },
    deletionId: DELETION_ID,
    job,
    lease: leaseFor(db),
    nowMs: NOW,
  }), /completion marker removal failure/);

  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}`), undefined);
  assert.equal(db.read(
    `account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(SCOPE.bookingRef)}`,
  ), undefined);
  assert.equal(db.read(`account_deletion_completion_tombstones/v1/${DELETION_ID}/status`), 'completed');
  assert.equal(db.read(`${jobPath}/completionCleanup/authUid`), AUTH_UID);
  assert.equal(projectValidatedStatusResponse(db.read(jobPath)).status, 'pending');
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);

  const recovered = await processAccountDeletionJob({
    db,
    bucket: {},
    auth: { deleteUser: async () => assert.fail('Auth must not be deleted twice') },
    deletionId: DELETION_ID,
    ownerId: 'auth-worker',
    nowMs: NOW + 1,
  });
  assert.equal(recovered.reason, 'JOB_NOT_CLAIMED');
  assert.equal(db.read(`${jobPath}/completionCleanup`), undefined);
  assert.equal(projectValidatedStatusResponse(db.read(jobPath)).status, 'completed');
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}`), undefined);
});

test('completed job and public projection contain only bounded non-identity status data', async () => {
  const job = authDeleteJob();
  const db = createRetentionDb(authFixture(job));
  const completed = await processLeasedAccountDeletionPhase({
    db,
    bucket: {},
    auth: { deleteUser: async () => {} },
    deletionId: DELETION_ID,
    job,
    lease: leaseFor(db),
    nowMs: NOW,
  });
  const serializedCompleted = JSON.stringify(completed);
  [AUTH_UID, SESSION_ID, 'BOOK_PRIVATE', 'TOUR_PRIVATE', RECEIPT, 'group-last', 'private-last', 'chat-last']
    .forEach((secret) => assert.equal(serializedCompleted.includes(secret), false, secret));
  assert.equal(Object.prototype.hasOwnProperty.call(completed, 'privateScope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(completed, 'cursors'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(completed, 'lease'), false);

  const publicStatus = projectValidatedStatusResponse(completed);
  assert.deepEqual(publicStatus, toPublicAccountDeletionStatus(completed));
  const serializedPublic = JSON.stringify(publicStatus);
  assert.equal(serializedPublic.includes(DELETION_ID), false);
  assert.equal(serializedPublic.includes(AUTH_UID), false);
  assert.deepEqual(Object.keys(publicStatus).sort(), [
    'completedAtMs', 'createdAtMs', 'phase', 'retryable', 'status', 'success', 'summary', 'updatedAtMs',
  ]);
});

test('post-destructive terminal failure persists a hash-only warning and never deletes source, barrier, or queue', async () => {
  const job = authDeleteJob({
    phase: 'group_media',
    lease: {
      ownerId: 'media-worker', revision: 4, phase: 'group_media', acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
    consecutiveFailureCount: ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES - 1,
  });
  const db = createRetentionDb(authFixture(job));
  const ref = db.ref(`account_deletion_jobs/v1/${DELETION_ID}`);
  const outcome = await recordAccountDeletionFailure({
    db,
    ref,
    deletionId: DELETION_ID,
    lease: { ownerId: 'media-worker', revision: 4, phase: 'group_media' },
    error: Object.assign(new Error('storage unavailable'), { code: 'STORAGE_UNAVAILABLE' }),
    nowMs: NOW,
  });
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.status, 'requires_attention');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'requires_attention');
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
  const warning = Object.values(db.read('operations_terminal_warnings/v1'))[0];
  assert.equal(warning.jobType, 'account_deletion');
  assert.match(warning.identifierHashes.deletionId, /^[a-f0-9]{24}$/);
  const warningJson = JSON.stringify(warning);
  [DELETION_ID, AUTH_UID, SESSION_ID, 'BOOK_PRIVATE', 'TOUR_PRIVATE', RECEIPT]
    .forEach((secret) => assert.equal(warningJson.includes(secret), false, secret));
});

test('transient failure remains retryable with backoff while terminal failure alone requires attention', async () => {
  const job = authDeleteJob({
    phase: 'chat_scrub',
    lease: {
      ownerId: 'transient-worker', revision: 4, phase: 'chat_scrub', acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
    consecutiveFailureCount: 1,
  });
  const db = createRetentionDb(authFixture(job));
  const outcome = await recordAccountDeletionFailure({
    db,
    ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
    deletionId: DELETION_ID,
    lease: { ownerId: 'transient-worker', revision: 4, phase: 'chat_scrub' },
    error: Object.assign(new Error('retryable page write'), { code: 'PAGE_WRITE_RETRY' }),
    nowMs: NOW,
  });
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.status, 'pending');
  assert.ok(outcome.dueAtMs > NOW);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'pending');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/consecutiveFailureCount`), 2);
  assert.equal(db.read('operations_terminal_warnings/v1'), undefined);
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
});

test('warning persistence failure leaves the post-destructive source and barrier unchanged', async () => {
  const job = authDeleteJob({
    phase: 'private_media',
    lease: {
      ownerId: 'warning-worker', revision: 4, phase: 'private_media', acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
    consecutiveFailureCount: ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES - 1,
  });
  const db = createRetentionDb(authFixture(job), {
    transactionError: (path) => path.startsWith('operations_terminal_warnings/v1/')
      ? new Error('warning persistence unavailable') : null,
  });
  await assert.rejects(() => recordAccountDeletionFailure({
    db,
    ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
    deletionId: DELETION_ID,
    lease: { ownerId: 'warning-worker', revision: 4, phase: 'private_media' },
    error: Object.assign(new Error('media failure'), { code: 'MEDIA_FAILURE' }),
    nowMs: NOW,
  }), /warning persistence unavailable/);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/phase`), 'private_media');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/lease/ownerId`), 'warning-worker');
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
});

test('lease loss during warning persistence removes a newly created unreferenced warning', async () => {
  const job = authDeleteJob({
    phase: 'group_media',
    lease: {
      ownerId: 'stale-warning-worker', revision: 4, phase: 'group_media',
      acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
    consecutiveFailureCount: ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES - 1,
  });
  let changedLease = false;
  const db = createRetentionDb(authFixture(job), {
    afterTransaction: ({ path, state }) => {
      if (!changedLease && path.startsWith('operations_terminal_warnings/v1/')) {
        changedLease = true;
        state.account_deletion_jobs.v1[DELETION_ID].lease.ownerId = 'successor-worker';
      }
    },
  });
  const outcome = await recordAccountDeletionFailure({
    db,
    ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
    deletionId: DELETION_ID,
    lease: { ownerId: 'stale-warning-worker', revision: 4, phase: 'group_media' },
    error: Object.assign(new Error('stale warning failure'), { code: 'STORAGE_UNAVAILABLE' }),
    nowMs: NOW,
  });
  assert.equal(outcome.recorded, false);
  assert.deepEqual(db.read('operations_terminal_warnings/v1'), {});
});

test('stale warning cleanup preserves the distinct warning adopted by a successor lease', async () => {
  const job = authDeleteJob({
    phase: 'group_media',
    lease: {
      ownerId: 'stale-warning-worker', revision: 4, phase: 'group_media',
      acquiredAtMs: NOW - 100, expiresAtMs: NOW + 60_000,
    },
    consecutiveFailureCount: ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES - 1,
  });
  let injectedSuccessor = false;
  let successorWarningId = null;
  const db = createRetentionDb(authFixture(job), {
    afterTransaction: ({ path, state }) => {
      if (injectedSuccessor || !path.startsWith('operations_terminal_warnings/v1/')) return;
      injectedSuccessor = true;
      const successorWarning = buildOperationsTerminalWarning({
        jobType: 'account_deletion',
        reason: 'storage_unavailable',
        identifiers: { deletionId: DELETION_ID, leaseRevision: 5 },
        attemptCount: job.attemptCount,
        firstAttemptAtMs: job.firstAttemptAtMs,
        lastAttemptAtMs: NOW,
        expiresAtMs: job.expiresAtMs,
        nowMs: NOW + 1,
      });
      successorWarningId = successorWarning.warningId;
      state.operations_terminal_warnings.v1[successorWarningId] = successorWarning;
      Object.assign(state.account_deletion_jobs.v1[DELETION_ID], {
        status: 'requires_attention',
        terminalWarningId: successorWarningId,
        leaseRevision: 5,
        lease: null,
      });
    },
  });
  const outcome = await recordAccountDeletionFailure({
    db,
    ref: db.ref(`account_deletion_jobs/v1/${DELETION_ID}`),
    deletionId: DELETION_ID,
    lease: { ownerId: 'stale-warning-worker', revision: 4, phase: 'group_media' },
    error: Object.assign(new Error('stale warning failure'), { code: 'STORAGE_UNAVAILABLE' }),
    nowMs: NOW,
  });

  assert.equal(outcome.recorded, false);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/terminalWarningId`), successorWarningId);
  assert.equal(db.read(`operations_terminal_warnings/v1/${successorWarningId}/warningId`), successorWarningId);
  assert.deepEqual(Object.keys(db.read('operations_terminal_warnings/v1')), [successorWarningId]);
});

test('requires-attention work retains its queue entry until final completion', async () => {
  const job = authDeleteJob({ status: 'requires_attention', lease: null, phase: 'private_media' });
  const db = createRetentionDb(authFixture(job));
  const outcome = await processAccountDeletionJob({
    db,
    bucket: {},
    auth: {},
    deletionId: DELETION_ID,
    ownerId: 'attention-queue-worker',
    nowMs: NOW,
  });

  assert.deepEqual(outcome, { processed: false, reason: 'JOB_NOT_CLAIMED' });
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/deletionId`), DELETION_ID);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/lease`), null);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/dueAtMs`), NOW + (24 * 60 * 60 * 1000));
});

test('retention cleanup removes only expired completed records, never expired destructive work', async () => {
  const completedId = `acctdel_v1_${'8'.repeat(64)}`;
  const pendingId = `acctdel_v1_${'9'.repeat(64)}`;
  const db = createRetentionDb({
    [`account_deletion_jobs/v1/${completedId}`]: {
      schemaVersion: 1, status: 'completed', completedAtMs: NOW - 1_000, retainUntilMs: NOW - 1,
    },
    [`account_deletion_jobs/v1/${pendingId}`]: {
      schemaVersion: 1,
      status: 'requires_attention',
      phase: 'group_media',
      destructiveStartedAtMs: NOW - 100_000,
      expiresAtMs: NOW - 1,
    },
    [`account_deletion_active/v1/${AUTH_UID}`]: { deletionId: pendingId },
    [`account_deletion_queue/v1/${pendingId}`]: { deletionId: pendingId, dueAtMs: NOW },
  });
  assert.equal(await cleanupCompletedAccountDeletionJobs({ db, nowMs: NOW }), 1);
  assert.equal(db.read(`account_deletion_jobs/v1/${completedId}`), undefined);
  assert.equal(db.read(`account_deletion_jobs/v1/${pendingId}/status`), 'requires_attention');
  assert.equal(db.read(`account_deletion_active/v1/${AUTH_UID}/deletionId`), pendingId);
  assert.equal(db.read(`account_deletion_queue/v1/${pendingId}/deletionId`), pendingId);
});

test('retention cleanup cannot be starved by pending jobs missing retainUntilMs', async () => {
  const completedId = `acctdel_v1_${'a'.repeat(64)}`;
  const fixture = {
    [`account_deletion_jobs/v1/${completedId}`]: {
      schemaVersion: 1, status: 'completed', completedAtMs: NOW - 1_000, retainUntilMs: NOW - 1,
    },
  };
  for (let index = 0; index < 75; index += 1) {
    fixture[`account_deletion_jobs/v1/pending-${String(index).padStart(3, '0')}`] = {
      schemaVersion: 1, status: 'pending', phase: 'group_media', updatedAtMs: NOW,
    };
  }
  const db = createRetentionDb(fixture);
  assert.equal(await cleanupCompletedAccountDeletionJobs({ db, nowMs: NOW, limit: 50 }), 1);
  assert.equal(db.read(`account_deletion_jobs/v1/${completedId}`), undefined);
  assert.equal(db.read('account_deletion_jobs/v1/pending-000/status'), 'pending');
});

test('expired hash-only terminal warnings are swept by their retention deadline', async () => {
  const expired = buildOperationsTerminalWarning({
    jobType: 'account_deletion', reason: 'storage_unavailable',
    identifiers: { deletionId: DELETION_ID, leaseRevision: 3 },
    attemptCount: 3, firstAttemptAtMs: NOW - 20_000, lastAttemptAtMs: NOW - 10_000,
    expiresAtMs: NOW - 5_000, nowMs: NOW - 2_000, retentionMs: 1_000,
  });
  const retained = buildOperationsTerminalWarning({
    jobType: 'account_deletion', reason: 'storage_unavailable',
    identifiers: { deletionId: `${DELETION_ID}-new`, leaseRevision: 4 },
    attemptCount: 4, firstAttemptAtMs: NOW - 2_000, lastAttemptAtMs: NOW - 1_000,
    expiresAtMs: NOW + 5_000, nowMs: NOW, retentionMs: 10_000,
  });
  const db = createRetentionDb({
    [`operations_terminal_warnings/v1/${expired.warningId}`]: expired,
    [`operations_terminal_warnings/v1/${retained.warningId}`]: retained,
  });
  assert.equal(await cleanupExpiredOperationsTerminalWarnings({ db, nowMs: NOW, limit: 10 }), 1);
  assert.equal(db.read(`operations_terminal_warnings/v1/${expired.warningId}`), undefined);
  assert.equal(db.read(`operations_terminal_warnings/v1/${retained.warningId}/warningId`), retained.warningId);
});

test('minimal completion tombstone preserves receipt recovery after completed-job retention cleanup', async () => {
  const job = authDeleteJob();
  const db = createRetentionDb(authFixture(job));
  await processLeasedAccountDeletionPhase({
    db, bucket: {}, auth: { deleteUser: async () => {} }, deletionId: DELETION_ID,
    job, lease: leaseFor(db), nowMs: NOW,
  });
  assert.equal(await cleanupCompletedAccountDeletionJobs({
    db, nowMs: NOW + (181 * 24 * 60 * 60 * 1000), limit: 50,
  }), 1);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}`), undefined);
  const recovered = await readAccountDeletionStatusRecord({ db, deletionId: DELETION_ID });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(Object.keys(recovered).sort(), [
    'completedAtMs', 'phase', 'retryable', 'schemaVersion', 'status', 'updatedAtMs',
  ]);
  const retry = await retryAccountDeletionJob({ db, deletionId: DELETION_ID, nowMs: NOW });
  assert.equal(retry.outcome, 'completed');
  assert.equal(retry.job.status, 'completed');
});

test('retry preserves private scope and cursors while requeueing the exact deletion capability', async () => {
  const job = authDeleteJob({ status: 'requires_attention', lease: null, phase: 'private_media' });
  const db = createRetentionDb(authFixture(job));
  const beforeScope = db.read(`account_deletion_jobs/v1/${DELETION_ID}/privateScope`);
  const beforeCursors = db.read(`account_deletion_jobs/v1/${DELETION_ID}/cursors`);
  const result = await retryAccountDeletionJob({ db, deletionId: DELETION_ID, nowMs: NOW });
  assert.equal(result.outcome, 'queued');
  assert.equal(result.job.status, 'pending');
  assert.deepEqual(result.job.privateScope, beforeScope);
  assert.deepEqual(result.job.cursors, beforeCursors);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/dueAtMs`), NOW);
});

test('scheduler repair restores a retry queue after the immediate queue write crashes', async () => {
  const job = authDeleteJob({ status: 'requires_attention', lease: null, phase: 'private_media' });
  const db = createRetentionDb(authFixture(job), {
    transactionError: (path) => path === `account_deletion_queue/v1/${DELETION_ID}`
      ? new Error('injected retry queue failure') : null,
  });
  db.write(`account_deletion_queue/v1/${DELETION_ID}/dueAtMs`, NOW + (24 * 60 * 60 * 1000));
  await assert.rejects(
    retryAccountDeletionJob({ db, deletionId: DELETION_ID, nowMs: NOW }),
    /retry queue failure/,
  );
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/status`), 'pending');
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/retryRequestedAtMs`), NOW);
  db.controls.transactionError = null;
  assert.equal(await repairAccountDeletionRetryQueues({ db, nowMs: NOW }), 1);
  assert.equal(db.read(`account_deletion_queue/v1/${DELETION_ID}/dueAtMs`), NOW);
  assert.equal(db.read(`account_deletion_jobs/v1/${DELETION_ID}/retryRequestedAtMs`), undefined);
});

test('receipt-derived IDs isolate capabilities without retaining or exposing the receipt', () => {
  const otherReceipt = `delrec_v1_${'a'.repeat(64)}`;
  assert.notEqual(deriveAccountDeletionId(RECEIPT), deriveAccountDeletionId(otherReceipt));
  assert.equal(deriveAccountDeletionId(RECEIPT).includes(RECEIPT), false);
  const status = toPublicAccountDeletionStatus(authDeleteJob());
  assert.equal(JSON.stringify(status).includes(RECEIPT), false);
  assert.equal(JSON.stringify(status).includes(DELETION_ID), false);
});
