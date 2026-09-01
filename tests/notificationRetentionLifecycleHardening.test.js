'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { persistMarketingNotificationDetail } = require('../functions/src/domains/notifications/broadcastFunctions');
const {
  requeueFailedNotificationJob,
} = require('../functions/src/domains/notifications/notificationAdminFunctions');
const { processDueNotificationReceipts, retryDueNotificationAttempts } = require('../functions/src/domains/notifications/notificationReceipts');
const { runNotificationJob } = require('../functions/src/domains/notifications/notificationWorker');
const notificationPublic = require('../functions/src/domains/notifications/public');
const {
  buildRetentionQueueKey,
} = require('../functions/src/domains/notification-retention/state');
const canaryScript = require('../functions/scripts/notificationRetentionCanary');
const normalRunScript = require('../functions/scripts/notificationRetentionRun');
const rolloutScript = require('../functions/scripts/notificationRetentionRollout');
const preparationScript = require('../functions/scripts/notificationRetentionPreparation');
const preflightScript = require('../functions/scripts/notificationRetentionPreflight');
const shadowScript = require('../functions/scripts/notificationRetentionShadow');
const { sanitizeOperationalOutput } = require('../functions/scripts/notificationRetentionTooling');
const {
  createNotificationRetentionMemoryDb,
} = require('./helpers/notificationRetentionMemoryDb');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const splitPath = (value) => String(value || '').split('/').filter(Boolean);
const readPath = (state, targetPath) => splitPath(targetPath).reduce((current, key) => current?.[key], state);
const writePath = (state, targetPath, value) => {
  const keys = splitPath(targetPath);
  let current = state;
  keys.slice(0, -1).forEach((key) => { current[key] ||= {}; current = current[key]; });
  if (!keys.length) throw new Error('Root writes are not required by this test double');
  if (value === null) delete current[keys.at(-1)];
  else current[keys.at(-1)] = clone(value);
};
const snapshot = (value) => ({ val: () => clone(value) });

const createMemoryDb = (initial = {}) => {
  const state = clone(initial);
  const ref = (targetPath = '') => {
    const api = {
      endAt: () => api,
      limitToFirst: () => api,
      once: async () => snapshot(readPath(state, targetPath)),
      orderByKey: () => api,
      transaction: async (updater) => {
        const current = clone(readPath(state, targetPath));
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: snapshot(current) };
        writePath(state, targetPath, next);
        return { committed: true, snapshot: snapshot(next) };
      },
    };
    return api;
  };
  return { ref, state };
};

const nowMs = 1_800_000_000_000;
const fencedJob = (jobId) => ({
  jobId,
  status: 'provider_rejected',
  completedAtMs: nowMs - 31 * 24 * 60 * 60 * 1000,
  retentionDueAtMs: nowMs - 24 * 60 * 60 * 1000,
  retentionGeneration: 1,
  retentionFence: {
    fenceId: 'retention_fence', status: 'compacting', leaseExpiresAtMs: nowMs - 1,
  },
});

test('account deletion consumes retention helpers through the notifications public boundary', () => {
  assert.equal(typeof notificationPublic.nextNotificationRetentionGeneration, 'function');
  assert.equal(typeof notificationPublic.scheduleNotificationRetentionIfEligible, 'function');
  assert.equal(Number.isSafeInteger(notificationPublic.NOTIFICATION_RETENTION_MS), true);
  const source = fs.readFileSync(path.join(__dirname, '../functions/src/domains/account-deletion/accountDeletionEffects.js'), 'utf8');
  assert.match(source, /require\('\.\.\/notifications\/public'\)/u);
  assert.doesNotMatch(source, /notificationRetentionIntegration/u);
});

test('canary refuses shadow and invokes exact compactor mode only from compactor', async () => {
  const admin = { app: () => ({ options: { projectId: 'project-test' } }), database: () => ({}) };
  const base = {
    apply: true, confirmProject: 'project-test', expectedRevision: 4, evidenceDigest: 'evidence',
    maxJobs: 1, maxAttemptPagesPerJob: 1, maxAttempts: 100, maxUpdatePaths: 500,
  };
  await assert.rejects(() => canaryScript.run({
    admin,
    options: { ...base, expectedPhase: 'shadow' },
    retention: {},
    nowMs,
  }), /expected-phase=compactor/u);

  let observed = null;
  const result = await canaryScript.run({
    admin,
    options: { ...base, expectedPhase: 'compactor' },
    retention: {
      readNotificationRetentionRollout: async () => ({
        phase: 'compactor', revision: 4, canaryPassed: false, evidenceDigest: 'evidence',
      }),
      ensureNotificationRetentionCanaryFixture: async () => ({
        ready: true, fixtureFingerprint: 'd'.repeat(64), jobId: 'retention_canary_v1_test',
      }),
      runNotificationRetentionCycle: async (options) => { observed = options; return { jobsCompleted: 1 }; },
    },
    nowMs,
  });
  assert.equal(observed.modeOverride, 'compactor');
  assert.deepEqual(observed.canary, {
    enabled: true, expectedPhase: 'compactor', expectedRevision: 4, evidenceDigest: 'evidence',
    fixtureFingerprint: 'd'.repeat(64), fixtureJobId: 'retention_canary_v1_test',
  });
  assert.equal(observed.budgets.pageSize, 100);
  assert.equal(observed.budgets.orphanPageSize, 1);
  assert.equal(observed.budgets.auxiliaryPageSize, 1);
  assert.equal(result.jobsCompleted, 1);

  await assert.rejects(() => canaryScript.run({
    admin,
    options: { ...base, expectedPhase: 'compactor' },
    retention: {
      readNotificationRetentionRollout: async () => ({
        phase: 'compactor', revision: 4, canaryPassed: true, evidenceDigest: 'evidence',
      }),
    },
    nowMs,
  }), /paused compactor evidence state/u);
});

test('rollout CLI requires an explicit post-canary activation flag', () => {
  const omittedRevision = rolloutScript.parseArgs([
    'set', '--apply', '--expected-phase=legacy', '--phase=shadow',
    '--preparation-complete', '--evidence-digest=evidence',
  ]);
  assert.equal(omittedRevision.expectedRevision, null);
  assert.throws(
    () => rolloutScript.validateTransitionOptions(omittedRevision),
    /expected-revision/u,
  );

  const base = {
    action: 'set',
    apply: true,
    expectedPhase: 'compactor',
    expectedRevision: 4,
    nextPhase: 'compactor',
    evidenceDigest: 'evidence',
  };
  assert.throws(() => rolloutScript.validateTransitionOptions(base), /activate-after-canary/u);
  assert.doesNotThrow(() => rolloutScript.validateTransitionOptions({
    ...base, activateAfterCanary: true,
  }));
});

test('shadow and normal runners require exact rollout state and invoke the production engine', async () => {
  const db = {};
  const admin = {
    app: () => ({ options: { projectId: 'project-test' } }),
    database: () => db,
  };
  let shadowObserved = null;
  const shadow = await shadowScript.run({
    admin,
    options: {
      apply: true,
      confirmProject: 'project-test',
      expectedPhase: 'shadow',
      expectedRevision: 3,
      maxJobs: 2,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({ phase: 'shadow', revision: 3 }),
      runNotificationRetentionCycle: async (options) => {
        shadowObserved = options;
        return { mode: 'shadow', metrics: { shadowMismatches: 0 } };
      },
    },
    legacyCleanup: async () => ({ deleted: 0 }),
    nowMs,
  });
  assert.equal(shadowObserved.modeOverride, 'shadow');
  assert.equal(shadowObserved.expectedPhase, 'shadow');
  assert.equal(shadowObserved.expectedRevision, 3);
  assert.equal(typeof shadowObserved.legacyCleanup, 'function');
  assert.equal(shadow.mode, 'shadow');

  let normalObserved = null;
  await normalRunScript.run({
    admin,
    options: {
      apply: true,
      confirmProject: 'project-test',
      expectedPhase: 'compactor',
      expectedRevision: 4,
      maxJobs: 25,
      maxAttemptPagesPerJob: 4,
      maxAttempts: 5_000,
      maxUpdatePaths: 500,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({
        phase: 'compactor', revision: 4, canaryPassed: true,
      }),
      runNotificationRetentionCycle: async (options) => { normalObserved = options; return {}; },
    },
    nowMs,
  });
  assert.equal(normalObserved.modeOverride, 'compactor');
  assert.equal(normalObserved.expectedPhase, 'compactor');
  assert.equal(normalObserved.expectedRevision, 4);
  assert.equal(normalObserved.canary, undefined);
  assert.equal(normalObserved.budgets.maxAttemptPages, 20);

  await assert.rejects(() => normalRunScript.run({
    admin,
    options: {
      apply: true,
      confirmProject: 'project-test',
      expectedPhase: 'compactor',
      expectedRevision: 4,
      maxJobs: 25,
      maxAttemptPagesPerJob: 4,
      maxAttempts: 5_000,
      maxUpdatePaths: 500,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({
        phase: 'compactor', revision: 4, canaryPassed: false,
      }),
    },
    nowMs,
  }), /passing canary evidence/u);

  await assert.rejects(() => shadowScript.run({
    admin,
    options: {
      apply: true,
      confirmProject: 'project-test',
      expectedPhase: 'shadow',
      expectedRevision: 3,
      maxJobs: 2,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({ phase: 'shadow', revision: 3 }),
      runNotificationRetentionCycle: async () => ({ budgetExhaustionReason: 'rollout_changed' }),
    },
    legacyCleanup: async () => ({ deleted: 0 }),
    nowMs,
  }), /changed during execution/u);

  await assert.rejects(() => normalRunScript.run({
    admin,
    options: {
      apply: true,
      confirmProject: 'project-test',
      expectedPhase: 'compactor',
      expectedRevision: 4,
      maxJobs: 25,
      maxAttemptPagesPerJob: 4,
      maxAttempts: 5_000,
      maxUpdatePaths: 500,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({
        phase: 'compactor', revision: 4, canaryPassed: true,
      }),
      runNotificationRetentionCycle: async () => ({ budgetExhaustionReason: 'rollout_changed' }),
    },
    nowMs,
  }), /changed during execution/u);
});

test('preparation is legacy-only and operational output removes identifiers and content', async () => {
  assert.equal(preparationScript.parseArgs(['--apply']).expectedRevision, null);
  const db = {};
  const admin = {
    app: () => ({ options: { projectId: 'project-test' } }),
    database: () => db,
  };
  await assert.rejects(() => preparationScript.run({
    admin,
    options: {
      apply: true, restart: false, confirmProject: 'project-test', expectedPhase: 'shadow',
      cursor: null, pageSize: 10, expectedRevision: 2,
    },
    retention: {
      readNotificationRetentionRollout: async () => ({ phase: 'shadow', revision: 2 }),
    },
    nowMs,
  }), /exact legacy rollout phase/u);
  const safe = sanitizeOperationalOutput({
    jobsDiscovered: 2,
    cursor: 'raw-attempt-key',
    jobId: 'raw-job',
    presentation: { title: 'private' },
    recipientUid: 'private-user',
  });
  assert.equal(safe.jobsDiscovered, 2);
  assert.equal(typeof safe.cursor, 'string');
  assert.equal(safe.cursor.length, 16);
  assert.equal(safe.jobId, undefined);
  assert.equal(safe.presentation, undefined);
  assert.equal(safe.recipientUid, undefined);
});

test('preflight rules checks exact privacy values and per-root indexes', () => {
  const validRules = {
    rules: {
      notification_retention: {
        '.read': false,
        '.write': false,
        v1: { jobs: { '.indexOn': ['retentionDueAtMs'] } },
      },
      notification_retention_rollout: { '.read': false, '.write': false },
      notification_jobs: { '.indexOn': ['retentionDueAtMs'] },
      notification_delivery_attempts: { '.indexOn': ['retentionDueAtMs'] },
      marketing_notification_details: { '.indexOn': ['retentionDueAtMs'] },
      notification_requeue_jobs: { '.indexOn': ['expiresAtMs', 'recoveryDueAtMs'] },
    },
  };
  assert.deepEqual(Object.values(preflightScript.inspectRetentionRules(validRules)), [
    true, true, true, true, true, true, true,
  ]);
  const unsafe = clone(validRules);
  unsafe.rules.notification_retention['.read'] = true;
  unsafe.rules.notification_retention_rollout['.write'] = 'auth != null';
  unsafe.rules.notification_jobs['.indexOn'] = ['updatedAtMs'];
  const inspected = preflightScript.inspectRetentionRules(unsafe);
  assert.equal(inspected.retentionRootPrivate, false);
  assert.equal(inspected.rolloutRootPrivate, false);
  assert.equal(inspected.retentionJobIndexPresent, false);
});

test('a completed zero-result requeue replay restores terminal status and durable retention', async () => {
  const jobId = 'notif_v1_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [jobId]: {
        schemaVersion: 1,
        jobId,
        status: 'retrying',
        createdAtMs: nowMs - notificationPublic.NOTIFICATION_RETENTION_MS,
        completedAtMs: nowMs - 1,
        expiresAtMs: nowMs + 60_000,
        retentionGeneration: 2,
        updatedAtMs: nowMs - 1,
      },
    },
    notification_requeue_jobs: {
      [jobId]: {
        schemaVersion: 1,
        requeueId: 'requeue_v1_test',
        jobId,
        sourceStatus: 'provider_rejected',
        sourceCompletedAtMs: nowMs - 1,
        status: 'complete',
        requeued: 0,
        skipped: 1,
        expiresAtMs: nowMs + 60_000,
      },
    },
  });
  const replayed = await requeueFailedNotificationJob({ db, jobId, nowMs });
  assert.equal(replayed.success, true);
  assert.equal(replayed.complete, true);
  assert.equal(db.getAtPath(`notification_jobs/${jobId}/status`), 'provider_rejected');
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue') || {}).length, 1);
});

test('authoritative per-job scheduling survives a foreign compatibility queue projection', async () => {
  const jobId = 'notif_v1_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const completedAtMs = nowMs - notificationPublic.NOTIFICATION_RETENTION_MS;
  const job = {
    schemaVersion: 1,
    jobId,
    status: 'provider_accepted',
    completedAtMs,
    retentionDueAtMs: nowMs,
    retentionGeneration: 0,
    updatedAtMs: completedAtMs,
  };
  const queueKey = buildRetentionQueueKey(jobId, nowMs, 1);
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [jobId]: job },
    notification_retention: {
      v1: { queue: { [queueKey]: { jobId: 'foreign-job', generation: 1 } } },
    },
  });
  const scheduled = await notificationPublic.scheduleNotificationRetentionIfEligible(db, job, nowMs);
  assert.equal(scheduled.reason, 'scheduled');
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${jobId}/jobId`), jobId);
  assert.equal(db.getAtPath(`notification_retention/v1/queue/${queueKey}/jobId`), 'foreign-job');
});

test('marketing detail replay preserves exact ownership and rejects reused source paths', async () => {
  const db = createMemoryDb();
  const detail = {
    schemaVersion: 1,
    broadcastId: 'broadcast-a',
    categoryKey: 'day_trips',
    deliveryJobId: 'job-a',
    title: 'Title',
    body: 'Body',
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
    retentionDueAtMs: nowMs + 60_000 + notificationPublic.NOTIFICATION_RETENTION_MS,
    cta: null,
    status: 'active',
    updatedAtMs: nowMs,
  };
  await persistMarketingNotificationDetail({ db, broadcastId: detail.broadcastId, detail });
  db.state.marketing_notification_details['broadcast-a'].deliveryStatus = 'provider_accepted';
  db.state.marketing_notification_details['broadcast-a'].updatedAtMs = nowMs + 1;
  const replayed = await persistMarketingNotificationDetail({ db, broadcastId: detail.broadcastId, detail });
  assert.equal(replayed.deliveryStatus, 'provider_accepted');
  assert.equal(replayed.retentionDueAtMs, detail.retentionDueAtMs);

  db.state.marketing_notification_details['broadcast-a'].retentionDueAtMs -= 1;
  await assert.rejects(() => persistMarketingNotificationDetail({
    db, broadcastId: detail.broadcastId, detail,
  }), (error) => error.code === 'MARKETING_NOTIFICATION_DETAIL_OWNERSHIP_CONFLICT');
  db.state.marketing_notification_details['broadcast-a'].retentionDueAtMs = detail.retentionDueAtMs;

  await assert.rejects(() => persistMarketingNotificationDetail({
    db,
    broadcastId: detail.broadcastId,
    detail: { ...detail, categoryKey: 'cruises_ferries', deliveryJobId: 'job-b', createdAtMs: nowMs + 2 },
  }), (error) => error.code === 'MARKETING_NOTIFICATION_DETAIL_OWNERSHIP_CONFLICT');
  assert.equal(db.state.marketing_notification_details['broadcast-a'].deliveryJobId, 'job-a');
  assert.equal(db.state.marketing_notification_details['broadcast-a'].categoryKey, 'day_trips');
});

test('fenced fanout preserves and defers the exact queue pointer', async () => {
  const queueKey = `${nowMs}~fanout~000001`;
  const db = createMemoryDb({
    notification_jobs: { job_fenced: { ...fencedJob('job_fenced'), queueKey, queueVersion: 1 } },
    notification_job_fanout_queue: {
      [queueKey]: { targetId: 'job_fenced', dueAtMs: nowMs, version: 1, lease: { ownerId: 'worker', expiresAtMs: nowMs + 1 } },
    },
  });
  const result = await runNotificationJob({
    db, jobId: 'job_fenced', nowMs, queueKey, queueVersion: 1, queueOwnerId: 'worker',
  });
  assert.equal(result.status, 'retention_fenced');
  assert.equal(db.state.notification_job_fanout_queue[queueKey].targetId, 'job_fenced');
  assert.equal(db.state.notification_job_fanout_queue[queueKey].lease, null);
  assert.equal(db.state.notification_job_fanout_queue[queueKey].dueAtMs, nowMs + 120_000);
});

test('fenced receipt and retry attempts preserve and defer exact queue pointers', async () => {
  const receiptKey = `${nowMs}~receipt~000001`;
  const retryKey = `${nowMs}~retry~000001`;
  const db = createMemoryDb({
    notification_jobs: { job_fenced: fencedJob('job_fenced') },
    notification_delivery_attempts: {
      receipt_attempt: {
        attemptId: 'receipt_attempt', jobId: 'job_fenced', queueKey: receiptKey, queueVersion: 1,
        status: 'receipt_pending', receiptStatus: 'receipt_pending', ticketId: 'ticket',
      },
      retry_attempt: {
        attemptId: 'retry_attempt', jobId: 'job_fenced', queueKey: retryKey, queueVersion: 1,
        status: 'retrying', availableAtMs: nowMs,
      },
    },
    notification_receipt_due_queue: {
      [receiptKey]: { targetId: 'receipt_attempt', dueAtMs: nowMs, version: 1 },
    },
    notification_attempt_retry_queue: {
      [retryKey]: { targetId: 'retry_attempt', dueAtMs: nowMs, version: 1 },
    },
  });
  let providerCalls = 0;
  const receipts = await processDueNotificationReceipts({
    db, nowMs, expo: { getPushNotificationReceiptsAsync: async () => { providerCalls += 1; return {}; } },
  });
  const retries = await retryDueNotificationAttempts({
    db, nowMs, expo: { sendPushNotificationsAsync: async () => { providerCalls += 1; return []; } },
  });
  assert.equal(receipts.checked, 0);
  assert.equal(retries.retried, 0);
  assert.equal(providerCalls, 0);
  assert.equal(db.state.notification_receipt_due_queue[receiptKey].dueAtMs, nowMs + 120_000);
  assert.equal(db.state.notification_attempt_retry_queue[retryKey].dueAtMs, nowMs + 120_000);
  assert.equal(db.state.notification_receipt_due_queue[receiptKey].lease, null);
  assert.equal(db.state.notification_attempt_retry_queue[retryKey].lease, null);
});
