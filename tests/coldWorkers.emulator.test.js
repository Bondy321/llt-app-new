'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A local Realtime Database emulator is required');
}
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || '')) {
  throw new Error('A local Auth emulator is required');
}
const projectId = 'demo-llt-cold-workers';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId,
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`, storageBucket: `${projectId}.appspot.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const queues = require('../functions/src/domains/notifications/notificationQueues');
const jobs = require('../functions/src/domains/notifications/notificationJobs');
const worker = require('../functions/src/domains/notifications/notificationWorker');
const receipts = require('../functions/src/domains/notifications/notificationReceipts');
const notificationAdmin = require('../functions/src/domains/notifications/notificationAdminFunctions');
const coordination = require('../functions/src/domains/account-deletion/accountDeletionCoordination');
const deletion = require('../functions/src/domains/account-deletion/accountDeletionWorker');
const { reserveAccountDeletion, retryAccountDeletionJob } = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const { buildPassengerSessionRecord } = require('../functions/lib/appSession');
const { deriveAccountDeletionId, derivePassengerAccountDeletionKey, deriveUidAccountDeletionTombstoneKey } = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const { hashPushToken } = require('../functions/src/domains/notifications/notificationAudiencePage');
const { NOTIFICATION_TYPES } = require('../functions/src/domains/notifications/notificationDeliveryPolicy');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'cold-workers-writer');
const db = writer.database();
const NOW = Date.now();
let counter = 0;
// Genuine Admin SDK connection and transaction protocol. A one-off bounded query
// is deliberately not kept subscribed; it does not retain the worker's cache.
const cold = async operation => {
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `cold-workers-${++counter}`);
  const observations = new Map();
  const database = { app, ref(path = '') {
    const ref = path ? app.database().ref(path) : app.database().ref();
    const transact = ref.transaction.bind(ref);
    ref.transaction = (update, ...args) => transact(current => {
      if (!observations.has(path)) observations.set(path, current === null);
      return update(current);
    }, ...args);
    return ref;
  } };
  try { return await operation(database, observations); } finally { await app.delete(); }
};
const value = async path => (await db.ref(path).get()).val();
test.before(async () => installDemoDatabaseRules({ projectId }));
test.beforeEach(async () => db.ref().set(null));
test.after(async () => Promise.all(admin.apps.map(app => app.delete())));

test('cold queue after actual one-off due query claims, releases and removes only its exact owner', async () => {
  const key = queues.buildNotificationQueueKey(NOW, 'synthetic', 1);
  const path = `${queues.QUEUE_ROOTS.fanout}/${key}`;
  await db.ref(path).set(queues.buildQueueEntry('fanout', 'synthetic', NOW, 1));
  await cold(async (database, observations) => {
    assert.equal((await queues.loadDueQueueEntries(database, 'fanout', NOW, 10)).length, 1);
    const claim = await queues.claimQueueEntry(database.ref(path), NOW, 1000, 'worker-a');
    assert.equal(observations.get(path), true);
    assert.equal(claim.claimed, true);
  });
  await cold(async database => {
    assert.equal((await queues.claimQueueEntry(database.ref(path), NOW, 1000, 'worker-b')).claimed, false);
    assert.equal((await queues.releaseClaimedQueueEntry(database.ref(path), 'worker-b')).released, false);
    assert.equal(await queues.removeClaimedQueueEntry(database.ref(path), 'worker-b'), false);
    assert.equal((await queues.releaseClaimedQueueEntry(database.ref(path), 'worker-a', NOW + 100)).released, true);
  });
  await cold(async database => {
    assert.equal((await queues.claimQueueEntry(database.ref(path), NOW, 1000, 'worker-b')).claimed, false);
    assert.equal((await queues.claimQueueEntry(database.ref(path), NOW + 100, 1000, 'worker-b')).claimed, true);
    assert.equal(await queues.removeClaimedQueueEntry(database.ref(path), 'worker-a'), false);
    assert.equal(await queues.removeClaimedQueueEntry(database.ref(path), 'worker-b'), true);
    assert.equal(await queues.removeClaimedQueueEntry(database.ref(path), 'worker-b'), false);
    assert.equal((await queues.claimQueueEntry(database.ref(path), NOW, 1000, 'worker-a')).claimed, false);
  });
  assert.equal(await value(path), null);
});

test('cold deletion claims and progress require an existing due exact phase/revision/owner', async () => {
  const id = 'synthetic'; const jobPath = `account_deletion_jobs/v1/${id}`;
  await db.ref().update({ [`account_deletion_queue/v1/${id}`]: { deletionId: id, dueAtMs: NOW },
    [jobPath]: { status: 'pending', phase: 'reserved', availableAtMs: NOW, leaseRevision: 0 } });
  const lease = await cold(async (database, observations) => {
    await database.ref('account_deletion_queue/v1').orderByChild('dueAtMs').endAt(NOW).limitToFirst(10).once('value');
    assert.equal((await coordination.claimAccountDeletionQueueEntry({ db: database, deletionId: id, nowMs: NOW, ownerId: 'a' })).claimed, true);
    const result = await coordination.acquireAccountDeletionJobLease({ db: database, deletionId: id, nowMs: NOW, ownerId: 'a' });
    assert.equal(observations.get(jobPath), true); assert.equal(result.acquired, true);
    return { ownerId: 'a', revision: result.revision, phase: 'reserved', clock: () => NOW };
  });
  await cold(async database => {
    assert.equal((await coordination.acquireAccountDeletionJobLease({ db: database, deletionId: id, nowMs: NOW, ownerId: 'b' })).acquired, false);
    assert.equal(await deletion.commitLeasedJobProgress({ ref: database.ref(jobPath), lease: { ...lease, ownerId: 'b' }, expectedPhase: 'reserved', next: 'live_state_cleanup', nowMs: NOW }), false);
    assert.equal(await deletion.commitLeasedJobProgress({ ref: database.ref(jobPath), lease, expectedPhase: 'reserved', next: 'live_state_cleanup', nowMs: NOW }), true);
    assert.equal(await deletion.commitLeasedJobProgress({ ref: database.ref(jobPath), lease, expectedPhase: 'reserved', next: 'group_media', nowMs: NOW }), false);
  });
  await db.ref(jobPath).remove();
  await cold(async database => {
    assert.equal((await coordination.acquireAccountDeletionJobLease({ db: database, deletionId: id, nowMs: NOW, ownerId: 'a' })).acquired, false);
    assert.equal(await deletion.commitLeasedJobProgress({ ref: database.ref(jobPath), lease, expectedPhase: 'reserved', next: 'live_state_cleanup', nowMs: NOW }), false);
  });
  assert.equal(await value(jobPath), null);
});

test('cold driver authority removal counts only the expected owner and preserves successor', async () => {
  const path = 'drivers/D-SYNTHETIC/authUid';
  await db.ref(path).set('old');
  await cold(async (database, observations) => {
    assert.equal(await deletion.releaseOwnedDriverAuthority({ db: database, scope: { driverId: 'D-SYNTHETIC', authUid: 'old' } }), 1);
    assert.equal(observations.get(path), true);
    assert.equal(await deletion.releaseOwnedDriverAuthority({ db: database, scope: { driverId: 'D-SYNTHETIC', authUid: 'old' } }), 0);
  });
  await db.ref(path).set('successor');
  await cold(async database => assert.equal(await deletion.releaseOwnedDriverAuthority({ db: database, scope: { driverId: 'D-SYNTHETIC', authUid: 'old' } }), 0));
  assert.equal(await value(path), 'successor');
});

test('cold missing/future/foreign-owned jobs are never acquired and concurrent workers have one winner', async () => {
  const path = 'notification_jobs_v2/synthetic';
  for (const source of [null,
    { jobId: 'synthetic', status: 'queued', expiresAtMs: NOW + 100_000, availableAtMs: NOW + 1000 },
    { jobId: 'synthetic', status: 'queued', expiresAtMs: NOW + 100_000, lease: { ownerId: 'other', expiresAtMs: NOW + 1000 } }]) {
    await db.ref(path).set(source);
    await cold(async database => assert.equal((await jobs.acquireNotificationJobLease({ jobRef: database.ref(path), nowMs: NOW, ownerId: 'requester' })).acquired, false));
    assert.deepEqual(await value(path), source);
  }
  await db.ref(path).set({ jobId: 'synthetic', status: 'queued', expiresAtMs: NOW + 100_000 });
  const winners = await Promise.all(['a', 'b'].map(ownerId => cold(database => jobs.acquireNotificationJobLease({ jobRef: database.ref(path), nowMs: NOW, ownerId }))));
  assert.equal(winners.filter(result => result.acquired).length, 1);
  const winning = await value(path);
  await cold(async database => {
    assert.equal(await worker.renewNotificationJobSubmissionFence({ jobRef: database.ref(path), leaseOwnerId: 'stale', nowMs: NOW }), false);
    assert.equal((await worker.commitNotificationAudiencePage(database.ref(path), { pageId: 'stale-page', expectedCursor: null, nextCursor: null, increments: {}, skipReasons: {}, leaseOwnerId: 'stale', nowMs: NOW })).committed, false);
  });
  assert.deepEqual(await value(path), winning);
});

test('cold manual deletion retry repairs the exact existing job and barrier without manufacturing missing work', async () => {
  const id = 'synthetic'; const path = `account_deletion_jobs/v1/${id}`;
  await db.ref().update({ [path]: { deletionId: id, status: 'requires_attention', retryable: true, phase: 'reserved', privateScope: { authUid: 'synthetic' } },
    'account_deletion_active/v1/synthetic': { deletionId: id, status: 'requires_attention' } });
  await cold(async database => assert.equal((await retryAccountDeletionJob({ db: database, deletionId: id, nowMs: NOW })).outcome, 'queued'));
  assert.equal((await value(path)).status, 'pending');
  assert.equal((await value(`account_deletion_queue/v1/${id}`)).dueAtMs, NOW);
  assert.equal((await value('account_deletion_active/v1/synthetic')).status, 'pending');
  await cold(async database => assert.equal((await retryAccountDeletionJob({ db: database, deletionId: 'missing', nowMs: NOW })).outcome, 'unavailable'));
  assert.equal(await value('account_deletion_jobs/v1/missing'), null);
});

test('cold deletion failure and completion fences reject a stale revision and preserve successor work', async () => {
  const id = 'synthetic'; const path = `account_deletion_jobs/v1/${id}`;
  const current = { status: 'pending', phase: 'auth_delete', leaseRevision: 2,
    lease: { ownerId: 'successor', phase: 'auth_delete', expiresAtMs: NOW + 100_000 },
    privateScope: { authUid: 'synthetic', principalType: 'driver' } };
  await db.ref(path).set(current);
  const lease = { ownerId: 'old', revision: 1, phase: 'auth_delete', clock: () => NOW };
  await cold(async database => {
    assert.equal((await deletion.recordAccountDeletionFailure({ db: database, ref: database.ref(path), deletionId: id,
      lease, error: { code: 'SYNTHETIC_FAILURE' }, nowMs: NOW })).recorded, false);
    await assert.rejects(deletion.finalizeCompletedAccountDeletion({ db: database, deletionId: id,
      lease, job: current, nowMs: NOW }), error => error.code === 'ACCOUNT_DELETION_FINALIZATION_CHANGED');
  });
  assert.deepEqual(await value(path), current);
  assert.equal(await value(`account_deletion_completion_tombstones/v1/${id}`), null);
});

const notificationFixture = async () => {
  const uid = 'synthetic-notification'; const token = 'ExponentPushToken[synthetic-cold-worker]';
  const session = buildPassengerSessionRecord({ authUid: uid, principalId: `pax_v2_${'b'.repeat(32)}`, tourId: 'SYNTHETIC_TOUR', sessionId: `sess_v1_${'a'.repeat(32)}`, nowMs: NOW - 100, expiresAtMs: NOW + 86_400_000 });
  await db.ref().update({ [`app_sessions/${uid}`]: session,
    [`app_session_authority/${uid}`]: { schemaVersion: 1, state: 'committed', sessionId: session.sessionId, epoch: 'a'.repeat(48) },
    [`tours/SYNTHETIC_TOUR/participants/${uid}`]: { schemaVersion: 2, sessionId: session.sessionId,
      userId: uid, principalId: session.principalId, sessionExpiresAtMs: session.expiresAtMs },
    [`users/${uid}`]: { principalType: 'passenger', tourId: 'SYNTHETIC_TOUR', stablePassengerId: session.principalId,
      identityVersion: 'pax_v2', bookingRef: 'SYNTHETIC-COLD' },
    'bookings/SYNTHETIC-COLD': { tourId: 'SYNTHETIC_TOUR' },
    'passenger_identity_security/SYNTHETIC-COLD': { deviceAuthorizationVersion: 2,
      passengerPrincipalId: session.principalId, authorizedAuthUids: { [uid]: true } },
    [`notification_devices/${uid}`]: { pushToken: token, tokenHash: hashPushToken(token), status: 'active', permissionState: 'granted', platform: 'ios', operationalEligible: true, operationalTourId: session.tourId, operationalSessionId: session.sessionId, operationalSessionRevision: session.sessionRevision, registrationRevision: 1 },
    'notification_migrations/device_registry_v1': { legacyFallbackEnabled: false } });
  const job = jobs.createNotificationJobRecord({ notificationType: NOTIFICATION_TYPES.GROUP_CHAT,
    sourceType: 'synthetic', sourceId: 'cold', audienceType: 'tour', tourId: 'SYNTHETIC_TOUR',
    presentation: { title: 'Synthetic', body: 'Synthetic' }, navigation: {}, nowMs: NOW });
  await cold(database => jobs.enqueueNotificationJob({ db: database, job }));
  return job;
};

test('cold fanout, transient-ticket retry and receipts complete exactly once across fresh Admin apps', async () => {
  const job = await notificationFixture(); let sends = 0;
  const expo = { chunkPushNotifications: messages => messages.length ? [messages] : [], sendPushNotificationsAsync: async () => {
    sends += 1; return sends === 1 ? [{ status: 'error', details: { error: 'MessageRateExceeded' } }] : [{ status: 'ok', id: 'synthetic-ticket' }];
  }, getPushNotificationReceiptsAsync: async () => ({ 'synthetic-ticket': { status: 'ok' } }) };
  for (let page = 0; page < 4; page += 1) await cold(async database => {
    const due = await queues.loadDueQueueEntries(database, 'fanout', NOW, 10);
    for (const [key] of due) {
      const claim = await queues.claimQueueEntry(database.ref(`${queues.QUEUE_ROOTS.fanout}/${key}`), NOW);
      if (!claim.claimed) continue;
      await worker.runNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW, queueKey: key, queueVersion: claim.entry.version, queueOwnerId: claim.ownerId, queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs, expo });
    }
  });
  assert.equal(sends, 1, 'one initial fanout submission');
  await cold(async database => assert.equal((await receipts.retryDueNotificationAttempts({ db: database, nowMs: NOW + 60_000, expo })).retried, 1));
  assert.equal(sends, 2);
  await cold(async database => assert.equal((await receipts.processDueNotificationReceipts({ db: database, nowMs: NOW + 1_000_000, expo })).accepted, 1));
  await cold(database => receipts.retryDueNotificationAttempts({ db: database, nowMs: NOW + 1_000_001, expo }));
  await cold(database => receipts.processDueNotificationReceipts({ db: database, nowMs: NOW + 1_000_001, expo }));
  assert.equal(sends, 2, 'duplicate workers cannot resubmit completed attempts');
  assert.equal((await value(`notification_jobs_v2/${job.jobId}`)).status, 'provider_accepted');
});

test('cold audience preview and manual retry complete their continuation without duplicate attempts', async () => {
  const job = await notificationFixture(); const uid = 'synthetic-notification';
  const terminal = { ...job, status: 'provider_rejected', completedAtMs: NOW - 100,
    fanoutCompletedAtMs: NOW - 100, queueKey: null, queueKind: null, lease: null };
  const attemptId = 'synthetic-old-attempt';
  await db.ref().update({ [`notification_jobs_v2/${job.jobId}`]: terminal,
    [`notification_job_recipients_v2/${job.jobId}/${uid}`]: { generation: 1, attemptId },
    [`notification_delivery_attempts_v2/${attemptId}`]: { attemptId, jobId: job.jobId, generation: 1,
      recipientUid: uid, installationUid: uid, tokenHash: hashPushToken('ExponentPushToken[synthetic-cold-worker]'),
      status: 'provider_rejected', ticketStatus: 'ticket_accepted', receiptStatus: 'provider_rejected' },
    'notification_audience_previews_v2/synthetic': { ownerAuthUid: 'synthetic-admin', job, status: 'processing',
      expiresAtMs: NOW + 60_000, pages: 0, audience: 0, eligible: 0, skipped: 0 } });
  await cold(async database => {
    const result = await notificationAdmin.processAudiencePreviewChunk(database, 'synthetic', 'synthetic-admin', NOW);
    assert.equal(result.complete, true); assert.equal(result.eligible, 1);
  });
  await cold(async database => {
    const result = await notificationAdmin.requeueFailedNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW });
    assert.equal(result.success, true); assert.equal(result.complete, true); assert.equal(result.requeued, 1);
  });
  const attempts = await value('notification_delivery_attempts_v2');
  await cold(async database => {
    const result = await notificationAdmin.requeueFailedNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW + 1 });
    assert.equal(result.complete, true); assert.equal(result.requeued, 1);
  });
  assert.deepEqual(await value('notification_delivery_attempts_v2'), attempts);
});

const enqueueEmptyJob = async sourceId => {
  const job = jobs.createNotificationJobRecord({ notificationType: NOTIFICATION_TYPES.GROUP_CHAT,
    sourceType: 'synthetic', sourceId, audienceType: 'tour', tourId: 'SYNTHETIC_TOUR',
    presentation: { title: 'Synthetic', body: 'Synthetic' }, navigation: {}, nowMs: NOW });
  await jobs.enqueueNotificationJob({ db, job });
  return value(`notification_jobs_v2/${job.jobId}`);
};

test('a failed old fanout worker cannot requeue or expire a successor lease', async () => {
  for (const useQueue of [false, true]) {
    const job = await enqueueEmptyJob(`stale-${useQueue}`); let successor;
    await cold(async database => {
      const originalRef = database.ref.bind(database);
      database.ref = (path = '') => {
        const ref = originalRef(path);
        if (path === 'notification_devices') ref.orderByChild = () => ({ startAt: () => ({ endAt: () => ({ limitToFirst: () => ({ once: async () => {
          successor = { ...(await value(`notification_jobs_v2/${job.jobId}`)),
            lease: { ownerId: 'synthetic-successor', acquiredAtMs: NOW, expiresAtMs: NOW + 120_000 } };
          await db.ref(`notification_jobs_v2/${job.jobId}`).set(successor);
          throw new Error('Synthetic worker dependency failure after lease replacement');
        } }) }) }) });
        return ref;
      };
      const claim = useQueue ? await queues.claimQueueEntry(database.ref(`${queues.QUEUE_ROOTS.fanout}/${job.queueKey}`), NOW) : null;
      const result = await worker.runNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW,
        ...(claim ? { queueKey: job.queueKey, queueVersion: job.queueVersion, queueOwnerId: claim.ownerId,
          queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs } : {}),
        expo: { chunkPushNotifications: () => [] } });
      assert.equal(result.status, 'lease_lost');
    });
    assert.deepEqual(await value(`notification_jobs_v2/${job.jobId}`), successor);
  }
});

test('cold retry pointer handoff survives a crash after the job CAS and before queue publication', async () => {
  const job = await enqueueEmptyJob('retry-handoff');
  const oldPath = `${queues.QUEUE_ROOTS.fanout}/${job.queueKey}`;
  await cold(async database => {
    const originalRef = database.ref.bind(database);
    database.ref = (path = '') => {
      const ref = originalRef(path);
      if (path === 'notification_devices') ref.orderByChild = () => ({ startAt: () => ({ endAt: () => ({ limitToFirst: () => ({ once: async () => { throw new Error('Synthetic pre-provider worker failure'); } }) }) }) });
      if (path.startsWith(`${queues.QUEUE_ROOTS.fanout}/`) && path !== oldPath) {
        ref.transaction = async () => { throw new Error('Synthetic queue publication crash'); };
      }
      return ref;
    };
    const claim = await queues.claimQueueEntry(database.ref(oldPath), NOW);
    await assert.rejects(worker.runNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW,
      queueKey: job.queueKey, queueVersion: job.queueVersion, queueOwnerId: claim.ownerId,
      queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs, expo: { chunkPushNotifications: () => [] } }), /Synthetic queue publication crash/u);
  });
  const pending = await value(`notification_jobs_v2/${job.jobId}`);
  assert.equal(pending.status, 'queued'); assert.notEqual(pending.queueKey, job.queueKey);
  assert.ok(await value(oldPath), 'old pointer remains a durable crash-recovery continuation');
  await cold(async database => {
    const claim = await queues.claimQueueEntry(database.ref(oldPath), NOW + 121_000);
    assert.equal(claim.claimed, true);
    await worker.runNotificationJob({ db: database, jobId: job.jobId, nowMs: NOW + 121_000,
      queueKey: job.queueKey, queueVersion: job.queueVersion, queueOwnerId: claim.ownerId,
      queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs });
  });
  assert.equal(await value(oldPath), null);
  assert.ok(await value(`${queues.QUEUE_ROOTS.fanout}/${pending.queueKey}`));
  assert.deepEqual(await value(`notification_jobs_v2/${job.jobId}`), pending);
});

test('cold deletion completes all phases while preserving roster, siblings and permanent fences', async () => {
  const uid = 'synthetic-deleting'; const sibling = 'synthetic-sibling'; const principal = `pax_v2_${'c'.repeat(32)}`;
  const sessionId = `sess_v1_${'d'.repeat(32)}`; const booking = 'SYNTHETIC_BOOKING'; const tour = 'SYNTHETIC_TOUR';
  const receipt = `delrec_v1_${'e'.repeat(64)}`; const id = deriveAccountDeletionId(receipt);
  const session = buildPassengerSessionRecord({ authUid: uid, principalId: principal, tourId: tour, sessionId, nowMs: NOW - 100, expiresAtMs: NOW + 86_400_000 });
  await db.ref().update({ [`app_sessions/${uid}`]: session,
    [`app_session_authority/${uid}`]: { schemaVersion: 1, state: 'committed', sessionId: session.sessionId, epoch: 'a'.repeat(48) },
    [`app_sessions/${sibling}`]: { ...session, authUid: sibling, sessionId: `sess_v1_${'f'.repeat(32)}` },
    [`users/${uid}`]: { principalType: 'passenger', bookingRef: booking, stablePassengerId: principal, stablePassengerKey: principal, privatePhotoOwnerKey: principal },
    [`passenger_identity_security/${booking}`]: { deviceAuthorizationVersion: 2, authorizedAuthUids: { [uid]: true, [sibling]: true }, passengerPrincipalId: principal },
    [`identity_bindings/${principal}/${uid}`]: true, [`identity_bindings/${principal}/${sibling}`]: true,
    [`tours/${tour}/participants/${uid}`]: { sessionId }, [`tours/${tour}/participants/${sibling}`]: { sessionId: `sess_v1_${'f'.repeat(32)}` },
    [`bookings/${booking}`]: { tourId: tour, customerName: 'Synthetic preserved roster' },
    [`tour_manifests/${tour}/bookings/${booking}`]: { passengerCount: 2 },
    [`chats/${tour}/messages/synthetic-owned`]: { senderId: principal, senderStableId: principal, senderName: 'Synthetic', text: 'delete synthetic content', timestamp: NOW },
    [`chats/${tour}/messages/synthetic-other`]: { senderId: 'unrelated', text: 'preserve' } });
  await cold(async database => assert.equal((await reserveAccountDeletion({ db: database, authUid: uid, deletionId: id, input: { expectedSessionId: sessionId, deletionReceipt: receipt }, nowMs: NOW })).status, 202));
  await writer.auth().createUser({ uid });
  let authCalls = 0;
  const auth = { deleteUser: async deleting => {
    assert.equal(deleting, uid); assert.equal(await value(`users/${uid}`), null, 'Auth is last');
    await writer.auth().deleteUser(deleting); authCalls += 1;
  } };
  const phases = new Set();
  for (let step = 0; step < 20; step += 1) {
    const current = await value(`account_deletion_jobs/v1/${id}`); if (current.status === 'completed') break;
    phases.add(current.phase);
    await cold(async database => {
      const due = await database.ref('account_deletion_queue/v1').orderByChild('dueAtMs').endAt(NOW).limitToFirst(10).once('value');
      assert.ok(due.exists());
      const result = await deletion.processAccountDeletionJob({ db: database, deletionId: id, nowMs: NOW, clock: () => NOW, auth, bucket: {} });
      assert.equal(result.processed, true, JSON.stringify({ phase: current.phase, ...result }));
    });
  }
  const completed = await value(`account_deletion_jobs/v1/${id}`);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.privateScope, undefined); assert.equal(completed.completionCleanup, undefined);
  assert.equal(phases.size, 8); assert.equal(authCalls, 1);
  await assert.rejects(writer.auth().getUser(uid), error => error.code === 'auth/user-not-found');
  await cold(database => deletion.processAccountDeletionJob({ db: database, deletionId: id, nowMs: NOW, clock: () => NOW, auth, bucket: {} }));
  assert.equal(authCalls, 1);
  assert.equal(await value(`account_deletion_active/v1/${uid}`), null);
  assert.equal(await value(`account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(booking)}`), null);
  assert.equal((await value(`account_deletion_completion_tombstones/v1/${id}`)).status, 'completed');
  assert.equal((await value(`account_deletion_uid_tombstones/v1/${deriveUidAccountDeletionTombstoneKey(uid)}`)).permanent, true);
  assert.equal((await value(`notification_device_tombstones/${uid}`)).permanent, true);
  assert.equal((await value(`passenger_identity_security/${booking}/authorizedAuthUids/${sibling}`)), true);
  assert.ok(await value(`app_sessions/${sibling}`)); assert.ok(await value(`tours/${tour}/participants/${sibling}`));
  assert.ok(await value(`identity_bindings/${principal}/${sibling}`));
  assert.equal((await value(`bookings/${booking}`)).customerName, 'Synthetic preserved roster');
  assert.equal((await value(`tour_manifests/${tour}/bookings/${booking}`)).passengerCount, 2);
  assert.equal((await value(`chats/${tour}/messages/synthetic-other`)).text, 'preserve');
  assert.equal((await value(`chats/${tour}/messages/synthetic-owned`)).deleted, true);
  const privacyJob = await value(`notification_jobs_v2/${jobs.buildNotificationJobId('group_chat_message', `${tour}:synthetic-owned`)}`);
  assert.equal(privacyJob.status, 'privacy_deleted');
  assert.equal(privacyJob.presentation, undefined); assert.equal(privacyJob.navigation, undefined);
  assert.equal(privacyJob.senderPrincipalId, undefined);
  assert.equal(await value(`account_deletion_queue/v1/${id}`), null);
});
