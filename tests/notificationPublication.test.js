'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-notification-publication' });
const { createNotificationRetentionMemoryDb } = require('./helpers/notificationRetentionMemoryDb');
const worker = require('../functions/src/domains/notifications/notificationWorker');
const publication = require('../functions/src/domains/notifications/notificationAttemptPublication');
const { reserveProviderBudget } = require('../functions/src/domains/notifications/notificationProviderBudget');
const { buildQueueEntry, buildNotificationQueueKey, loadFairDueQueueEntries, transitionQueuedRecord } = require('../functions/src/domains/notifications/notificationQueues');
const { refreshNotificationJobStatus } = require('../functions/src/domains/notifications/notificationReceipts');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const now = 1_800_000_000_000;
const job = { jobId: 'synthetic_job', counts: {}, status: 'fanout_in_progress', audienceType: 'marketing',
  expiresAtMs: now + 86400000, priorityClass: 'standard', presentation: { title: 'Synthetic', body: 'Local only' } };
const recipient = (uid) => ({ authUid: uid, tokenHash: `hash_${uid}`, token: `ExponentPushToken[synthetic${uid}]` });
const fixture = (hooks) => createNotificationRetentionMemoryDb({ notification_jobs_v2: { [job.jobId]: job } }, hooks);

for (const successor of ['worker', 'retention', 'deleted']) {
  test(`delayed queued-job transition cannot overwrite ${successor} state`, async () => {
    const db = fixture(); const path = `notification_jobs_v2/${job.jobId}`;
    const captured = structuredClone(db.getAtPath(path));
    const next = successor === 'deleted' ? null : { ...captured, ...(successor === 'worker'
      ? { status: 'receipt_pending', counts: { ticketAccepted: 1 }, lease: { ownerId: 'successor' } }
      : { retentionFence: { fenceId: 'retention-successor', generation: 2 }, retentionGeneration: 2 }) };
    await db.ref(path).set(next);
    await assert.rejects(transitionQueuedRecord(db, { targetPath: path, current: captured,
      patch: { status: 'expired', lease: null }, targetId: job.jobId }), { code: 'NOTIFICATION_JOB_VERSION_CHANGED' });
    assert.deepEqual(db.getAtPath(path) ?? null, next);
    assert.equal(db.getAtPath('notification_job_fanout_queue_v2'), undefined);
  });
}

test('job CAS acknowledgement loss retains its old pointer and repairs the replacement before retirement', async () => {
  let armed = false; let failed = false;
  const db = fixture({ afterTransaction: ({ pathName, committed }) => {
    if (armed && !failed && committed && pathName === `notification_jobs_v2/${job.jobId}`) {
      failed = true; throw new Error('lost job CAS acknowledgement');
    }
  } });
  const oldKey = buildNotificationQueueKey(now, job.jobId, 1);
  const current = { ...job, status: 'queued', queueKind: 'fanout', queueKey: oldKey, queueVersion: 1, availableAtMs: now };
  await db.ref(`notification_jobs_v2/${job.jobId}`).set(current);
  await db.ref(`notification_job_fanout_queue_v2/${oldKey}`).set(buildQueueEntry('fanout', job.jobId, now, 1));
  armed = true;
  await assert.rejects(transitionQueuedRecord(db, { targetPath: `notification_jobs_v2/${job.jobId}`, current,
    patch: { availableAtMs: now + 1000 }, queueKind: 'fanout', dueAtMs: now + 1000, targetId: job.jobId }), /lost job CAS/);
  const next = db.getAtPath(`notification_jobs_v2/${job.jobId}`);
  assert.ok(db.getAtPath(`notification_job_fanout_queue_v2/${oldKey}`));
  assert.equal(db.getAtPath(`notification_job_fanout_queue_v2/${next.queueKey}`), undefined);
  const { claimQueueEntry } = require('../functions/src/domains/notifications/notificationQueues');
  const claimed = await claimQueueEntry(db.ref(`notification_job_fanout_queue_v2/${oldKey}`), now, 60000, 'recovery');
  assert.equal(claimed.claimed, true);
  assert.equal((await worker.runNotificationJob({ db, jobId: job.jobId, nowMs: now, queueKey: oldKey,
    queueVersion: 1, queueOwnerId: 'recovery' })).status, 'stale_queue');
  assert.ok(db.getAtPath(`notification_job_fanout_queue_v2/${next.queueKey}`));
  assert.equal(db.getAtPath(`notification_job_fanout_queue_v2/${oldKey}`), undefined);
});

test('a non-Error rejection still stops admitting new preparation work', async () => {
  const admitted = []; let rejected = false;
  await worker.mapWithConcurrency([0, 1], 1, async value => {
    admitted.push(value); throw null;
  }).catch(reason => { rejected = true; assert.equal(reason, null); });
  assert.equal(rejected, true); assert.deepEqual(admitted, [0]);
});

test('terminal job keeps recovery pointer until source publication and retention handoff succeed', async () => {
  const db = fixture(); const oldKey = buildNotificationQueueKey(now, job.jobId, 1);
  const current = { ...job, status: 'queued', queueKind: 'fanout', queueKey: oldKey, queueVersion: 1 };
  await db.ref(`notification_jobs_v2/${job.jobId}`).set(current);
  await db.ref(`notification_job_fanout_queue_v2/${oldKey}`).set({
    ...buildQueueEntry('fanout', job.jobId, now, 1), lease: { ownerId: 'recovery', expiresAtMs: now + 60000 },
  });
  await transitionQueuedRecord(db, { targetPath: `notification_jobs_v2/${job.jobId}`, current,
    patch: { status: 'expired', completedAtMs: now, lease: null }, targetId: job.jobId });
  const args = { db, jobId: job.jobId, nowMs: now, queueKey: oldKey, queueVersion: 1, queueOwnerId: 'recovery' };
  await assert.rejects(worker.runNotificationJob({ ...args, syncSourceStatus: async () => { throw new Error('source unavailable'); } }), /source unavailable/);
  assert.ok(db.getAtPath(`notification_job_fanout_queue_v2/${oldKey}`));
  let published = 0;
  await worker.runNotificationJob({ ...args, syncSourceStatus: async () => { published += 1; } });
  assert.equal(published, 1);
  assert.equal(db.getAtPath(`notification_job_fanout_queue_v2/${oldKey}`), undefined);
  assert.ok(db.getAtPath(`notification_jobs_v2/${job.jobId}/retentionDueAtMs`) > now);
});

test('preparation failure drains admitted siblings before handing the page to recovery', async () => {
  const entered = deferred(); const resume = deferred(); let drained = false; let returned = false;
  const running = worker.mapWithConcurrency([0, 1, 2], 2, async value => {
    if (value === 0) { await entered.promise; throw new Error('preparation failed'); }
    if (value === 1) { entered.resolve(); await resume.promise; drained = true; }
    if (value === 2) throw new Error('work admitted after failure');
  }).catch(error => { returned = true; throw error; });
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  resume.resolve();
  await assert.rejects(running, /preparation failed/);
  assert.equal(drained, true);
});

test('delayed same-version preparation cannot overwrite successor or add phantom retry count', async () => {
  const db = fixture();
  const claimed = await worker.claimDeliveryAttempt(db, job, recipient('a'), now);
  const stale = structuredClone(claimed.attempt);
  const successor = await worker.transitionDeliveryAttempt(db, claimed.attemptId, stale, {
    status: 'request_started', requestStartedAtMs: now,
  }, now);
  await assert.rejects(worker.transitionDeliveryAttempt(db, claimed.attemptId, stale, { countsPublished: true }, now),
    { code: 'ATTEMPT_VERSION_CHANGED' });
  await worker.persistTicketResult({ db, job, claimed: { ...claimed, attempt: successor }, recipient: recipient('a'),
    ticket: { status: 'ok', id: 'synthetic_ticket' }, nowMs: now });
  const counts = db.getAtPath(`notification_jobs_v2/${job.jobId}/counts`);
  assert.equal(counts.retrying, 0); assert.equal(counts.ticketAccepted, 1); assert.equal(counts.receiptPending, 1);
  await publication.publishAttemptAccounting(db, stale);
  assert.deepEqual(db.getAtPath(`notification_jobs_v2/${job.jobId}/counts`), counts);
});

for (const boundary of ['attempt_commit', 'queue_publish', 'ledger_commit', 'job_count_commit', 'outbox_clear']) {
  test(`crash after ${boundary} repairs exact attempt, queue and counts once`, async () => {
    let armed = false; let fired = false;
    const db = fixture({ afterTransaction: ({ pathName, next, committed }) => {
      if (!armed || fired || !committed) return;
      const matched = boundary === 'attempt_commit' ? pathName.startsWith('notification_delivery_attempts_v2/') && next?.publicationPending
        : boundary === 'queue_publish' ? pathName.startsWith('notification_attempt_retry_queue_v2/')
          : boundary === 'ledger_commit' ? pathName.startsWith('notification_attempt_accounting_v2/')
            : boundary === 'job_count_commit' ? pathName === `notification_jobs_v2/${job.jobId}`
              : pathName.startsWith('notification_delivery_attempts_v2/') && next?.queueVersion > 0 && !next?.publicationPending;
      if (matched) { fired = true; throw new Error('injected acknowledgement loss'); }
    } });
    armed = true;
    await assert.rejects(worker.claimDeliveryAttempt(db, job, recipient('a'), now), /acknowledgement loss/);
    assert.equal(fired, true);
    const repaired = await worker.claimDeliveryAttempt(db, job, recipient('a'), now + 1);
    assert.equal(repaired.represented, true);
    assert.equal(repaired.attempt.publicationPending, null);
    assert.equal(db.getAtPath(`notification_jobs_v2/${job.jobId}/counts/retrying`), 1);
    assert.equal(Object.keys(db.data.notification_attempt_retry_queue_v2 || {}).length, 1);
    assert.equal(Object.keys(db.data.notification_job_recipients_v2[job.jobId]).length, 1);
  });
}

test('malformed provider response is ambiguous and never automatically resubmitted', async () => {
  const db = fixture(); const claimed = await worker.claimDeliveryAttempt(db, job, recipient('a'), now);
  let calls = 0;
  await worker.sendPreparedChunks(db, job, [{ claimed, recipient: recipient('a'), message: { to: recipient('a').token } }], {
    chunkPushNotifications: messages => [messages], sendPushNotificationsAsync: async () => { calls += 1; return []; },
  }, now);
  assert.equal(calls, 1);
  const attempt = db.getAtPath(`notification_delivery_attempts_v2/${claimed.attemptId}`);
  assert.equal(attempt.status, 'submission_unknown'); assert.equal(attempt.retryable, false);
  assert.equal(Object.keys(db.data.notification_attempt_retry_queue_v2 || {}).length, 0);
  await db.ref(`notification_jobs_v2/${job.jobId}`).update({ fanoutCompletedAtMs: now, status: 'retrying',
    'counts/eligible': 1 });
  const refreshed = await refreshNotificationJobStatus(db, job.jobId, now + 1);
  assert.equal(refreshed.status, 'submission_unknown'); assert.equal(refreshed.counts.retrying, 0);
  assert.equal(refreshed.job.completedAtMs, now + 1);
});

test('project-wide budget reserves operational capacity and survives a second boundary', async () => {
  const db = fixture();
  const campaigns = await Promise.all(Array.from({ length: 10 }, () => reserveProviderBudget({ db, count: 100, marketing: true, nowMs: now })));
  assert.equal(campaigns.filter(result => result.granted).length, 3);
  const operations = await Promise.all(Array.from({ length: 10 }, () => reserveProviderBudget({ db, count: 100, nowMs: now + 999 })));
  assert.equal(operations.filter(result => result.granted).length, 2);
  assert.equal((await reserveProviderBudget({ db, count: 1, nowMs: now + 1000 })).granted, false);
  assert.equal((await reserveProviderBudget({ db, count: 100, nowMs: now + 2000 })).granted, true);
});

test('bounded indexed queues give safety and operational work progress beside large marketing backlog', async () => {
  const db = fixture(); const queue = {};
  for (const [lane, count] of [['marketing', 2000], ['operational', 60], ['critical', 20]]) {
    for (let index = 0; index < count; index += 1) {
      const id = `${lane}_${index}`; queue[buildNotificationQueueKey(now, id)] = buildQueueEntry('retry', id, now, 1, lane);
    }
  }
  await db.ref('notification_attempt_retry_queue_v2').set(queue);
  const due = await loadFairDueQueueEntries(db, 'retry', now, 300);
  assert.equal(due.filter(([, entry]) => entry.targetId.startsWith('critical')).length, 20);
  assert.equal(due.filter(([, entry]) => entry.targetId.startsWith('operational')).length, 60);
  assert.equal(due.filter(([, entry]) => entry.targetId.startsWith('marketing')).length, 100);
  assert.equal(db.queryLog.length, 3);
});


test('late budget acknowledgement cannot create an unmetered provider burst', async () => {
  const db = fixture(); const claimed = await worker.claimDeliveryAttempt(db, job, recipient('late'), now);
  let sends = 0; let ticks = 0;
  await worker.sendPreparedChunks(db, job, [{ claimed, recipient: recipient('late'), message: { to: recipient('late').token } }], {
    chunkPushNotifications: messages => [messages], sendPushNotificationsAsync: async () => { sends += 1; return []; },
  }, now, () => now + (ticks++ ? 2000 : 0));
  assert.equal(sends, 0);
  const attempt = db.getAtPath(`notification_delivery_attempts_v2/${claimed.attemptId}`);
  assert.equal(attempt.status, 'retrying'); assert.equal(attempt.safeErrorCode, 'PROJECT_PROVIDER_BUDGET');
  assert.equal(db.getAtPath(`notification_jobs_v2/${job.jobId}/counts/retrying`), 1);
});


test('actual concurrent campaign, chat, itinerary and safety pages all progress within one fair sweep', async () => {
  const { createNotificationJobRecord, enqueueNotificationJob } = require('../functions/src/domains/notifications/notificationJobs');
  const { QUEUE_ROOTS, claimQueueEntry } = require('../functions/src/domains/notifications/notificationQueues');
  const data = { notification_devices: {}, notification_consents: {}, notification_marketing_audience: { v1: { day_trips: {} } },
    users: {}, app_sessions: {}, app_session_authority: {}, tours: { tour: { participants: {} } },
    driver_staff_policy: { D: { schemaVersion: 1, generation: 'a'.repeat(48) } }, driver_device_authorizations: {},
    drivers: { D: { currentTourId: 'tour' } }, tour_manifests: { tour: { assigned_drivers: { D: true } } },
    driver_login_policy: { v1: { schemaVersion: 1, generation: 0, revision: 1, updatedAtMs: now, enforceSingleDevice: false } } };
  for (let index = 0; index < 1200; index += 1) {
    const uid = `synthetic_${String(index).padStart(4, '0')}`;
    data.notification_devices[uid] = { schemaVersion: 1, status: 'active', registrationRevision: 1,
      pushToken: recipient(uid).token, permissionState: 'granted', marketingEligible: true,
      marketingPreferences: { day_trips: true }, operationalTourId: index < 75 ? 'tour' : `other_${index}`,
      operationalEligible: index < 75 };
    data.notification_consents[uid] = { registrationRevision: 1, marketingPreferences: { day_trips: true } };
    data.notification_marketing_audience.v1.day_trips[uid] = { schemaVersion: 1, registrationRevision: 1 };
    if (index >= 75) continue;
    const sessionId = `sess_v1_${index.toString(16).padStart(32, '0')}`;
    const principalId = index === 0 ? 'driver:D' : `pax_v2_${index.toString(16).padStart(32, '0')}`;
    data.app_sessions[uid] = { schemaVersion: 1, authUid: uid, sessionId, principalId,
      principalType: index === 0 ? 'driver' : 'passenger', driverId: index === 0 ? 'D' : null,
      driverLoginPolicyGeneration: 0, tourId: 'tour', status: 'active', sessionRevision: 1,
      issuedAtMs: now - 1000, lastAuthenticatedAtMs: now - 1000, expiresAtMs: now + 86400000 };
    data.app_session_authority[uid] = { schemaVersion: 1, epoch: 'a'.repeat(48), state: 'committed', sessionId };
    data.users[uid] = index === 0 ? { principalType: 'driver', driverId: 'D', driverPrincipalId: principalId, driverAssignedTourId: 'tour' } : {};
    data.tours.tour.participants[uid] = { schemaVersion: 2, userId: uid, principalId, sessionId, sessionExpiresAtMs: now + 86400000 };
    if (index === 0) data.driver_device_authorizations[uid] = { schemaVersion: 1, state: 'active', driverId: 'D', sessionId, generation: 'a'.repeat(48) };
  }
  require('./helpers/seedNotificationPassengerAuthority').seedNotificationPassengerAuthority(data);
  const db = createNotificationRetentionMemoryDb(data);
  const jobs = [['campaignA', 'future_tour_category_broadcast', 'marketing'], ['campaignB', 'future_tour_category_broadcast', 'marketing'],
    ['chat', 'passenger_group_chat', 'tour'], ['itinerary', 'itinerary_change', 'tour'], ['safety', 'critical_safety', 'safety']]
    .map(([name, notificationType, audienceType]) => createNotificationJobRecord({ notificationType, audienceType,
      sourceType: 'synthetic', sourceId: name, tourId: 'tour', categoryKey: 'day_trips', nowMs: now,
      presentation: { title: name, body: 'Synthetic only' }, navigation: { syntheticJob: name } }));
  for (const item of jobs) await enqueueNotificationJob({ db, job: item });
  const submitted = [];
  const expo = { chunkPushNotifications: messages => [messages], sendPushNotificationsAsync: async messages => {
    submitted.push(...messages.map(message => message.title)); return messages.map((_, index) => ({ status: 'ok', id: `ticket${submitted.length}_${index}` }));
  } };
  const due = await loadFairDueQueueEntries(db, 'fanout', now, 30);
  assert.equal(due.length, 5);
  for (const [key, entry] of due) {
    const claim = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.fanout}/${key}`), now);
    await worker.runNotificationJob({ db, jobId: entry.targetId, nowMs: now, expo, providerClock: () => now,
      queueKey: key, queueVersion: claim.entry.version, queueOwnerId: claim.ownerId, queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs });
  }
  assert.equal(submitted[0], 'safety');
  for (const [name, expected] of [['safety', 1], ['chat', 75], ['itinerary', 75], ['campaignA', 100], ['campaignB', 100]]) {
    assert.equal(submitted.filter(value => value === name).length, expected, name);
  }
  assert.ok(jobs.filter(item => item.audienceType === 'marketing').every(item => !db.data.notification_jobs_v2[item.jobId].fanoutCompletedAtMs));
});


test('queue health samples each lane with nine bounded reads and no recipient identifiers', async () => {
  const { recordNotificationQueueHealth } = require('../functions/src/domains/notifications/notificationQueueHealth');
  const db = fixture();
  await db.ref('notification_attempt_retry_queue_v2').set({
    sample: buildQueueEntry('retry', 'private-installation', now - 2500, 1, 'critical'),
  });
  const health = await recordNotificationQueueHealth(db, now);
  assert.deepEqual(health.retry.critical, { hasDueWork: true, oldestDueAgeMs: 2500 });
  assert.equal(health.retry.marketing.hasDueWork, false);
  assert.equal(db.queryLog.length, 9);
  assert.ok(db.queryLog.every(query => query.returned <= 1));
  assert.equal(JSON.stringify(health).includes('private-installation'), false);
});


test('delayed source snapshots cannot regress newer counts or terminal completion', async () => {
  const { syncNotificationSourceStatus } = require('../functions/src/domains/notifications/notificationSourceStatus');
  const db = fixture();
  await db.ref('category_broadcasts/day_trips/synthetic').set({ deliveryJobId: job.jobId });
  const base = { ...job, sourceType: 'future_tour_category_broadcast', categoryKey: 'day_trips', navigation: { broadcastId: 'synthetic' } };
  const terminal = { ...base, status: 'provider_accepted', completedAtMs: now,
    attemptAccounting: { a: { revision: 5 } }, counts: { audience: 2, eligible: 2, receiptAccepted: 2 } };
  await syncNotificationSourceStatus(db, terminal, now);
  const before = db.getAtPath('category_broadcasts/day_trips/synthetic');
  await syncNotificationSourceStatus(db, { ...base, status: 'retrying', attemptAccounting: { a: { revision: 4 } },
    counts: { audience: 2, eligible: 2, retrying: 1 } }, now + 1000);
  await syncNotificationSourceStatus(db, { ...terminal, status: 'receipt_pending' }, now + 2000);
  assert.deepEqual(db.getAtPath('category_broadcasts/day_trips/synthetic'), before);
  // An explicit new retry generation has a strictly later accounting sequence.
  await syncNotificationSourceStatus(db, { ...terminal, status: 'retrying', attemptAccounting: { a: { revision: 6 } } }, now + 3000);
  assert.equal(db.getAtPath('category_broadcasts/day_trips/synthetic').deliveryStatus, 'retrying');
});

test('prepared monitoring covers every notification queue lane and missing health reports', () => {
  const plan = require('../config/first-launch/monitoring-plan.json');
  assert.equal(plan.status, 'prepared-not-applied');
  const filters = plan.logAlerts.map(alert => alert.filter).join(' ');
  for (const kind of ['fanout', 'retry', 'receipt']) for (const lane of ['critical', 'operational', 'marketing']) {
    assert.ok(filters.includes(`jsonPayload.queues.${kind}.${lane}.oldestDueAgeMs>`), `${kind}/${lane}`);
  }
  const metric = plan.logMetrics.find(value => value.name === 'llt_notification_health_reports');
  assert.ok(metric.filter.includes('jsonPayload.schemaVersion=2'));
  assert.ok(metric.filter.includes('jsonPayload.message="Notification queue health"'));
  assert.equal(metric.metricDescriptor.metricKind, 'DELTA');
  const policy = plan.metricAlerts.find(value => value.displayName === 'LLT notification queue health silent');
  const condition = policy.conditions[0].conditionThreshold;
  assert.ok(condition.filter.includes(`logging.googleapis.com/user/${metric.name}`));
  assert.equal(condition.comparison, 'COMPARISON_LT');
  assert.equal(condition.thresholdValue, 1);
  assert.equal(condition.duration, '600s');
  assert.equal(condition.evaluationMissingData, 'EVALUATION_MISSING_DATA_ACTIVE');
  assert.deepEqual(condition.aggregations, [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM', groupByFields: [] }]);
  assert.ok(policy.activationRequirements.some(value => value.includes('real schema-2 heartbeat')));
});
