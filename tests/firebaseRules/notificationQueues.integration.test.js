const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  initializeTestEnvironment,
  assertFails,
} = require('@firebase/rules-unit-testing');

const {
  buildNotificationQueueKey,
  buildQueueEntry,
  loadDueQueueEntries,
  transitionQueuedRecord,
} = require('../../functions/src/domains/notifications/notificationQueues');

const PROJECT_ID = 'demo-llt-notification-queue-integration';
const NOW_MS = 1_800_000_000_000;
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

let testEnv;
let databaseURL;

const parseEmulator = () => {
  const [host, portText] = String(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '').split(':');
  if (!host || !portText) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  return { host, port: Number(portText) };
};

const withServerDb = (callback) => testEnv.withSecurityRulesDisabled(async (context) => (
  callback(context.database(databaseURL))
));

test.before(async () => {
  const emulator = parseEmulator();
  databaseURL = `http://${emulator.host}:${emulator.port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
});

test.beforeEach(async () => testEnv.clearDatabase());
test.after(async () => testEnv?.cleanup());

test('terminal jobs cannot starve the dedicated due fan-out queue', async () => {
  await withServerDb(async (db) => {
    const terminalJobs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `notification_jobs/terminal_${index}`,
      { status: 'provider_accepted', availableAtMs: NOW_MS - 10_000 - index },
    ]));
    const queueKey = buildNotificationQueueKey(NOW_MS - 1, 'due_job', 1);
    await db.ref().update({
      ...terminalJobs,
      'notification_jobs/due_job': { status: 'queued', queueKey, queueVersion: 1 },
      [`notification_job_fanout_queue/${queueKey}`]: buildQueueEntry('fanout', 'due_job', NOW_MS - 1, 1),
    });
    const due = await loadDueQueueEntries(db, 'fanout', NOW_MS, 25);
    assert.deepEqual(due.map(([, value]) => value.targetId), ['due_job']);
  });
});

test('terminal attempts and missing receipt dates cannot starve retry or receipt queues', async () => {
  await withServerDb(async (db) => {
    const terminalAttempts = Object.fromEntries(Array.from({ length: 1_101 }, (_, index) => [
      `notification_delivery_attempts/terminal_${index}`,
      { status: 'provider_accepted', ...(index < 101 ? { availableAtMs: NOW_MS - index } : {}) },
    ]));
    const retryKey = buildNotificationQueueKey(NOW_MS - 2, 'retry_attempt', 3);
    const receiptKey = buildNotificationQueueKey(NOW_MS - 1, 'receipt_attempt', 5);
    await db.ref().update({
      ...terminalAttempts,
      [`notification_attempt_retry_queue/${retryKey}`]: buildQueueEntry('retry', 'retry_attempt', NOW_MS - 2, 3),
      [`notification_receipt_due_queue/${receiptKey}`]: buildQueueEntry('receipt', 'receipt_attempt', NOW_MS - 1, 5),
    });
    assert.deepEqual((await loadDueQueueEntries(db, 'retry', NOW_MS, 100)).map(([, value]) => value.targetId), ['retry_attempt']);
    assert.deepEqual((await loadDueQueueEntries(db, 'receipt', NOW_MS, 1_000)).map(([, value]) => value.targetId), ['receipt_attempt']);
  });
});

test('due movement atomically replaces the old queue key and terminal transition removes it', async () => {
  await withServerDb(async (db) => {
    const targetPath = 'notification_delivery_attempts/attempt_1';
    const first = await transitionQueuedRecord(db, {
      targetPath,
      current: {},
      patch: { status: 'retrying', availableAtMs: NOW_MS + 1_000 },
      queueKind: 'retry',
      dueAtMs: NOW_MS + 1_000,
      targetId: 'attempt_1',
    });
    const current = (await db.ref(targetPath).once('value')).val();
    const second = await transitionQueuedRecord(db, {
      targetPath,
      current,
      patch: { status: 'retrying', availableAtMs: NOW_MS - 1 },
      queueKind: 'retry',
      dueAtMs: NOW_MS - 1,
      targetId: 'attempt_1',
    });
    assert.notEqual(first.queueKey, second.queueKey);
    assert.equal((await db.ref(`notification_attempt_retry_queue/${first.queueKey}`).once('value')).exists(), false);
    assert.equal((await db.ref(`notification_attempt_retry_queue/${second.queueKey}`).once('value')).exists(), true);
    const moved = (await db.ref(targetPath).once('value')).val();
    await transitionQueuedRecord(db, {
      targetPath,
      current: moved,
      patch: { status: 'provider_rejected', availableAtMs: null },
      queueKind: null,
      dueAtMs: null,
      targetId: 'attempt_1',
    });
    assert.equal((await db.ref('notification_attempt_retry_queue').once('value')).exists(), false);
    assert.equal((await db.ref(targetPath).once('value')).val().queueKey, undefined);
  });
});

test('null due state never creates an active queue entry', async () => {
  await withServerDb(async (db) => {
    await transitionQueuedRecord(db, {
      targetPath: 'notification_delivery_attempts/no_due',
      current: {},
      patch: { status: 'provider_rejected', receiptDueAtMs: null },
      queueKind: null,
      dueAtMs: null,
      targetId: 'no_due',
    });
    assert.equal((await db.ref('notification_receipt_due_queue').once('value')).exists(), false);
  });
});

test('all work queues and migration authority remain server private', async () => {
  const client = testEnv.authenticatedContext('client-user').database(databaseURL);
  const adminClient = testEnv.authenticatedContext('9CWQ4705gVRkfW5Xki5LyvrmVp23').database(databaseURL);
  for (const root of [
    'notification_job_fanout_queue',
    'notification_job_recipients',
    'notification_attempt_retry_queue',
    'notification_receipt_due_queue',
    'notification_migrations',
    'notification_device_locks',
    'notification_device_tombstones',
    'notification_audience_previews',
    'notification_requeue_jobs',
    'safety_status_locks',
  ]) {
    await assertFails(client.ref(root).get());
    await assertFails(client.ref(root).set({ forged: true }));
    await assertFails(adminClient.ref(root).get());
    await assertFails(adminClient.ref(root).set({ forged: true }));
  }
});
