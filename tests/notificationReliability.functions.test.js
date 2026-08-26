const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-notification-reliability',
  storageBucket: 'demo-llt-notification-reliability.appspot.com',
});

const { __testables } = require('../functions/index.js');

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
  else current[keys.at(-1)] = clone(value);
};

const createMemoryDb = (initial = {}) => {
  const data = clone(initial);
  const snapshot = (value) => ({ val: () => clone(value) });
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
        const entries = matchesQuery(Object.entries(raw || {}), query)
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
          return { val: () => Object.fromEntries(records) };
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
    notification_devices: { recipient: { pushToken: expoToken, tokenHash: recipient.tokenHash, status: 'active' } },
    users: { recipient: { pushToken: expoToken } },
  });
  const attemptRef = db.ref('notification_delivery_attempts/attempt_1');
  const claimed = { attemptRef, attempt: { attemptNumber: 1 } };
  await __testables.persistNotificationTicketResult({ db, job, claimed, recipient, ticket: { status: 'ok', id: 'ticket_1' }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_1.status, 'receipt_pending');
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptRef: db.ref('notification_delivery_attempts/attempt_2') }, recipient, ticket: { status: 'error', details: { error: 'MessageRateExceeded' } }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_2.status, 'retrying');
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptRef: db.ref('notification_delivery_attempts/attempt_3') }, recipient, ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } }, nowMs });
  assert.equal(db.data.notification_delivery_attempts.attempt_3.status, 'ticket_rejected');
  assert.equal(db.data.notification_devices.recipient.pushToken, null);
  await __testables.persistNotificationTicketResult({ db, job, claimed: { ...claimed, attemptRef: db.ref('notification_delivery_attempts/attempt_4') }, recipient, ticket: { status: 'error', details: { error: 'InvalidCredentials' } }, nowMs });
  assert.equal(db.data.notification_delivery_warnings[job.jobId].code, 'InvalidCredentials');
});

test('receipt processor accepts success, retries temporary errors, warns on configuration, and clears only matching stale tokens', async () => {
  const job = buildJob();
  const tokenHash = __testables.hashNotificationPushToken(expoToken);
  const due = (ticketId, extra = {}) => ({ jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', ticketId, tokenHash, status: 'receipt_pending', ticketStatus: 'ticket_accepted', receiptStatus: 'receipt_pending', receiptDueAtMs: nowMs, receiptWindowExpiresAtMs: nowMs + 60_000, attemptNumber: 1, ...extra });
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    notification_devices: { recipient: { pushToken: expoToken, tokenHash, status: 'active' } },
    users: { recipient: { pushToken: expoToken } },
    notification_delivery_attempts: { accepted: due('ok'), rate: due('rate'), config: due('config'), stale: due('stale', { tokenHash: 'old-token-hash' }) },
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
  const db = createMemoryDb({ notification_jobs: { [job.jobId]: job }, notification_delivery_attempts: { missing: pending('missing', nowMs + 1), expired: pending('expired', nowMs), failed: pending('failed', nowMs + 1) } });
  const missing = await __testables.processDueNotificationReceipts({ db, nowMs, expo: { getPushNotificationReceiptsAsync: async () => ({}) } });
  assert.equal(missing.missing, 2);
  assert.equal(missing.rejected, 1);
  assert.equal(db.data.notification_delivery_attempts.expired.safeErrorCode, 'RECEIPT_EXPIRED');
  const failedDb = createMemoryDb({ notification_delivery_attempts: { failed: pending('failed', nowMs + 1) } });
  const failed = await __testables.processDueNotificationReceipts({ db: failedDb, nowMs, expo: { getPushNotificationReceiptsAsync: async () => { throw new Error('offline'); } } });
  assert.equal(failed.requestFailed, 1);
  assert.equal(failedDb.data.notification_delivery_attempts.failed.safeErrorCode, 'RECEIPT_REQUEST_FAILED');
});

test('expired or superseded jobs never send, and a worker crash records a retry with its lease released', async () => {
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
  assert.equal(crashed.status, 'retrying');
  assert.equal(db.data.notification_jobs[job.jobId].lease ?? null, null);
  assert.equal(db.data.notification_jobs[job.jobId].attemptCount, 1);
});

test('stale sending attempts are recovered exactly once, while retrying attempts keep job reporting retrying', async () => {
  const job = buildJob();
  const tokenHash = __testables.hashNotificationPushToken(expoToken);
  const session = { schemaVersion: 1, sessionId: 'sess_v1_0123456789abcdef0123456789abcdef', authUid: 'recipient', principalId: 'pax_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', principalType: 'passenger', tourId: 'TOUR_1', driverId: null, status: 'active', issuedAtMs: nowMs - 1_000, lastAuthenticatedAtMs: nowMs - 1_000, sessionRevision: 1, expiresAtMs: nowMs + 60_000 };
  const db = createMemoryDb({
    notification_jobs: { [job.jobId]: job },
    notification_delivery_attempts: { stale: { jobId: job.jobId, recipientUid: 'recipient', installationUid: 'recipient', tokenHash, status: 'sending', attemptNumber: 1, updatedAtMs: nowMs - __testables.STALE_SENDING_ATTEMPT_MS, availableAtMs: nowMs } },
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
  await __testables.refreshNotificationJobStatus(db, job.jobId, nowMs);
  assert.equal(db.data.notification_jobs[job.jobId].status, 'retrying');
});
