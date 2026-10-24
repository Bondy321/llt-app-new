'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');
const { attemptCountShape } = require('./notificationAttemptCounts');
const { QUEUE_ROOTS, buildNotificationQueueKey, buildQueueEntry } = require('./notificationQueues');

const ACCOUNTING_ROOT = 'notification_attempt_accounting_v2';
const ACCOUNTING_SHARDS = 256;
const MAX_SHARD_ATTEMPTS = 1024;
// Stable v2 wire order: avoid repeating seven long field names in every ledger
// contribution and all 256 job summaries on every transition.
const COUNT_KEYS = Object.freeze(Object.keys(attemptCountShape(null)));
const shardFor = (attemptId) => createHash('sha256').update(attemptId).digest('hex').slice(0, 2);
const fail = (code) => Object.assign(new Error(code), { code });
const owner = (attempt, field) => attempt?.[field]?.ownerId || null;
const sameVersion = (actual, expected) => actual && expected
  && actual.jobId === expected.jobId
  && Number(actual.generation || 1) === Number(expected.generation || 1)
  && Number(actual.queueVersion || 0) === Number(expected.queueVersion || 0)
  && actual.status === expected.status
  && owner(actual, 'submissionLease') === owner(expected, 'submissionLease')
  && owner(actual, 'retryLease') === owner(expected, 'retryLease');

// Each bounded shard retains the latest contribution/version of its attempts.
// The job stores at most 256 aggregate summaries, never a recipient-sized map.
// Replaying any publication, including a delayed older one, cannot add a delta
// twice. The hard shard cap bounds transaction payloads even for hostile input.
const publishAttemptAccounting = async (db, attempt) => {
  const shardId = shardFor(attempt.attemptId);
  const shape = attemptCountShape(attempt);
  const contribution = COUNT_KEYS.map(key => shape[key] - Number(attempt.accountingBaseline?.[key] || 0));
  const version = Number(attempt.queueVersion);
  const shardRef = db.ref(`${ACCOUNTING_ROOT}/${attempt.jobId}/${shardId}`);
  const result = await shardRef.transaction((current) => {
    if (current?.retired === true) return undefined;
    const previous = current?.attempts?.[attempt.attemptId];
    if (Number(previous?.v || 0) >= version) return current;
    const attempts = { ...(current?.attempts || {}) };
    if (!previous && Object.keys(attempts).length >= MAX_SHARD_ATTEMPTS) throw fail('ACCOUNTING_SHARD_FULL');
    const counts = contribution.map((value, index) => Number(current?.c?.[index] || 0)
      + value - Number(previous?.c?.[index] || 0));
    attempts[attempt.attemptId] = { v: version, c: contribution };
    return { schemaVersion: 2, revision: Number(current?.revision || 0) + 1, c: counts, attempts };
  }, undefined, false);
  const shard = result.snapshot.val();
  if (!result.committed || !shard || shard.retired) throw fail('ACCOUNTING_RETIRED');
  const published = await transactExistingRecord(db.ref(`notification_jobs_v2/${attempt.jobId}`), (job) => {
    const previous = job.attemptAccounting?.[shardId];
    if (Number(previous?.revision || 0) >= shard.revision) return job;
    const counts = { ...(job.counts || {}) };
    COUNT_KEYS.forEach((key, index) => {
      counts[key] = Number(counts[key] || 0) + Number(shard.c[index]) - Number(previous?.c?.[index] || 0);
    });
    return { ...job, counts, attemptAccounting: {
      ...(job.attemptAccounting || {}), [shardId]: { revision: shard.revision, c: shard.c },
    } };
  });
  if (!published.applied) throw fail('ACCOUNTING_JOB_MISSING');
};

// The attempt is the durable publication outbox. Its former queue pointer is
// not removed until the replacement exists. A crash at any await is repaired
// by the retained queue or the replayed audience page, before advancing again.
const resumeAttemptPublication = async (db, attempt) => {
  if (!attempt?.publicationPending) return attempt;
  if (attempt.queueKind && attempt.queueKey) {
    await db.ref(`${QUEUE_ROOTS[attempt.queueKind]}/${attempt.queueKey}`).transaction((entry) => entry
      || buildQueueEntry(attempt.queueKind, attempt.attemptId, attempt.queueDueAtMs, attempt.queueVersion, attempt.serviceLane));
  }
  await publishAttemptAccounting(db, attempt);
  const previous = attempt.publicationPending;
  if (previous.queueKind && previous.queueKey && previous.queueKey !== attempt.queueKey) {
    await db.ref(`${QUEUE_ROOTS[previous.queueKind]}/${previous.queueKey}`).set(null);
  }
  const finished = await transactExistingRecord(db.ref(`notification_delivery_attempts_v2/${attempt.attemptId}`), (current) => {
    if (!sameVersion(current, attempt)) return undefined;
    return { ...current, publicationPending: null };
  });
  if (!finished.applied) throw fail('ATTEMPT_VERSION_CHANGED');
  return finished.snapshot.val();
};

const commitAttemptTransition = async (db, attemptId, expected, patch, queueKind, dueAtMs) => {
  if (expected.publicationPending) expected = await resumeAttemptPublication(db, expected);
  const nextVersion = Number(expected.queueVersion || 0) + 1;
  const queueKey = queueKind ? buildNotificationQueueKey(dueAtMs, attemptId, nextVersion) : null;
  const result = await transactExistingRecord(db.ref(`notification_delivery_attempts_v2/${attemptId}`), (current) => {
    if (!sameVersion(current, expected) || current.publicationPending) return undefined;
    return { ...current, ...patch, attemptId, queueKind, queueKey,
      accountingBaseline: current.accountingBaseline || (current.countsPublished === false ? attemptCountShape(null) : attemptCountShape(current)),
      queueDueAtMs: queueKind ? dueAtMs : null, queueVersion: nextVersion,
      publicationPending: { queueKind: current.queueKind || null, queueKey: current.queueKey || null },
    };
  });
  if (!result.applied) throw fail('ATTEMPT_VERSION_CHANGED');
  return resumeAttemptPublication(db, result.snapshot.val());
};

module.exports = { ACCOUNTING_ROOT, ACCOUNTING_SHARDS, MAX_SHARD_ATTEMPTS,
  commitAttemptTransition, publishAttemptAccounting, resumeAttemptPublication, sameVersion, shardFor };
