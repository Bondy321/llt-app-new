const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-notification-reliability',
  storageBucket: 'demo-llt-notification-reliability.appspot.com',
});

const { __testables } = require('../functions/index.js');
const { buildNotificationQueueKey } = require('../functions/src/domains/notifications/notificationQueues');
const notificationWorker = require('../functions/src/domains/notifications/notificationWorker');
const notificationSourceStatus = require('../functions/src/domains/notifications/notificationSourceStatus');
const { hashPushToken } = require('../functions/src/domains/notifications/notificationAudiencePage');
const { shouldReplaceDriverPackChange } = require('../functions/src/domains/notifications/driverTourPackNotificationFunction');
const { verifyBroadcastAuthor } = require('../functions/src/domains/notifications/broadcastFunctions');
const notificationAdminFunctions = require('../functions/src/domains/notifications/notificationAdminFunctions');
const { runNotificationSourceHandoff } = require('../functions/src/domains/notifications/notificationSourceHandoff');

const nowMs = 1_800_000_000_000;
const expoToken = 'ExponentPushToken[reliability-test-token]';

const buildJob = (overrides = {}) => __testables.createNotificationJobRecord({
  notificationType: __testables.NOTIFICATION_TYPES.GROUP_CHAT,
  sourceType: 'test_source',
  sourceId: 'test-source-1',
  audienceType: 'tour',
  tourId: 'TOUR_1',
  presentation: { title: 'Test title', body: 'Test body' },
  navigation: { screen: 'Chat', tourId: 'TOUR_1', messageId: 'message-1', timestamp: nowMs, expiresAtMs: nowMs + 60_000 },
  nowMs,
  ...overrides,
});

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const getAtPath = (root, pathName) => pathName.split('/').filter(Boolean)
  .reduce((current, key) => current?.[key], root);
const setAtPath = (root, pathName, value) => {
  const keys = pathName.split('/').filter(Boolean);
  let current = root;
  keys.slice(0, -1).forEach((key) => { current[key] ||= {}; current = current[key]; });
  if (value === null) delete current[keys.at(-1)];
  else if (value?.['.sv']?.increment !== undefined) current[keys.at(-1)] = Number(current[keys.at(-1)] || 0) + Number(value['.sv'].increment);
  else current[keys.at(-1)] = clone(value);
};

const createMemoryDb = (initial = {}) => {
  const data = clone(initial);
  const snapshot = (value) => ({ val: () => clone(value), exists: () => value !== null && value !== undefined });
  const matchesQuery = (entries, query) => entries.filter(([, value]) => {
    if (query.equalTo !== undefined) return value?.[query.orderByChild] === query.equalTo;
    return query.endAt === undefined || Number(value?.[query.orderByChild] || 0) <= query.endAt;
  });
  const ref = (pathName = '') => {
    const query = { orderByChild: null, orderByKey: false, startAfter: undefined, equalTo: undefined, endAt: undefined, limit: Infinity };
    const api = {
      once: async () => {
        const raw = getAtPath(data, pathName);
        if (!query.orderByChild && !query.orderByKey) return snapshot(raw || null);
        const entries = (query.orderByKey ? Object.entries(raw || {}).filter(([key]) => query.endAt === undefined || key <= query.endAt) : matchesQuery(Object.entries(raw || {}), query))
          .filter(([key]) => !query.orderByKey || !query.startAfter || key > query.startAfter)
          .slice(0, query.limit);
        return snapshot(Object.fromEntries(entries));
      },
      update: async (patch) => {
        if (!pathName) Object.entries(patch).forEach(([key, value]) => setAtPath(data, key, value));
        else Object.entries(patch).forEach(([key, value]) => setAtPath(data, `${pathName}/${key}`, value));
      },
      transaction: async (updater) => {
        const current = clone(getAtPath(data, pathName));
        const next = updater(current);
        if (next !== undefined) setAtPath(data, pathName, next);
        return { committed: next !== undefined, snapshot: snapshot(next === undefined ? current : next) };
      },
      orderByChild: (key) => { query.orderByChild = key; return api; },
      orderByKey: () => { query.orderByKey = true; return api; },
      startAfter: (value) => { query.startAfter = value; return api; },
      equalTo: (value) => { query.equalTo = value; return api; },
      endAt: (value) => { query.endAt = value; return api; },
      limitToFirst: (value) => { query.limit = value; return api; },
    };
    return api;
  };
  return { data, ref };
};

const queueAttempts = (attempts, kind, dueField) => {
  const queueRoot = kind === 'receipt' ? 'notification_receipt_due_queue' : 'notification_attempt_retry_queue';
  const queue = {};
  const records = {};
  Object.entries(attempts).forEach(([attemptId, attempt]) => {
    const queueKey = buildNotificationQueueKey(attempt[dueField], attemptId, 1);
    records[attemptId] = { ...attempt, attemptId, queueKind: kind, queueKey, queueVersion: 1 };
    queue[queueKey] = { schemaVersion: 1, kind, targetId: attemptId, dueAtMs: attempt[dueField], version: 1 };
  });
  return { notification_delivery_attempts: records, [queueRoot]: queue };
};

test('delivery policy centrally assigns versioned channels, optional photo preference, and bounded TTL', () => {
  const photo = __testables.getNotificationDeliveryPolicy(__testables.NOTIFICATION_TYPES.GROUP_PHOTO);
  const safety = __testables.getNotificationDeliveryPolicy(__testables.NOTIFICATION_TYPES.CRITICAL_SAFETY);
  assert.deepEqual(photo.preferencePath, ['preferences', 'ops', 'group_photos']);
  assert.equal(photo.channelId, __testables.CHANNELS.GROUP_PHOTOS);
  assert.equal(safety.bypassesOptionalPreferences, true);
  assert.ok(safety.ttlMs < photo.ttlMs);
  assert.equal(__testables.buildDeliveryGrouping(__testables.NOTIFICATION_TYPES.ITINERARY_CHANGE, { tourId: 'TOUR_1' }).collapseId, 'itinerary:TOUR_1');
});

test('jobs are deterministic, opaque, idempotency-safe, and reject sensitive presentation data', () => {
  assert.equal(__testables.buildNotificationJobId('chat', 'TOUR_1:message-1'), __testables.buildNotificationJobId('chat', 'TOUR_1:message-1'));
  assert.notEqual(__testables.buildNotificationJobId('chat', 'TOUR_1:message-1'), __testables.buildNotificationJobId('chat', 'TOUR_1:message-2'));
  const job = buildJob();
  assert.match(job.jobId, /^notif_v1_[a-f0-9]{64}$/);
  assert.equal(job.status, 'queued');
  assert.equal(job.counts.receiptPending, 0);
  assert.throws(() => buildJob({ navigation: { imageUrl: 'https://durable.example', screen: 'Chat' } }), /forbidden field/iu);
});

test('lease acquisition is exclusive and retry backoff is bounded and monotonic', async () => {
  let value = buildJob();
  const jobRef = {
    transaction: async (update) => {
      const next = update(value);
      if (next !== undefined) value = next;
      return { snapshot: { val: () => value } };
    },
  };
  const first = await __testables.acquireNotificationJobLease({ jobRef, nowMs, ownerId: 'worker-a' });
  const second = await __testables.acquireNotificationJobLease({ jobRef, nowMs: nowMs + 1, ownerId: 'worker-b' });
  const recovered = await __testables.acquireNotificationJobLease({ jobRef, nowMs: nowMs + 121_000, ownerId: 'worker-b' });
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(recovered.acquired, true);
  assert.ok(__testables.calculateNotificationRetryDelayMs(2) > __testables.calculateNotificationRetryDelayMs(1));
  assert.equal(__testables.calculateNotificationRetryDelayMs(100), 1_800_000);
});

test('exact group-photo Function output creates one photo-policy job and honours group_photos preference', async () => {
  const record = __testables.buildGroupPhotoChatMessageRecord({
    input: { caption: '', senderName: 'Passenger', clientCreatedAt: nowMs - 1, messageId: 'message_1', photoId: 'photo_1' },
    principalId: 'pax_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    role: 'passenger',
    serverTimestamp: nowMs,
  });
  const message = __testables.buildGroupPhotoChatResponseMessage(record, 'message_1');
  assert.equal(__testables.validateMessageData(message).valid, true);
  assert.equal(__testables.validateMessageData({ ...message, photoId: '' }).valid, false);
  assert.equal(__testables.validateMessageData({ ...message, imageUrl: 'https://durable.example' }).valid, false);
  const job = __testables.buildChatNotificationJob({ tourId: 'TOUR_1', messageId: 'message_1', messageData: message, nowMs });
  const duplicate = __testables.buildChatNotificationJob({ tourId: 'TOUR_1', messageId: 'message_1', messageData: message, nowMs: nowMs + 1 });
  assert.equal(duplicate.jobId, job.jobId);
  assert.equal(job.notificationType, __testables.NOTIFICATION_TYPES.GROUP_PHOTO);
  assert.equal(job.deliveryPolicy.channelId, __testables.CHANNELS.GROUP_PHOTOS);
  assert.equal(job.navigation.photoId, 'photo_1');
  assert.equal(Object.hasOwn(job.navigation, 'imageUrl'), false);
  const session = {
    schemaVersion: 1,
    sessionId: 'sess_v1_0123456789abcdef0123456789abcdef',
    authUid: 'recipient',
    principalId: 'pax_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    principalType: 'passenger',
    tourId: 'TOUR_1',
    driverId: null,
    status: 'active',
    issuedAtMs: nowMs - 1_000,
    lastAuthenticatedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    sessionRevision: 1,
  };
  const values = {
    'app_sessions/recipient': session,
    'tours/TOUR_1/participants/recipient': {
      schemaVersion: 2,
      userId: 'recipient',
      principalId: session.principalId,
      sessionId: session.sessionId,
      sessionExpiresAtMs: session.expiresAtMs,
    },
  };
  const db = { ref: (pathName) => ({ once: async () => ({ val: () => values[pathName] || null }) }) };
  const device = { pushToken: expoToken, status: 'active', permissionState: 'granted', operationalEligible: true };
  const off = await __testables.evaluateNotificationAudienceCandidate({
    db, job, nowMs,
    candidate: { authUid: 'recipient', device, profile: { preferences: { ops: { group_chat: true, group_photos: false } } } },
  });
  const on = await __testables.evaluateNotificationAudienceCandidate({
    db, job, nowMs,
    candidate: { authUid: 'recipient', device, profile: { preferences: { ops: { group_chat: false, group_photos: true } } } },
  });
  assert.equal(off.reason, 'opted_out');
  assert.equal(on.eligible, true);
});

test('safety jobs carry exact event routing and all routes carry a bounded expiry', () => {
  const job = __testables.buildSafetyNotificationJob({
    tourId: 'TOUR_1', eventId: 'event_1', tourName: 'Safe Tour', nowMs,
    alert: { severity: 'critical', isSOS: true, reporterAuthUid: 'reporter', principalId: 'driver:D1', category: 'medical' },
  });
  assert.equal(job.notificationType, __testables.NOTIFICATION_TYPES.CRITICAL_SAFETY);
  assert.equal(job.navigation.screen, 'SafetyAlertDetail');
  assert.equal(job.navigation.eventId, 'event_1');
  assert.ok(job.navigation.expiresAtMs > job.navigation.timestamp);
  assert.throws(() => __testables.buildPushNavigationData({ screen: 'SafetyAlertDetail', tourId: 'TOUR_1', timestamp: nowMs }), /eventId/iu);
});

test('audience paging remains cursor-based beyond 1,000 recipients and no notification producer owns Expo sending', async () => {
  const users = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [
    `user_${String(index).padStart(4, '0')}`,
    { pushToken: expoToken, pushTokenStatus: 'ACTIVE', pushPermissionState: 'granted' },
  ]));
  const pagingDb = {
    ref: (root) => {
      let after = null;
      let limit = Infinity;
      const query = {
        orderByKey: () => query,
        startAfter: (value) => { after = value; return query; },
        limitToFirst: (value) => { limit = value; return query; },
        once: async () => {
          const records = Object.entries(root === 'users' ? users : {})
            .filter(([key]) => !after || key > after)
            .slice(0, limit);
          const value = root === 'notification_migrations/device_registry_v1' ? {} : Object.fromEntries(records);
          return { val: () => value, exists: () => root.startsWith('notification_devices/') ? false : Object.keys(value).length > 0 };
        },
      };
      return query;
    },
  };
  const first = await __testables.loadNotificationAudiencePage(pagingDb, 'users|', 100);
  const second = await __testables.loadNotificationAudiencePage(pagingDb, first.nextCursor, 100);
  assert.equal(first.candidates.length, 100);
  assert.equal(second.candidates.length, 100);
  assert.ok(first.nextCursor.startsWith('users|'));
  const audienceSource = fs.readFileSync(path.join(__dirname, '../functions/src/domains/notifications/notificationAudiencePage.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(__dirname, '../functions/src/domains/notifications/notificationWorker.js'), 'utf8');
  const producerFiles = [
    'broadcastFunctions.js', 'chatNotificationFunctions.js', 'itineraryNotificationFunction.js',
    'driverTourPackNotificationFunction.js', 'safetyNotificationFunction.js', 'notificationProducerJobs.js',
  ];
  assert.match(audienceSource, /PAGE_SIZE = 100/u);
  assert.match(audienceSource, /startAfter\(after\)/u);
  assert.match(workerSource, /sendPushNotificationsAsync/u);
  producerFiles.forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, '../functions/src/domains/notifications', file), 'utf8');
    assert.doesNotMatch(source, /sendPushNotificationsAsync/u, file);
    assert.match(source, /enqueueNotificationJob|build[A-Za-z]+NotificationJob/u, file);
  });
});

test('fresh candidate eligibility returns explicit skip reasons instead of relying on a cached profile', async () => {
  const job = buildJob({ senderAuthUid: 'sender' });
  const noToken = await __testables.evaluateNotificationAudienceCandidate({ job, candidate: { authUid: 'recipient', profile: {} }, db: { ref: () => ({ once: async () => ({ val: () => ({}) }) }) } });
  const optedOut = await __testables.evaluateNotificationAudienceCandidate({
    job,
    candidate: { authUid: 'recipient', device: { pushToken: expoToken, status: 'active', permissionState: 'granted', operationalEligible: false }, profile: {} },
    db: { ref: () => ({ once: async () => ({ val: () => ({}) }) }) },
  });
  assert.equal(noToken.reason, 'no_token');
  assert.equal(optedOut.reason, 'inactive_operational_session');
});

test('ticket/receipt states and admin preview/requeue helpers remain available for durable reporting', () => {
  assert.deepEqual(__testables.SAFE_NOTIFICATION_STATUSES, [
    'queued', 'fanout_in_progress', 'ticket_accepted', 'ticket_rejected', 'receipt_pending', 'provider_accepted',
    'provider_rejected', 'retrying', 'expired', 'partial', 'no_recipients',
  ]);
  const preview = __testables.buildNotificationPreviewJob({ categoryKey: 'day_trips' }, nowMs);
  assert.equal(preview.audienceType, 'marketing');
  assert.equal(preview.navigation.screen, 'MarketingNotificationDetail');
  assert.equal(typeof __testables.requeueFailedNotificationJob, 'function');
  assert.equal(typeof __testables.compareAndClearNotificationTokenByHash, 'function');
  assert.equal(typeof __testables.refreshNotificationJobStatus, 'function');
});

test('exact safety detail actions remain authorised, idempotent, and bound to one event', async () => {
  const db = createMemoryDb({
    users: { '9CWQ4705gVRkfW5Xki5LyvrmVp23': {} },
    tours: {
      TOUR_1: {
        safetyAlerts: {
          event_1: {
            category: 'medical', severity: 'critical', status: 'pending', message: 'Sanitised summary', receivedAtMs: nowMs,
          },
          event_2: {
            category: 'delay', severity: 'medium', status: 'pending', message: 'Another event', receivedAtMs: nowMs,
          },
        },
      },
    },
  });
  const input = {
    db,
    authUid: '9CWQ4705gVRkfW5Xki5LyvrmVp23',
    tourId: 'TOUR_1',
    eventId: 'event_1',
    nowMs,
  };
  const acknowledged = await __testables.updateSafetyAlertStatus({ ...input, action: 'acknowledge' });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.alert.eventId, 'event_1');
  assert.equal(acknowledged.body.alert.status, 'acknowledged');
  const repeated = await __testables.updateSafetyAlertStatus({ ...input, action: 'acknowledge' });
  assert.equal(repeated.body.alert.status, 'acknowledged');
  assert.equal(db.data.tours.TOUR_1.safetyAlerts.event_2.status, 'pending');
  const invalid = await __testables.updateSafetyAlertStatus({ ...input, action: 'contact_emergency_services' });
  assert.equal(invalid.status, 400);
});

test('duplicate enqueue commits only once and preserves the original deterministic job', async () => {
  const db = createMemoryDb();
  const job = buildJob();
  const first = await __testables.enqueueNotificationJob({ db, job });
  const second = await __testables.enqueueNotificationJob({ db, job: { ...job, presentation: { title: 'Changed', body: 'Changed' } } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(db.data.notification_jobs[job.jobId].presentation, job.presentation);
});

test('ticket persistence distinguishes accepted, retryable, permanent, and configuration outcomes', async () => {
  const job = buildJob();
  const recipient = { authUid: 'recipient', token: expoToken, tokenHash: __testables.hashNotificationPushToken(expoToken) };
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    notification_devices: { recipient: { pushToken: expoToken, tokenHash: recipient.tokenHash, status: 'active' } },
    users: { recipient: { pushToken: expoToken } },
    notification_delivery_attempts: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`attempt_${index + 1}`, {
      attemptId: `attempt_${index + 1}`, jobId: job.jobId, status: 'prepared', ticketStatus: 'pending', receiptStatus: 'not_requested', queueVersion: 0, attemptNumber: 1,
    }])),
  });
  const attemptRef = db.ref('notification_delivery_attempts/attempt_1');
  const claimed = { attemptId: 'attempt_1', attemptRef, attempt: db.data.notification_delivery_attempts.attempt_1 };
  await __testables.persistNotificationTicketResult({ db, job, claimed, recipient, ticket: { status: 'ok', id: 'ticket_1' }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_1.status, 'receipt_pending');
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptId: 'attempt_2', attemptRef: db.ref('notification_delivery_attempts/attempt_2') }, recipient, ticket: { status: 'error', details: { error: 'MessageRateExceeded' } }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_2.status, 'retrying');
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptId: 'attempt_3', attemptRef: db.ref('notification_delivery_attempts/attempt_3') }, recipient, ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_3.status, 'ticket_rejected');
  assert.equal(db.data.notification_devices.recipient.pushToken, null);
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptId: 'attempt_4', attemptRef: db.ref('notification_delivery_attempts/attempt_4') }, recipient, ticket: { status: 'error', details: { error: 'InvalidCredentials' } }, nowMs });
  assert.equal(db.data.notification_delivery_warnings[job.jobId].code, 'InvalidCredentials');
});

test('receipt processor accepts success, retries temporary errors, warns on configuration, and clears only matching stale tokens', async () => {
  const job = buildJob();
  const tokenHash = __testables.hashNotificationPushToken(expoToken);
  const due = (ticketId, extra = {}) => ({ jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', ticketId, tokenHash, status: 'receipt_pending', ticketStatus: 'ticket_accepted', receiptStatus: 'receipt_pending', receiptDueAtMs: nowMs, receiptWindowExpiresAtMs: nowMs + 60_000, attemptNumber: 1, ...extra });
  const queued = queueAttempts({ accepted: due('ok'), rate: due('rate'), config: due('config'), stale: due('stale', { tokenHash: 'old-token-hash' }) }, 'receipt', 'receiptDueAtMs');
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    notification_devices: { recipient: { pushToken: expoToken, tokenHash, status: 'active' } },
    users: { recipient: { pushToken: expoToken } },
    ...queued,
  });
  const expo = { getPushNotificationReceiptsAsync: async () => ({ ok: { status: 'ok' }, rate: { status: 'error', details: { error: 'MessageRateExceeded' } }, config: { status: 'error', details: { error: 'InvalidCredentials' } }, stale: { status: 'error', details: { error: 'DeviceNotRegistered' } } }) };
  const result = await __testables.processDueNotificationReceipts({ db, nowMs, expo });
  assert.deepEqual(result, { checked: 4, accepted: 1, rejected: 3, missing: 0, requestFailed: 0 });
  assert.equal(db.data.notification_delivery_attempts.accepted.status, 'provider_accepted');
  assert.equal(db.data.notification_delivery_attempts.rate.status, 'retrying');
  assert.equal(db.data.notification_delivery_attempts.config.status, 'provider_rejected');
  assert.equal(db.data.notification_delivery_warnings[job.jobId].code, 'InvalidCredentials');
  assert.equal(db.data.notification_devices.recipient.pushToken, expoToken, 'a newer token must never be cleared by an old receipt');
});

test('missing or failed receipt lookups retry inside their window and reject after expiry', async () => {
  const job = buildJob();
  const pending = (id, expiresAtMs) => ({ jobId: job.jobId, ticketId: id, status: 'receipt_pending', receiptStatus: 'receipt_pending', receiptDueAtMs: nowMs, receiptWindowExpiresAtMs: expiresAtMs });
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: job }, ...queueAttempts({ missing: pending('missing', nowMs + 1), expired: pending('expired', nowMs), failed: pending('failed', nowMs + 1) }, 'receipt', 'receiptDueAtMs') });
  const missing = await __testables.processDueNotificationReceipts({ db, nowMs, expo: { getPushNotificationReceiptsAsync: async () => ({}) } });
  assert.equal(missing.missing, 2);
  assert.equal(missing.rejected, 1);
  assert.equal(db.data.notification_delivery_attempts.expired.safeErrorCode, 'RECEIPT_EXPIRED');
  const failedDb = createMemoryDb({ ...queueAttempts({ failed: pending('failed', nowMs + 1) }, 'receipt', 'receiptDueAtMs') });
  const failed = await __testables.processDueNotificationReceipts({ db: failedDb, nowMs, expo: { getPushNotificationReceiptsAsync: async () => { throw new Error('offline'); } } });
  assert.equal(failed.requestFailed, 1);
  assert.equal(failedDb.data.notification_delivery_attempts.failed.safeErrorCode, 'RECEIPT_REQUEST_FAILED');
});

test('expired or superseded jobs never send, and a worker crash requeues only fanout with its lease released', async () => {
  for (const job of [{ ...buildJob(), expiresAtMs: nowMs }, { ...buildJob(), supersededByJobId: 'newer_job' }]) {
    const db = createMemoryDb({ notification_jobs: { [job.jobId]: job } });
    let sent = false;
    const outcome = await __testables.processNotificationJobPage({ db, jobRef: db.ref(`notification_jobs/${job.jobId}`), job, nowMs, expo: { chunkPushNotifications: () => [], sendPushNotificationsAsync: async () => { sent = true; } } });
    assert.equal(outcome.status, 'expired');
    assert.equal(sent, false);
  }
  const job = buildJob({ maxAttempts: 3 });
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: job } });
  const crashed = await __testables.runNotificationJob({ db, jobId: job.jobId, nowMs, expo: { chunkPushNotifications: () => { throw Object.assign(new Error('crash'), { code: 'CRASH' }); } } });
  assert.equal(crashed.status, 'queued');
  assert.equal(db.data.notification_jobs[job.jobId].lease ?? null, null);
  assert.equal(db.data.notification_jobs[job.jobId].attemptCount, 1);
});

test('stale pre-request attempts are recovered exactly once, while retrying counters keep job reporting retrying', async () => {
  const job = buildJob();
  const tokenHash = __testables.hashNotificationPushToken(expoToken);
  const session = { schemaVersion: 1, sessionId: 'sess_v1_0123456789abcdef0123456789abcdef', authUid: 'recipient', principalId: 'pax_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', principalType: 'passenger', tourId: 'TOUR_1', driverId: null, status: 'active', issuedAtMs: nowMs - 1_000, lastAuthenticatedAtMs: nowMs - 1_000, sessionRevision: 1, expiresAtMs: nowMs + 60_000 };
  const preparedAttempt = { jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', tokenHash, status: 'prepared', ticketStatus: 'pending', receiptStatus: 'not_requested', attemptNumber: 1, submissionLease: { ownerId: 'lost', expiresAtMs: nowMs }, updatedAtMs: nowMs - __testables.STALE_SENDING_ATTEMPT_MS, availableAtMs: nowMs };
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    ...queueAttempts({ stale: preparedAttempt }, 'retry', 'availableAtMs'),
    notification_devices: { recipient: { pushToken: expoToken, tokenHash, status: 'active', permissionState: 'granted', operationalEligible: true } },
    users: { recipient: {} },
    app_sessions: { recipient: session },
    tours: { TOUR_1: { participants: { recipient: { schemaVersion: 2, userId: 'recipient', principalId: session.principalId, sessionId: session.sessionId, sessionExpiresAtMs: session.expiresAtMs } } } },
  });
  const result = await __testables.retryDueNotificationAttempts({ db, nowMs, expo: { sendPushNotificationsAsync: async () => [{ status: 'ok', id: 'recovered-ticket' }] } });
  assert.equal(result.retried, 1);
  assert.equal(db.data.notification_delivery_attempts.stale.status, 'receipt_pending');
  db.data.notification_delivery_attempts.stale.status = 'retrying';
  db.data.notification_delivery_attempts.stale.ticketStatus = 'ticket_rejected';
  db.data.notification_delivery_attempts.stale.receiptStatus = 'not_requested';
  db.data.notification_jobs[job.jobId].fanoutCompletedAtMs = nowMs;
  db.data.notification_jobs[job.jobId].counts = { ...db.data.notification_jobs[job.jobId].counts, receiptPending: 0, retrying: 1 };
  await __testables.refreshNotificationJobStatus(db, job.jobId, nowMs);
  assert.equal(db.data.notification_jobs[job.jobId].status, 'retrying');
});

test('a crash after preparing an attempt cannot strand the recipient before queue publication', async () => {
  const job = buildJob();
  const recipient = {
    authUid: 'recipient-crash-window',
    token: expoToken,
    tokenHash: hashPushToken(expoToken),
  };
  const attemptId = notificationWorker.buildDeliveryAttemptId(job.jobId, recipient.authUid, 1);
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    notification_job_token_claims: { [job.jobId]: { [recipient.tokenHash]: recipient.authUid } },
    notification_delivery_attempts: {
      [attemptId]: {
        schemaVersion: 2,
        attemptId,
        generation: 1,
        jobId: job.jobId,
        recipientUid: recipient.authUid,
        installationUid: recipient.authUid,
        tokenHash: recipient.tokenHash,
        status: 'prepared',
        ticketStatus: 'pending',
        receiptStatus: 'not_requested',
        retryable: false,
        attemptNumber: 1,
        submissionLease: { ownerId: 'crashed-owner', acquiredAtMs: nowMs, expiresAtMs: nowMs + 120_000 },
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        availableAtMs: nowMs,
        expiresAtMs: job.expiresAtMs,
        queueKind: null,
        queueKey: null,
        queueVersion: 0,
      },
    },
  });

  const result = await notificationWorker.claimDeliveryAttempt(db, job, recipient, nowMs + 1);
  const state = db.data;
  assert.equal(result.claimed, false);
  assert.equal(state.notification_job_recipients[job.jobId][recipient.authUid].attemptId, attemptId);
  assert.equal(state.notification_delivery_attempts[attemptId].queueKind, 'retry');
  assert.equal(Object.keys(state.notification_attempt_retry_queue).length, 1);
});

test('explicit due queues cannot be starved by unrelated terminal records', async () => {
  const attempt = { jobId: 'job_due', status: 'receipt_pending', receiptStatus: 'receipt_pending', ticketId: 'ticket_due', receiptDueAtMs: nowMs, receiptWindowExpiresAtMs: nowMs + 60_000 };
  const queued = queueAttempts({ due_attempt: attempt }, 'receipt', 'receiptDueAtMs');
  const terminalRecords = Object.fromEntries(Array.from({ length: 1_500 }, (_, index) => [`terminal_${index}`, { status: 'provider_accepted', receiptDueAtMs: null }]));
  const db = createMemoryDb({ notification_jobs: { job_due: { ...buildJob(), jobId: 'job_due', fanoutCompletedAtMs: nowMs } }, notification_delivery_attempts: { ...terminalRecords, ...queued.notification_delivery_attempts }, notification_receipt_due_queue: queued.notification_receipt_due_queue });
  const result = await __testables.processDueNotificationReceipts({ db, nowMs, expo: { getPushNotificationReceiptsAsync: async () => ({ ticket_due: { status: 'ok' } }) } });
  assert.equal(result.checked, 1);
  assert.equal(db.data.notification_delivery_attempts.due_attempt.status, 'provider_accepted');
  assert.equal(Object.keys(db.data.notification_receipt_due_queue || {}).length, 0);
});

test('ambiguous Expo submission is terminal, warns, clears retry work, and is never auto-resent', async () => {
  const job = buildJob();
  const recipient = { authUid: 'recipient', token: expoToken, tokenHash: __testables.hashNotificationPushToken(expoToken) };
  const retrying = { attemptId: 'attempt_retry', jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', tokenHash: recipient.tokenHash, status: 'retrying', ticketStatus: 'ticket_rejected', receiptStatus: 'not_requested', retryable: true, attemptNumber: 1, availableAtMs: nowMs, expiresAtMs: job.expiresAtMs };
  const queued = queueAttempts({ attempt_retry: retrying }, 'retry', 'availableAtMs');
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: { ...job, fanoutCompletedAtMs: nowMs, counts: { ...job.counts, eligible: 1, ticketRejected: 1, retrying: 1 } } }, ...queued });
  let sends = 0;
  const result = await notificationWorker.retryNotificationDeliveryAttempt({ db, job, attemptId: 'attempt_retry', attempt: queued.notification_delivery_attempts.attempt_retry, recipient, nowMs, expo: { sendPushNotificationsAsync: async () => { sends += 1; throw new Error('socket closed after write'); } } });
  assert.equal(result.reason, 'SUBMISSION_UNKNOWN');
  assert.equal(sends, 1);
  assert.equal(db.data.notification_delivery_attempts.attempt_retry.status, 'submission_unknown');
  assert.equal(db.data.notification_delivery_warnings[job.jobId].code, 'SUBMISSION_UNKNOWN');
  assert.equal(Object.keys(db.data.notification_attempt_retry_queue || {}).length, 0);
  const recovery = await __testables.retryDueNotificationAttempts({ db, nowMs: nowMs + 300_000, expo: { sendPushNotificationsAsync: async () => { sends += 1; return []; } } });
  assert.equal(recovery.retried, 0);
  assert.equal(sends, 1);
});

test('payload byte enforcement measures the real destination token and reports provider headroom', () => {
  const job = buildJob();
  const oversizedToken = `ExponentPushToken[${'x'.repeat(3_700)}]`;
  assert.throws(() => __testables.buildNotificationExpoPushMessage(job, { token: oversizedToken }, nowMs), /provider size limit/iu);
  assert.equal(notificationWorker.MAX_EXPO_PAYLOAD_BYTES, 3_800);
});

test('coalescing is monotonic by source order and an older late event cannot supersede newer work', async () => {
  const db = createMemoryDb();
  const newer = buildJob({ sourceId: 'newer', coalescingKey: 'tour-state', sourceOrderMs: nowMs + 2 });
  const older = buildJob({ sourceId: 'older', coalescingKey: 'tour-state', sourceOrderMs: nowMs + 1 });
  await __testables.enqueueNotificationJob({ db, job: newer });
  const late = await __testables.enqueueNotificationJob({ db, job: older });
  assert.equal(late.job.status, 'expired');
  const state = Object.values(db.data.notification_job_coalescing)[0];
  assert.equal(state.jobId, newer.jobId);
  assert.equal(db.data.notification_jobs[newer.jobId].status, 'queued');
});

test('coalescing handoff retries close a crash after publication before prior expiry', async () => {
  const db = createMemoryDb();
  const previous = buildJob({ sourceId: 'previous', coalescingKey: 'crash-safe', sourceOrderMs: nowMs });
  const next = buildJob({ sourceId: 'next', coalescingKey: 'crash-safe', sourceOrderMs: nowMs + 1 });
  await __testables.enqueueNotificationJob({ db, job: previous });
  await assert.rejects(() => __testables.enqueueNotificationJob({ db, job: next, afterCoalescingPublished: async () => { throw new Error('injected crash'); } }), /injected crash/iu);
  assert.equal(db.data.notification_jobs[previous.jobId].status, 'queued');
  assert.equal(db.data.notification_jobs[next.jobId].status, 'preparing');
  assert.equal(Object.values(db.data.notification_job_coalescing)[0].previousJobId, previous.jobId);
  await __testables.enqueueNotificationJob({ db, job: next });
  assert.equal(db.data.notification_jobs[previous.jobId].status, 'expired');
  assert.equal(db.data.notification_jobs[next.jobId].status, 'queued');
  assert.equal(Object.values(db.data.notification_job_coalescing)[0].previousJobId, null);
  assert.equal(Object.values(db.data.notification_job_fanout_queue).some((entry) => entry.targetId === previous.jobId), false);
});

test('safe admin requeue creates a new generation from the current canonical token without restarting fanout', async () => {
  const job = { ...buildJob(), status: 'provider_rejected', fanoutCompletedAtMs: nowMs, counts: { ...buildJob().counts, eligible: 1, ticketRejected: 1 } };
  const oldToken = 'ExponentPushToken[old-token]';
  const newToken = 'ExponentPushToken[new-token]';
  const oldHash = __testables.hashNotificationPushToken(oldToken);
  const newHash = __testables.hashNotificationPushToken(newToken);
  const session = { schemaVersion: 1, sessionId: 'sess_v1_0123456789abcdef0123456789abcdef', authUid: 'recipient', principalId: 'pax_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', principalType: 'passenger', tourId: 'TOUR_1', driverId: null, status: 'active', issuedAtMs: nowMs - 1_000, lastAuthenticatedAtMs: nowMs - 1_000, sessionRevision: 1, expiresAtMs: nowMs + 60_000 };
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: job }, notification_job_recipients: { [job.jobId]: { recipient: { generation: 1, attemptId: 'old_attempt', tokenHash: oldHash } } }, notification_job_token_claims: { [job.jobId]: { [oldHash]: 'recipient' } }, notification_delivery_attempts: { old_attempt: { attemptId: 'old_attempt', generation: 1, jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', tokenHash: oldHash, status: 'provider_rejected', ticketStatus: 'ticket_rejected', receiptStatus: 'provider_rejected', queueVersion: 0 } }, notification_devices: { recipient: { pushToken: newToken, tokenHash: newHash, status: 'active', permissionState: 'granted', operationalEligible: true } }, users: { recipient: {} }, app_sessions: { recipient: session }, tours: { TOUR_1: { participants: { recipient: { schemaVersion: 2, userId: 'recipient', principalId: session.principalId, sessionId: session.sessionId, sessionExpiresAtMs: session.expiresAtMs } } } } });
  const result = await __testables.requeueFailedNotificationJob({ db, jobId: job.jobId, nowMs });
  assert.equal(result.requeued, 1);
  assert.equal(db.data.notification_delivery_attempts.old_attempt.status, 'superseded');
  const state = db.data.notification_job_recipients[job.jobId].recipient;
  assert.equal(state.generation, 2);
  assert.equal(db.data.notification_delivery_attempts[state.attemptId].tokenHash, newHash);
  assert.equal(Object.keys(db.data.notification_attempt_retry_queue).length, 1);
  assert.equal(db.data.notification_job_fanout_queue, undefined);
});

test('all seven source triggers request retry delivery and terminal timestamps remain first-write stable', async () => {
  const triggerFiles = ['broadcastFunctions.js', 'chatNotificationFunctions.js', 'itineraryNotificationFunction.js', 'driverTourPackNotificationFunction.js', 'safetyNotificationFunction.js'];
  const retryDeclarations = triggerFiles.reduce((count, file) => count + (fs.readFileSync(path.join(__dirname, '../functions/src/domains/notifications', file), 'utf8').match(/retry:\s*true/gu) || []).length, 0);
  assert.equal(retryDeclarations, 7);
  const job = { ...buildJob(), status: 'receipt_pending', fanoutCompletedAtMs: nowMs, completedAtMs: nowMs - 10_000, counts: { ...buildJob().counts, eligible: 1, receiptAccepted: 1 } };
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: job } });
  await __testables.refreshNotificationJobStatus(db, job.jobId, nowMs);
  assert.equal(db.data.notification_jobs[job.jobId].completedAtMs, nowMs - 10_000);
});

test('transient author lookups propagate for trigger retry while definite invalid authors return normally', async () => {
  const transient = Object.assign(new Error('auth unavailable'), { code: 'auth/internal-error' });
  await assert.rejects(() => verifyBroadcastAuthor('admin', { auth: { getUser: async () => { throw transient; } }, verifyAdmin: async () => true }), transient);
  assert.equal(await verifyBroadcastAuthor('missing', { auth: { getUser: async () => { throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); } }, verifyAdmin: async () => true }), false);
});

test('driver pack ordering uses revision then source event id and rejects late same-revision events', () => {
  assert.equal(shouldReplaceDriverPackChange({ revision: 8, sourceEventId: 'event_b', notificationStatus: 'provider_accepted' }, 8, 'event_a'), false);
  assert.equal(shouldReplaceDriverPackChange({ revision: 8, sourceEventId: 'event_a' }, 8, 'event_b'), true);
  assert.equal(shouldReplaceDriverPackChange({ revision: 9, sourceEventId: 'event_z' }, 8, 'event_zzzz'), false);
});

test('delivery reporting separates ticket, pending, accepted and rejected counts and mirrors safety logs', async () => {
  const job = { ...buildJob(), jobId: 'safety_job', sourceType: 'critical_safety_event', status: 'partial', eventId: 'event_1', senderAuthUid: 'reporter', counts: { eligible: 4, ticketAccepted: 3, receiptPending: 1, receiptAccepted: 1, receiptRejected: 1, ticketRejected: 1, submissionUnknown: 0 } };
  const base = { notificationDeliveryJobId: job.jobId };
  const db = createMemoryDb({ tours: { TOUR_1: { safetyAlerts: { event_1: base } } }, globalSafetyAlerts: { event_1: base }, logs: { reporter: { safety: { event_1: base } } } });
  await notificationSourceStatus.syncNotificationSourceStatus(db, job, nowMs);
  for (const record of [db.data.tours.TOUR_1.safetyAlerts.event_1, db.data.globalSafetyAlerts.event_1, db.data.logs.reporter.safety.event_1]) {
    assert.equal(record.notificationSuccessCount, 1);
    assert.equal(record.notificationErrorCount, 2);
  }
});

test('durable audience preview preserves cross-page token dedupe and cumulative counts across requests', async () => {
  const shared = 'ExponentPushToken[shared-preview-token]';
  const devices = Object.fromEntries(Array.from({ length: 501 }, (_, index) => {
    const token = index === 0 || index === 500 ? shared : `ExponentPushToken[preview-${index}]`;
    return [`user_${String(index).padStart(4, '0')}`, { pushToken: token, tokenHash: __testables.hashNotificationPushToken(token), status: 'active', permissionState: 'granted', marketingEligible: true, marketingPreferences: { day_trips: true } }];
  }));
  const job = __testables.buildNotificationPreviewJob({ categoryKey: 'day_trips' }, nowMs);
  const previewId = 'preview_v1_test';
  const db = createMemoryDb({ notification_devices: devices, notification_audience_previews: { [previewId]: { schemaVersion: 1, previewId, ownerAuthUid: 'admin', targetKey: 'marketing:day_trips', job, cursor: null, status: 'processing', audience: 0, eligible: 0, skipped: 0, pages: 0, skipReasons: {}, uidClaims: {}, tokenClaims: {}, createdAtMs: nowMs, updatedAtMs: nowMs, expiresAtMs: nowMs + 600_000 } } });
  const first = await notificationAdminFunctions.processAudiencePreviewChunk(db, previewId, 'admin', nowMs);
  assert.equal(first.complete, false);
  const second = await notificationAdminFunctions.processAudiencePreviewChunk(db, previewId, 'admin', nowMs + 1);
  assert.equal(second.complete, true);
  assert.equal(second.audience, 501);
  assert.equal(second.eligible, 500);
  assert.equal(second.skipReasons.duplicate_token, 1);
});

test('durable source handoff retries converge across failures before source, before enqueue and before status', async () => {
  const order = [];
  await assert.rejects(() => runNotificationSourceHandoff({ persistSource: async () => { order.push('source'); throw new Error('source failed'); }, enqueue: async () => { order.push('enqueue'); }, publishStatus: async () => { order.push('status'); } }), /source failed/iu);
  assert.deepEqual(order, ['source']);

  const db = createMemoryDb();
  const job = buildJob({ sourceId: 'durable-handoff' });
  let failEnqueue = true;
  const persistSource = () => db.ref().update({ 'durable_sources/source_1': { ready: true } });
  const enqueue = async () => {
    if (failEnqueue) { failEnqueue = false; throw new Error('enqueue failed'); }
    return __testables.enqueueNotificationJob({ db, job });
  };
  const publishStatus = (result) => db.ref('durable_sources/source_1').update({ status: result.job.status, jobId: result.jobId });
  await assert.rejects(() => runNotificationSourceHandoff({ persistSource, enqueue, publishStatus }), /enqueue failed/iu);
  assert.equal(db.data.durable_sources.source_1.ready, true);
  assert.equal(db.data.notification_jobs, undefined);
  await runNotificationSourceHandoff({ persistSource, enqueue, publishStatus });
  assert.equal(Object.keys(db.data.notification_jobs).length, 1);

  let failStatus = true;
  const publishWithFailure = async (result) => {
    if (failStatus) { failStatus = false; throw new Error('status failed'); }
    return publishStatus(result);
  };
  await assert.rejects(() => runNotificationSourceHandoff({ persistSource, enqueue, publishStatus: publishWithFailure }), /status failed/iu);
  await runNotificationSourceHandoff({ persistSource, enqueue, publishStatus: publishWithFailure });
  assert.equal(Object.keys(db.data.notification_jobs).length, 1);
  assert.equal(db.data.durable_sources.source_1.jobId, job.jobId);
});
