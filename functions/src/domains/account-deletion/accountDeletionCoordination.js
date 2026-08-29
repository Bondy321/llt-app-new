'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const {
  ACCOUNT_DELETION_ACTIVE_ROOT,
  ACCOUNT_DELETION_JOB_ROOT,
  ACCOUNT_DELETION_LEASE_MS,
  ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT,
  ACCOUNT_DELETION_PASSENGER_LOCK_ROOT,
  ACCOUNT_DELETION_QUEUE_ROOT,
  ACCOUNT_DELETION_UID_TOMBSTONE_ROOT,
} = require('./accountDeletionConstants');
const {
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
} = require('./accountDeletionBoundary');

const PASSENGER_ACCOUNT_DELETION_LOCK_TTL_MS = 3 * 60 * 1000;

const readActiveAccountDeletion = async ({ db, authUid }) => {
  const snapshot = await db.ref(`${ACCOUNT_DELETION_ACTIVE_ROOT}/${authUid}`).once('value');
  return snapshot.exists() ? snapshot.val() : null;
};

const accountDeletionInProgressError = () => {
  const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion is in progress'));
  error.code = 'ACCOUNT_DELETION_IN_PROGRESS';
  return error;
};

const ensureNoActiveAccountDeletion = async ({ db, authUid }) => {
  const [active, tombstone] = await Promise.all([
    readActiveAccountDeletion({ db, authUid }),
    db.ref(`${ACCOUNT_DELETION_UID_TOMBSTONE_ROOT}/${deriveUidAccountDeletionTombstoneKey(authUid)}`)
      .once('value'),
  ]);
  if (active !== null || tombstone.exists()) throw accountDeletionInProgressError();
  return true;
};

const readActivePassengerAccountDeletion = async ({ db, bookingRef }) => {
  const key = derivePassengerAccountDeletionKey(bookingRef);
  const snapshot = await db.ref(`${ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT}/${key}`).once('value');
  return snapshot.exists() ? snapshot.val() : null;
};

const ensureNoActivePassengerAccountDeletion = async ({ db, bookingRef }) => {
  if ((await readActivePassengerAccountDeletion({ db, bookingRef })) !== null) {
    throw accountDeletionInProgressError();
  }
  return true;
};

const acquirePassengerAccountDeletionLock = async ({
  db,
  bookingRef,
  ownerId = randomUUID(),
  nowMs = Date.now(),
  ttlMs = PASSENGER_ACCOUNT_DELETION_LOCK_TTL_MS,
}) => {
  const key = derivePassengerAccountDeletionKey(bookingRef);
  const ref = db.ref(`${ACCOUNT_DELETION_PASSENGER_LOCK_ROOT}/${key}`);
  const result = await ref.transaction((current) => {
    if (current && current.ownerId !== ownerId && Number(current.expiresAtMs || 0) > nowMs) return undefined;
    return { schemaVersion: 1, ownerId, createdAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
  }, undefined, false);
  return {
    acquired: Boolean(result?.committed && result.snapshot.val()?.ownerId === ownerId),
    bookingRef,
    key,
    ownerId,
    ref,
  };
};

const renewPassengerAccountDeletionLock = async ({
  lock,
  nowMs = Date.now(),
  ttlMs = PASSENGER_ACCOUNT_DELETION_LOCK_TTL_MS,
}) => {
  if (!lock?.ref || !lock.ownerId) return false;
  const result = await lock.ref.transaction((current) => {
    if (!current || current.ownerId !== lock.ownerId || Number(current.expiresAtMs || 0) <= nowMs) {
      return undefined;
    }
    return { ...current, expiresAtMs: nowMs + ttlMs };
  }, undefined, false);
  return Boolean(result?.committed && result.snapshot.val()?.ownerId === lock.ownerId);
};

const releasePassengerAccountDeletionLock = async ({ lock }) => {
  if (!lock?.ref || !lock.ownerId) return false;
  const result = await lock.ref.transaction((current) => (
    current?.ownerId === lock.ownerId ? null : undefined
  ), undefined, false);
  return Boolean(result?.committed && !result.snapshot.exists());
};

const claimAccountDeletionQueueEntry = async ({
  db, deletionId, nowMs = Date.now(), ownerId = randomUUID(), leaseMs = ACCOUNT_DELETION_LEASE_MS,
}) => {
  const ref = db.ref(`${ACCOUNT_DELETION_QUEUE_ROOT}/${deletionId}`);
  let claimed = false;
  const result = await ref.transaction((current) => {
    if (!current || Number(current.dueAtMs || 0) > nowMs) return undefined;
    if (current.lease && current.lease.ownerId !== ownerId
      && Number(current.lease.expiresAtMs || 0) > nowMs) return undefined;
    claimed = true;
    return {
      ...current,
      lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs },
    };
  }, undefined, false);
  return {
    claimed: Boolean(claimed && result?.committed && result.snapshot.val()?.lease?.ownerId === ownerId),
    ownerId,
    ref,
    entry: result?.snapshot?.val?.() || null,
  };
};

const acquireAccountDeletionJobLease = async ({
  db, deletionId, ownerId, nowMs = Date.now(), leaseMs = ACCOUNT_DELETION_LEASE_MS,
}) => {
  const ref = db.ref(`${ACCOUNT_DELETION_JOB_ROOT}/${deletionId}`);
  let acquired = false;
  const result = await ref.transaction((current) => {
    if (!current || current.status === 'completed' || current.status === 'requires_attention'
      || Number(current.availableAtMs || 0) > nowMs) return undefined;
    if (current.lease && current.lease.ownerId !== ownerId
      && Number(current.lease.expiresAtMs || 0) > nowMs) return undefined;
    acquired = true;
    const revision = Number.isSafeInteger(current.leaseRevision) ? current.leaseRevision + 1 : 1;
    return {
      ...current,
      attemptCount: Number(current.attemptCount || 0) + 1,
      firstAttemptAtMs: current.firstAttemptAtMs || nowMs,
      lastAttemptAtMs: nowMs,
      leaseRevision: revision,
      lease: {
        ownerId,
        phase: current.phase,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + leaseMs,
      },
      updatedAtMs: nowMs,
    };
  }, undefined, false);
  const job = result?.snapshot?.val?.() || null;
  return {
    acquired: Boolean(acquired && result?.committed && job?.lease?.ownerId === ownerId),
    ref,
    job,
    revision: job?.leaseRevision || null,
  };
};

const releaseAccountDeletionQueueEntry = async ({ ref, ownerId, dueAtMs = null, remove = false }) => {
  if (!ref || !ownerId) return false;
  let released = false;
  const result = await ref.transaction((current) => {
    if (!current || current.lease?.ownerId !== ownerId) return undefined;
    released = true;
    if (remove) return null;
    return {
      ...current,
      ...(Number.isFinite(dueAtMs) ? { dueAtMs: Number(dueAtMs) } : {}),
      lease: null,
    };
  }, undefined, false);
  return Boolean(released && result?.committed);
};

const jobLeaseMatches = (job, lease) => Boolean(job && lease
  && job.lease?.ownerId === lease.ownerId
  && job.leaseRevision === lease.revision
  && job.lease?.phase === lease.phase);

const assertCurrentJobLease = async (guard) => {
  const { ref, nowMs = null } = guard;
  const lease = guard.lease || guard;
  const checkedAtMs = typeof lease.clock === 'function' ? lease.clock() : nowMs;
  const current = (await ref.once('value')).val();
  if (!jobLeaseMatches(current, lease)
    || (Number.isFinite(checkedAtMs)
      && Number(current?.lease?.expiresAtMs || 0) <= Number(checkedAtMs))) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Account deletion lease changed'));
    error.code = 'ACCOUNT_DELETION_LEASE_LOST';
    throw error;
  }
  return current;
};

module.exports = {
  accountDeletionInProgressError,
  acquirePassengerAccountDeletionLock,
  acquireAccountDeletionJobLease,
  assertCurrentJobLease,
  claimAccountDeletionQueueEntry,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
  jobLeaseMatches,
  readActiveAccountDeletion,
  readActivePassengerAccountDeletion,
  releasePassengerAccountDeletionLock,
  releaseAccountDeletionQueueEntry,
  renewPassengerAccountDeletionLock,
};
