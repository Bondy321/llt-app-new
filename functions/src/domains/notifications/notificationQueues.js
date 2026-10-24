'use strict';

// @ts-check

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');

const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const QUEUE_ROOTS = Object.freeze({
  fanout: 'notification_job_fanout_queue_v2',
  retry: 'notification_attempt_retry_queue_v2',
  receipt: 'notification_receipt_due_queue_v2',
});
const QUEUE_KEY_WIDTH = 13;

/** @param {number} dueAtMs @param {string} targetId @param {number} version */
const buildNotificationQueueKey = (dueAtMs, targetId, version = 1) => {
  const due = Math.max(0, Math.trunc(Number(dueAtMs) || 0));
  const digest = createHash('sha256').update(String(targetId)).digest('hex').slice(0, 32);
  return `${String(due).padStart(QUEUE_KEY_WIDTH, '0')}~${digest}~${String(Math.max(1, version)).padStart(6, '0')}`;
};

/** @param {'fanout'|'retry'|'receipt'} kind @param {string} targetId @param {number} dueAtMs @param {number} version */
const buildQueueEntry = (kind, targetId, dueAtMs, version = 1, lane = 'operational') => ({
  schemaVersion: 1,
  kind,
  targetId,
  dueAtMs,
  version,
  serviceKey: `${lane}~${String(Math.max(0, Math.trunc(dueAtMs))).padStart(QUEUE_KEY_WIDTH, '0')}`,
  createdAtMs: Date.now(),
});

/**
 * Commit an exact observed job before publishing its replacement queue pointer.
 * Retain the previous pointer until publication succeeds: stale-pointer recovery
 * repairs the canonical job's queue or terminal source/retention handoff. Attempts
 * use their own accounting outbox and must never use this job-only transition.
 * @param {any} db
 * @param {object} input
 */
const transitionQueuedRecord = async (db, {
  targetPath,
  current = {},
  patch,
  queueKind = null,
  dueAtMs = null,
  targetId,
  additionalUpdates = {},
}) => {
  if (targetPath !== `notification_jobs_v2/${targetId}` || Object.keys(additionalUpdates).length) {
    throw new Error('Queued job transitions cannot create records or publish unrelated updates');
  }
  const nextVersion = Number(current.queueVersion || 0) + 1;
  const previousRoot = current.queueKind ? QUEUE_ROOTS[current.queueKind] : null;
  const nextRoot = queueKind ? QUEUE_ROOTS[queueKind] : null;
  const nextKey = nextRoot ? buildNotificationQueueKey(Number(dueAtMs), targetId, nextVersion) : null;
  const committed = await transactExistingRecord(db.ref(targetPath), observed => {
    if (!isDeepStrictEqual(observed, current)) return undefined;
    return { ...observed, ...patch, queueKind, queueKey: nextKey, queueVersion: nextVersion };
  });
  if (!committed.applied) throw Object.assign(new Error('Notification job changed before queue transition'), { code: 'NOTIFICATION_JOB_VERSION_CHANGED' });
  if (nextRoot && nextKey) {
    await db.ref(`${nextRoot}/${nextKey}`).transaction(entry => entry || buildQueueEntry(queueKind, targetId, Number(dueAtMs), nextVersion,
      current.serviceLane || (current.audienceType === 'marketing' ? 'marketing' : current.priorityClass === 'critical' ? 'critical' : 'operational')));
  }
  // A terminal job still needs source publication and retention scheduling.
  // Its old pointer remains the recovery outbox until the worker settles it.
  if (nextRoot && previousRoot && current.queueKey) await db.ref(`${previousRoot}/${current.queueKey}`).set(null);
  return { queueKey: nextKey, queueVersion: nextVersion };
};

/** @param {any} db @param {'fanout'|'retry'|'receipt'} kind @param {number} nowMs @param {number} limit */
const loadDueQueueEntries = async (db, kind, nowMs, limit) => {
  const upperBound = `${String(Math.max(0, Math.trunc(nowMs))).padStart(QUEUE_KEY_WIDTH, '0')}~\uf8ff`;
  const snapshot = await db.ref(QUEUE_ROOTS[kind]).orderByKey().endAt(upperBound).limitToFirst(limit).once('value');
  return Object.entries(snapshot.val() || {});
};

// Independent indexed lanes guarantee a campaign cannot occupy the complete
// recovery page ahead of safety/chat/itinerary work. Each lane gets a bounded
// third; unused capacity is deliberately not borrowed by an unbounded scan.
const loadFairDueQueueEntries = async (db, kind, nowMs, limit) => {
  const lanes = ['critical', 'operational', 'marketing'];
  const perLane = Math.max(1, Math.floor(limit / lanes.length));
  const results = [];
  for (const lane of lanes) {
    const snapshot = await db.ref(QUEUE_ROOTS[kind]).orderByChild('serviceKey')
      .startAt(`${lane}~`).endAt(`${lane}~${String(Math.trunc(nowMs)).padStart(QUEUE_KEY_WIDTH, '0')}`)
      .limitToFirst(perLane).once('value');
    results.push(...Object.entries(snapshot.val() || {}));
  }
  return results;
};

/**
 * Transactional single-owner lease. Consumers must also validate the queue
 * version against the target record before doing external work.
 * @param {any} queueRef
 * @param {number} nowMs
 * @param {number} leaseMs
 */
const claimQueueEntry = async (queueRef, nowMs, leaseMs = 2 * 60 * 1000, requestedOwnerId = null) => {
  const ownerId = requestedOwnerId || randomUUID();
  let claimed = false;
  const transaction = await transactExistingRecord(queueRef, (entry) => {
    if (!entry || Number(entry.dueAtMs || 0) > nowMs) return;
    if (entry.lease && Number(entry.lease.expiresAtMs || 0) > nowMs) return;
    claimed = true;
    return { ...entry, lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs } };
  });
  const entry = transaction?.snapshot?.val?.() || null;
  return { claimed: Boolean(transaction?.applied && claimed && entry?.lease?.ownerId === ownerId), ownerId, entry };
};

/**
 * Releases or defers only the exact queue lease owned by this worker. This
 * prevents a late worker from deleting or unlocking a newer worker's claim.
 * @param {any} queueRef
 * @param {string} ownerId
 * @param {number | null} dueAtMs
 */
const releaseClaimedQueueEntry = async (queueRef, ownerId, dueAtMs = null) => {
  let released = false;
  const transaction = await transactExistingRecord(queueRef, (entry) => {
    if (!entry || entry.lease?.ownerId !== ownerId) return;
    released = true;
    return {
      ...entry,
      ...(Number.isFinite(dueAtMs) ? { dueAtMs: Number(dueAtMs) } : {}),
      ...(Number.isFinite(dueAtMs) ? { serviceKey: `${String(entry.serviceKey || 'operational~').split('~')[0]}~${String(Math.trunc(dueAtMs)).padStart(QUEUE_KEY_WIDTH, '0')}` } : {}),
      lease: null,
    };
  });
  return { released: Boolean(released && transaction?.applied), entry: transaction?.snapshot?.val?.() || null };
};

/** @param {any} queueRef @param {string} ownerId */
const removeClaimedQueueEntry = async (queueRef, ownerId) => {
  let removed = false;
  const transaction = await transactExistingRecord(queueRef, (entry) => {
    if (!entry || entry.lease?.ownerId !== ownerId) return;
    removed = true;
    return null;
  });
  return Boolean(removed && transaction?.applied);
};

module.exports = {
  QUEUE_ROOTS,
  buildNotificationQueueKey,
  buildQueueEntry,
  claimQueueEntry,
  loadDueQueueEntries,
  loadFairDueQueueEntries,
  releaseClaimedQueueEntry,
  removeClaimedQueueEntry,
  transitionQueuedRecord,
};
