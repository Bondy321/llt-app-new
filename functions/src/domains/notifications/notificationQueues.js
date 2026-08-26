'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');

const QUEUE_ROOTS = Object.freeze({
  fanout: 'notification_job_fanout_queue',
  retry: 'notification_attempt_retry_queue',
  receipt: 'notification_receipt_due_queue',
});
const QUEUE_KEY_WIDTH = 13;

/** @param {number} dueAtMs @param {string} targetId @param {number} version */
const buildNotificationQueueKey = (dueAtMs, targetId, version = 1) => {
  const due = Math.max(0, Math.trunc(Number(dueAtMs) || 0));
  const digest = createHash('sha256').update(String(targetId)).digest('hex').slice(0, 32);
  return `${String(due).padStart(QUEUE_KEY_WIDTH, '0')}~${digest}~${String(Math.max(1, version)).padStart(6, '0')}`;
};

/** @param {'fanout'|'retry'|'receipt'} kind @param {string} targetId @param {number} dueAtMs @param {number} version */
const buildQueueEntry = (kind, targetId, dueAtMs, version = 1) => ({
  schemaVersion: 1,
  kind,
  targetId,
  dueAtMs,
  version,
  createdAtMs: Date.now(),
});

/**
 * Atomically removes the prior queue pointer, writes the target patch, and adds
 * the next queue pointer. Stale queue entries are harmless because consumers
 * compare the stored target version and queue key before claiming work.
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
  const nextVersion = Number(current.queueVersion || 0) + 1;
  const previousRoot = current.queueKind ? QUEUE_ROOTS[current.queueKind] : null;
  const nextRoot = queueKind ? QUEUE_ROOTS[queueKind] : null;
  const nextKey = nextRoot ? buildNotificationQueueKey(Number(dueAtMs), targetId, nextVersion) : null;
  const updates = { ...additionalUpdates };
  if (previousRoot && current.queueKey) updates[`${previousRoot}/${current.queueKey}`] = null;
  Object.entries({
    ...patch,
    queueKind,
    queueKey: nextKey,
    queueVersion: nextVersion,
  }).forEach(([key, value]) => { updates[`${targetPath}/${key}`] = value; });
  if (nextRoot && nextKey) {
    updates[`${nextRoot}/${nextKey}`] = buildQueueEntry(queueKind, targetId, Number(dueAtMs), nextVersion);
  }
  await db.ref().update(updates);
  return { queueKey: nextKey, queueVersion: nextVersion };
};

/** @param {any} db @param {'fanout'|'retry'|'receipt'} kind @param {number} nowMs @param {number} limit */
const loadDueQueueEntries = async (db, kind, nowMs, limit) => {
  const upperBound = `${String(Math.max(0, Math.trunc(nowMs))).padStart(QUEUE_KEY_WIDTH, '0')}~\uf8ff`;
  const snapshot = await db.ref(QUEUE_ROOTS[kind]).orderByKey().endAt(upperBound).limitToFirst(limit).once('value');
  return Object.entries(snapshot.val() || {});
};

/**
 * Transactional single-owner lease. Consumers must also validate the queue
 * version against the target record before doing external work.
 * @param {any} queueRef
 * @param {number} nowMs
 * @param {number} leaseMs
 */
const claimQueueEntry = async (queueRef, nowMs, leaseMs = 2 * 60 * 1000) => {
  const ownerId = randomUUID();
  let claimed = false;
  const transaction = await queueRef.transaction((entry) => {
    if (!entry || Number(entry.dueAtMs || 0) > nowMs) return;
    if (entry.lease && Number(entry.lease.expiresAtMs || 0) > nowMs) return;
    claimed = true;
    return { ...entry, lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs } };
  });
  const entry = transaction?.snapshot?.val?.() || null;
  return { claimed: Boolean(claimed && entry?.lease?.ownerId === ownerId), ownerId, entry };
};

module.exports = {
  QUEUE_ROOTS,
  buildNotificationQueueKey,
  buildQueueEntry,
  claimQueueEntry,
  loadDueQueueEntries,
  transitionQueuedRecord,
};
