'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('Loopback RTDB emulator required; this suite must never silently skip');
}
const projectId = 'demo-llt-notification-publication';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const worker = require('../functions/src/domains/notifications/notificationWorker');
const publication = require('../functions/src/domains/notifications/notificationAttemptPublication');
const { reserveProviderBudget } = require('../functions/src/domains/notifications/notificationProviderBudget');
const { transitionQueuedRecord } = require('../functions/src/domains/notifications/notificationQueues');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const fixtureApp = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'notification-fixtures');
const db = fixtureApp.database();
const now = 1_800_000_000_000;
const job = { jobId: 'synthetic_job', counts: {}, status: 'fanout_in_progress', expiresAtMs: now + 86400000 };
const recipient = { authUid: 'synthetic_device', tokenHash: 'synthetic_hash', token: 'ExponentPushToken[synthetic]' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const value = async path => (await db.ref(path).get()).val();
let sequence = 0;
const cold = async callback => {
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `notification-cold-${++sequence}`);
  try { return await callback(app.database()); } finally { await app.delete(); }
};
test.before(async () => installDemoDatabaseRules({ projectId }));
test.beforeEach(async () => { await db.ref().set(null); await db.ref(`notification_jobs_v2/${job.jobId}`).set(job); });
test.after(async () => Promise.all(admin.apps.map(app => app.delete())));

test('cold SDK transitions and duplicate publication preserve exact counters and queues', async () => {
  const claimed = await cold(database => worker.claimDeliveryAttempt(database, job, recipient, now));
  assert.equal(claimed.claimed, true);
  const original = await value(`notification_delivery_attempts_v2/${claimed.attemptId}`);
  const advanced = await cold(database => worker.transitionDeliveryAttempt(database, claimed.attemptId, original,
    { status: 'request_started', requestStartedAtMs: now }, now));
  await assert.rejects(cold(database => worker.transitionDeliveryAttempt(database, claimed.attemptId, original,
    { countsPublished: true }, now)), { code: 'ATTEMPT_VERSION_CHANGED' });
  await cold(database => worker.persistTicketResult({ db: database, job,
    claimed: { attemptId: claimed.attemptId, attemptRef: database.ref(`notification_delivery_attempts_v2/${claimed.attemptId}`), attempt: advanced },
    recipient, ticket: { status: 'ok', id: 'synthetic_ticket' }, nowMs: now }));
  const counts = await value(`notification_jobs_v2/${job.jobId}/counts`);
  assert.equal(counts.retrying, 0); assert.equal(counts.receiptPending, 1); assert.equal(counts.ticketAccepted, 1);
  await cold(database => publication.publishAttemptAccounting(database, original));
  assert.deepEqual(await value(`notification_jobs_v2/${job.jobId}/counts`), counts);
  assert.equal(await value('notification_attempt_retry_queue_v2'), null);
  assert.equal(Object.keys(await value('notification_receipt_due_queue_v2')).length, 1);
});

test('real offline queued old CAS cannot overwrite a successor after reconnect', async () => {
  const claimed = await cold(database => worker.claimDeliveryAttempt(database, job, recipient, now));
  const original = await value(`notification_delivery_attempts_v2/${claimed.attemptId}`);
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'queued-old-attempt');
  const oldDb = app.database(); const entered = deferred(); let intercepted = false;
  const wrapped = { ref(path = '') {
    const ref = oldDb.ref(path);
    if (path === `notification_delivery_attempts_v2/${claimed.attemptId}`) {
      const transaction = ref.transaction.bind(ref);
      ref.transaction = (...args) => {
        if (!intercepted) { intercepted = true; oldDb.goOffline(); entered.resolve(); }
        return transaction(...args);
      };
    }
    return ref;
  } };
  const oldWork = worker.transitionDeliveryAttempt(wrapped, claimed.attemptId, original,
    { countsPublished: true }, now);
  const observed = oldWork.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const successor = await cold(database => worker.transitionDeliveryAttempt(database, claimed.attemptId, original,
    { status: 'request_started', requestStartedAtMs: now + 1 }, now + 1));
  const before = await value(`notification_delivery_attempts_v2/${claimed.attemptId}`);
  oldDb.goOnline();
  assert.equal((await observed).error?.code, 'ATTEMPT_VERSION_CHANGED');
  assert.deepEqual(await value(`notification_delivery_attempts_v2/${claimed.attemptId}`), before);
  assert.equal(successor.status, 'request_started');
  assert.equal((await value(`notification_jobs_v2/${job.jobId}/counts`)).retrying, 1);
  await app.delete();
});

test('retired shard rejects a cold delayed publisher without recreating recipient data', async () => {
  const claimed = await cold(database => worker.claimDeliveryAttempt(database, job, recipient, now));
  const path = `${publication.ACCOUNTING_ROOT}/${job.jobId}/${publication.shardFor(claimed.attemptId)}`;
  await db.ref(path).set({ retired: true });
  await assert.rejects(cold(database => publication.publishAttemptAccounting(database, claimed.attempt)), { code: 'ACCOUNTING_RETIRED' });
  assert.deepEqual(await value(path), { retired: true });
});

for (const kind of ['successor', 'retention']) test(`real offline job expiry CAS preserves a newer ${kind}`, async () => {
  const path = `notification_jobs_v2/${job.jobId}`;
  const captured = await value(path);
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `old-job-${kind}`);
  const oldDb = app.database(); const queued = deferred(); let intercepted = false;
  const wrapped = { ref(refPath) {
    const ref = oldDb.ref(refPath); const transaction = ref.transaction.bind(ref);
    ref.transaction = (...args) => {
      if (!intercepted && refPath === path) { intercepted = true; oldDb.goOffline(); queued.resolve(); }
      return transaction(...args);
    };
    return ref;
  } };
  const work = transitionQueuedRecord(wrapped, { targetPath: path, current: captured,
    patch: { status: 'expired', lease: null }, targetId: job.jobId });
  const outcome = work.then(() => null, error => error);
  await queued.promise;
  const newer = { ...captured, ...(kind === 'successor'
    ? { status: 'receipt_pending', counts: { ticketAccepted: 1 }, lease: { ownerId: 'new-worker' } }
    : { retentionGeneration: 2, retentionFence: { fenceId: 'compactor-owner', generation: 2 } }) };
  await db.ref(path).set(newer);
  oldDb.goOnline();
  assert.equal((await outcome)?.code, 'NOTIFICATION_JOB_VERSION_CHANGED');
  assert.deepEqual(await value(path), newer);
  assert.equal(await value('notification_job_fanout_queue_v2'), null);
  await app.delete();
});

test('cold independent workers share one aggregate provider budget', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => cold(database => reserveProviderBudget({ db: database, count: 100, nowMs: now }))));
  assert.equal(results.filter(result => result.granted).length, 5);
  assert.equal((await cold(database => reserveProviderBudget({ db: database, count: 1, nowMs: now + 1000 }))).granted, false);
});
