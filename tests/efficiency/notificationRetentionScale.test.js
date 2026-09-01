const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-notification-retention-scale',
  databaseURL: 'https://demo-llt-notification-retention-scale.firebaseio.com',
});

const {
  DEFAULT_RETENTION_BUDGETS,
  RETENTION_MS,
  buildCanaryEvidenceFingerprint,
  buildShadowEvidenceFingerprint,
  ensureNotificationRetentionScheduled,
  runNotificationRetentionCycle,
} = require('../../functions/src/domains/notification-retention/public');
const { createNotificationRetentionMemoryDb } = require('../helpers/notificationRetentionMemoryDb');

const NOW_MS = 1_800_000_000_000;
const JOB_ID = 'notif_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const shadowEvidence = () => {
  const evidence = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision: 6,
    status: 'passed',
    shadowEligible: 1,
    shadowLegacyEligible: 1,
    shadowMismatches: 0,
    compactorScanned: 1,
    legacyScanned: 1,
    hasMore: false,
  };
  return { ...evidence, evidenceFingerprint: buildShadowEvidenceFingerprint(evidence) };
};

const canaryEvidence = () => {
  const evidence = {
    schemaVersion: 1,
    phase: 'canary',
    rolloutRevision: 7,
    status: 'passed',
    evidenceDigest: 'retention-scale-evidence',
    shadowEvidenceFingerprint: shadowEvidence().evidenceFingerprint,
    jobsDiscovered: 1,
    jobsClaimed: 1,
    jobsCompleted: 1,
    attemptsDeleted: 1,
    failures: 0,
    fixtureFingerprint: 'b'.repeat(64),
    fixtureCompleted: true,
  };
  return { ...evidence, evidenceFingerprint: buildCanaryEvidenceFingerprint(evidence) };
};

const retentionEvidence = () => ({ shadow: shadowEvidence(), canary: canaryEvidence() });

const rollout = (phase = 'compactor') => ({
  schemaVersion: 1,
  phase,
  revision: phase === 'compactor' ? 8 : 7,
  preparationComplete: true,
  preparationRolloutRevision: 5,
  evidenceDigest: 'retention-scale-evidence',
  ...(phase === 'compactor'
    ? {
      shadowEvidenceFingerprint: shadowEvidence().evidenceFingerprint,
      shadowEvidenceRevision: 6,
      canaryPassed: true,
      canaryEvidenceFingerprint: canaryEvidence().evidenceFingerprint,
      canaryEvidenceRevision: 7,
    }
    : {}),
  updatedAtMs: NOW_MS - 1,
});

const canonicalJob = (jobId, overrides = {}) => ({
  schemaVersion: 1,
  jobId,
  status: 'provider_accepted',
  createdAtMs: NOW_MS - RETENTION_MS - 10_000,
  completedAtMs: NOW_MS - RETENTION_MS,
  retentionDueAtMs: NOW_MS,
  updatedAtMs: NOW_MS - RETENTION_MS,
  retentionGeneration: 0,
  queueKind: null,
  queueKey: null,
  queueVersion: 0,
  ...overrides,
});

const terminalAttempt = (jobId, index, { queued = false } = {}) => ({
  schemaVersion: 2,
  attemptId: `attempt_${String(index).padStart(7, '0')}`,
  jobId,
  status: 'provider_accepted',
  retentionDueAtMs: NOW_MS,
  ...(queued ? {
    queueKind: 'retry',
    queueKey: `retry_${String(index).padStart(7, '0')}`,
    queueVersion: 1,
  } : {}),
});

const seedScheduledJob = async (db, job) => {
  db.data.notification_jobs ||= {};
  db.data.notification_jobs[job.jobId] = JSON.parse(JSON.stringify(job));
  const scheduled = await ensureNotificationRetentionScheduled({ db, jobId: job.jobId, job, nowMs: NOW_MS });
  assert.equal(scheduled.reason, 'scheduled');
};

const buildScaleDb = async ({ unrelated = 0 } = {}) => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_delivery_attempts: {},
    notification_attempt_retry_queue: {},
    notification_jobs: {},
  });
  await seedScheduledJob(db, canonicalJob(JOB_ID));
  for (let index = 0; index < 50_000; index += 1) {
    const attempt = terminalAttempt(JOB_ID, index, { queued: true });
    db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
    db.data.notification_attempt_retry_queue[attempt.queueKey] = {
      targetId: attempt.attemptId, version: 1, dueAtMs: NOW_MS,
    };
  }
  for (let index = 0; index < unrelated; index += 1) {
    const attemptId = `zz_unrelated_${String(index).padStart(7, '0')}`;
    const otherJobId = `other_${String(index).padStart(7, '0')}`;
    db.data.notification_delivery_attempts[attemptId] = {
      schemaVersion: 2, attemptId, jobId: otherJobId,
      status: 'provider_accepted', retentionDueAtMs: NOW_MS,
    };
    db.data.notification_jobs[otherJobId] = { jobId: otherJobId, status: 'provider_accepted' };
  }
  return db;
};

test('default budgets enforce the reviewed page, fairness, global and memory ceilings', () => {
  assert.equal(DEFAULT_RETENTION_BUDGETS.pageSize, 250);
  assert.equal(DEFAULT_RETENTION_BUDGETS.queryLimit, 251);
  assert.equal(DEFAULT_RETENTION_BUDGETS.maxAttemptPagesPerJob, 4);
  assert.equal(DEFAULT_RETENTION_BUDGETS.maxAttemptsPerJobPerCycle, 1_000);
  assert.equal(DEFAULT_RETENTION_BUDGETS.maxAttemptsPerInvocation, 5_000);
  assert.equal(DEFAULT_RETENTION_BUDGETS.maxJobsPerInvocation, 25);
  assert.equal(DEFAULT_RETENTION_BUDGETS.maxUpdatePaths, 500);
  assert.equal(DEFAULT_RETENTION_BUDGETS.orphanPageSize, 250);
  assert.equal(
    DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs
      > DEFAULT_RETENTION_BUDGETS.functionTimeoutSeconds * 1_000,
    true,
  );
});

test('hasMore distinguishes an exactly full final page from one remaining record', async () => {
  const build = async (attemptCount) => {
    const db = createNotificationRetentionMemoryDb({
      notification_retention_rollout: { v1: rollout() },
      notification_retention: { v1: { evidence: retentionEvidence() } },
      notification_jobs: {},
      notification_delivery_attempts: {},
    });
    await seedScheduledJob(db, canonicalJob(JOB_ID));
    for (let index = 0; index < attemptCount; index += 1) {
      const attempt = terminalAttempt(JOB_ID, index);
      db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
    }
    return db;
  };
  const exactDb = await build(1_000);
  const exact = await runNotificationRetentionCycle({
    db: exactDb, nowMs: NOW_MS, ownerId: 'exact-page-worker', budgets: { orphanPageSize: 250 },
  });
  assert.equal(exact.metrics.attemptPagesQueried, 4);
  assert.equal(exact.metrics.attemptsDeleted, 1_000);
  assert.equal(exact.hasMore, false);
  assert.equal(exactDb.getAtPath(`notification_jobs/${JOB_ID}`), undefined);

  const lookaheadDb = await build(1_001);
  const lookahead = await runNotificationRetentionCycle({
    db: lookaheadDb, nowMs: NOW_MS, ownerId: 'lookahead-worker', budgets: { orphanPageSize: 250 },
  });
  assert.equal(lookahead.metrics.attemptPagesQueried, 4);
  assert.equal(lookahead.metrics.attemptsDeleted, 1_000);
  assert.equal(lookahead.hasMore, true);
  assert.equal(Object.keys(lookaheadDb.data.notification_delivery_attempts).length, 1);
});

test('engine processes exactly four bounded pages from a 50,000-attempt campaign', async () => {
  const db = await buildScaleDb();
  const result = await runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'scale-worker', budgets: { orphanPageSize: 250 },
  });
  assert.equal(result.mode, 'compactor');
  assert.equal(result.metrics.attemptPagesQueried, 4);
  assert.equal(result.metrics.attemptsScanned, 1_000);
  assert.equal(result.metrics.attemptsDeleted, 1_000);
  assert.equal(result.metrics.retryPointersDeleted, 1_000);
  assert.equal(result.metrics.maxUpdatePaths, 500);
  assert.ok(result.metrics.maxRecordsInMemory <= 251);
  assert.equal(result.hasMore, true);
  assert.equal(Object.keys(db.data.notification_delivery_attempts).length, 49_000);
  assert.equal(Math.ceil(50_000 / 250), 200);
  assert.equal(Math.ceil(50_000 / 1_000), 50);
  assert.equal(Math.ceil(50_000 / 100), 500, 'legacy cleanup requires 500 daily runs');
});

test('100,000 unrelated attempts do not change selected engine pages, budgets or query count', async () => {
  const baselineDb = await buildScaleDb();
  const unrelatedDb = await buildScaleDb({ unrelated: 100_000 });
  const options = { nowMs: NOW_MS, ownerId: 'invariance-worker', budgets: { orphanPageSize: 250 } };
  const baseline = await runNotificationRetentionCycle({ db: baselineDb, ...options });
  const withUnrelated = await runNotificationRetentionCycle({ db: unrelatedDb, ...options });
  for (const metric of [
    'queries', 'attemptPagesQueried', 'attemptsScanned', 'attemptsDeleted',
    'retryPointersDeleted', 'maxUpdatePaths', 'maxRecordsInMemory',
  ]) {
    assert.equal(withUnrelated.metrics[metric], baseline.metrics[metric], metric);
  }
  assert.equal(Object.keys(unrelatedDb.data.notification_delivery_attempts)
    .filter((key) => key.startsWith('zz_unrelated_')).length, 100_000);
});

test('round-robin engine completes a small job, progresses a large job and defers a blocked job', async () => {
  const largeId = 'notif_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const smallId = 'notif_v1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const blockedId = 'notif_v1_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
    notification_requeue_jobs: {
      [blockedId]: { status: 'processing', expiresAtMs: NOW_MS + 60_000 },
    },
  });
  for (const jobId of [largeId, smallId, blockedId]) await seedScheduledJob(db, canonicalJob(jobId));
  for (let index = 0; index < 2_000; index += 1) {
    const attempt = terminalAttempt(largeId, index);
    db.data.notification_delivery_attempts[`large_${attempt.attemptId}`] = { ...attempt, attemptId: `large_${attempt.attemptId}` };
  }
  for (let index = 0; index < 10; index += 1) {
    const attempt = terminalAttempt(smallId, index);
    db.data.notification_delivery_attempts[`small_${attempt.attemptId}`] = { ...attempt, attemptId: `small_${attempt.attemptId}` };
  }
  for (let index = 0; index < 100; index += 1) {
    const attempt = terminalAttempt(blockedId, index);
    db.data.notification_delivery_attempts[`blocked_${attempt.attemptId}`] = { ...attempt, attemptId: `blocked_${attempt.attemptId}` };
  }
  const result = await runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'fairness-worker', budgets: { orphanPageSize: 250 },
  });
  assert.equal(db.getAtPath(`notification_jobs/${smallId}`), undefined, 'small job completes');
  assert.equal(Object.values(db.data.notification_delivery_attempts).filter((attempt) => attempt.jobId === largeId).length, 1_000);
  assert.equal(Object.values(db.data.notification_delivery_attempts).filter((attempt) => attempt.jobId === blockedId).length, 100);
  assert.equal(result.metrics.jobsDeferred, 1);
  assert.equal(result.metrics.jobsCompleted, 1);
  assert.equal(result.metrics.attemptsDeleted, 1_010);
  assert.ok(result.metrics.maxRecordsInMemory <= 251);
  assert.ok(result.metrics.maxUpdatePaths <= 500);
});

test('concurrent engine workers respect one retention lease and never double delete', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  await seedScheduledJob(db, canonicalJob(JOB_ID));
  for (let index = 0; index < 300; index += 1) {
    const attempt = terminalAttempt(JOB_ID, index);
    db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
  }
  const [left, right] = await Promise.all([
    runNotificationRetentionCycle({ db, nowMs: NOW_MS, ownerId: 'worker-left', budgets: { orphanPageSize: 250 } }),
    runNotificationRetentionCycle({ db, nowMs: NOW_MS, ownerId: 'worker-right', budgets: { orphanPageSize: 250 } }),
  ]);
  assert.equal(left.metrics.jobsClaimed + right.metrics.jobsClaimed, 1);
  assert.equal(left.metrics.attemptsDeleted + right.metrics.attemptsDeleted, 300);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}`), undefined);
  assert.equal(Object.keys(db.data.notification_delivery_attempts || {}).length, 0);
});

test('a page commit lease prevents takeover while the bounded destructive unit is live', async () => {
  let releaseFirstUpdate;
  let reportFirstUpdate;
  let firstUpdateBlocked = false;
  const firstUpdateEntered = new Promise((resolve) => { reportFirstUpdate = resolve; });
  const firstUpdateGate = new Promise((resolve) => { releaseFirstUpdate = resolve; });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
  }, {
    beforeUpdate: async ({ patch }) => {
      const deletesAttempts = Object.keys(patch || {})
        .some((entry) => entry.startsWith('notification_delivery_attempts/'));
      if (!deletesAttempts || firstUpdateBlocked) return;
      firstUpdateBlocked = true;
      reportFirstUpdate();
      await firstUpdateGate;
    },
  });
  await seedScheduledJob(db, canonicalJob(JOB_ID));
  for (let index = 0; index < 300; index += 1) {
    const attempt = terminalAttempt(JOB_ID, index);
    db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
  }
  const staleWorker = runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'stale-worker', budgets: { orphanPageSize: 250 },
  });
  await firstUpdateEntered;
  const takeover = await runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS + DEFAULT_RETENTION_BUDGETS.leaseMs + 1,
    ownerId: 'takeover-worker',
    budgets: { orphanPageSize: 250 },
  });
  releaseFirstUpdate();
  const stale = await staleWorker;
  assert.equal(takeover.metrics.jobsCompleted, 0);
  assert.equal(takeover.metrics.attemptsDeleted, 0);
  assert.equal(stale.metrics.jobsCompleted, 1);
  assert.equal(stale.metrics.attemptsDeleted, 300);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}`), undefined);
});

test('legacy and shadow modes perform no compactor deletion', async () => {
  for (const phase of ['legacy', 'shadow']) {
    const db = createNotificationRetentionMemoryDb({
      notification_retention_rollout: { v1: rollout(phase) },
      notification_retention: { v1: { evidence: retentionEvidence() } },
      notification_jobs: {},
      notification_delivery_attempts: {},
    });
    await seedScheduledJob(db, canonicalJob(JOB_ID));
    db.data.notification_delivery_attempts.attempt_1 = terminalAttempt(JOB_ID, 1);
    const result = await runNotificationRetentionCycle({
      db, nowMs: NOW_MS, ownerId: `${phase}-worker`, legacyCleanup: async () => ({ deleted: 0 }),
    });
    assert.equal(result.mode, phase);
    assert.equal(result.metrics.attemptsDeleted, 0);
    assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
    assert.ok(db.getAtPath('notification_delivery_attempts/attempt_1'));
    if (phase === 'shadow') {
      assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/status'), 'passed');
      assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/shadowMismatches'), 0);
    }
  }
});

test('global attempt budget is exact even when the final page is partial', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  await seedScheduledJob(db, canonicalJob(JOB_ID));
  for (let index = 0; index < 300; index += 1) {
    const attempt = terminalAttempt(JOB_ID, index);
    db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
  }
  const result = await runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'partial-budget-worker',
    budgets: {
      maxAttempts: 275,
      maxAttemptPages: 4,
      maxAttemptPagesPerJob: 4,
      orphanPageSize: 1,
      auxiliaryPageSize: 1,
      maxAuxiliaryPages: 1,
    },
  });
  assert.equal(result.metrics.attemptsDeleted, 275);
  assert.equal(result.metrics.attemptPagesQueried, 2);
  assert.equal(Object.keys(db.data.notification_delivery_attempts).length, 25);
  assert.equal(result.hasMore, true);
});

test('durable scheduler rotation reaches a small job beyond the current discovery page', async () => {
  const ids = ['b', 'c', 'd'].map((character) => `notif_v1_${character.repeat(64)}`);
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  for (const id of ids) await seedScheduledJob(db, canonicalJob(id));
  const queue = Object.entries(db.getAtPath('notification_retention/v1/queue'))
    .sort(([left], [right]) => left.localeCompare(right));
  const orderedIds = queue.map(([, entry]) => entry.jobId);
  for (const id of orderedIds.slice(0, 2)) {
    for (let index = 0; index < 3; index += 1) {
      const attempt = terminalAttempt(id, index);
      attempt.attemptId = `${id.slice(-4)}_${index}`;
      db.data.notification_delivery_attempts[attempt.attemptId] = attempt;
    }
  }
  const smallId = orderedIds[2];
  const smallAttempt = terminalAttempt(smallId, 1);
  smallAttempt.attemptId = 'small_attempt';
  db.data.notification_delivery_attempts.small_attempt = smallAttempt;
  const budgets = {
    maxJobs: 2,
    pageSize: 1,
    maxAttempts: 3,
    maxAttemptPages: 3,
    maxAttemptPagesPerJob: 1,
    maxAttemptsPerJob: 1,
    orphanPageSize: 1,
    auxiliaryPageSize: 1,
    maxAuxiliaryPages: 1,
  };
  const first = await runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'rotation-first', budgets,
  });
  assert.equal(first.metrics.attemptsDeleted, 2);
  assert.ok(db.getAtPath(`notification_jobs/${smallId}`));
  const second = await runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'rotation-second', budgets,
  });
  assert.equal(second.metrics.jobsCompleted, 1);
  assert.equal(db.getAtPath(`notification_jobs/${smallId}`), undefined);
});

test('a 500-job due backlog preserves the 25-job discovery and 20-page ceilings', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  for (let index = 0; index < 500; index += 1) {
    const id = `notif_v1_${index.toString(16).padStart(64, '0')}`;
    await seedScheduledJob(db, canonicalJob(id));
  }
  const result = await runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'five-hundred-job-worker',
    budgets: { orphanPageSize: 1, auxiliaryPageSize: 1, maxAuxiliaryPages: 1 },
  });
  assert.equal(result.metrics.jobsDiscovered, 25);
  assert.equal(result.metrics.jobsCompleted, 20);
  assert.equal(result.metrics.attemptPagesQueried, 20);
  assert.equal(Object.keys(db.getAtPath('notification_jobs') || {}).length, 480);
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue') || {}).length, 480);
  assert.ok(result.metrics.maxRecordsInMemory <= 251);
  assert.ok(result.metrics.maxUpdatePaths <= 5);
  assert.equal(result.hasMore, true);
});

test('shadow evidence resumes durably beyond 500 jobs without retaining identity sets', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout('shadow') },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  for (let index = 0; index < 501; index += 1) {
    const id = `notif_v1_${index.toString(16).padStart(64, '0')}`;
    await seedScheduledJob(db, canonicalJob(id));
  }
  let legacyRuns = 0;
  const runShadow = () => runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'shadow-five-hundred-limit',
    modeOverride: 'shadow',
    legacyCleanup: async () => { legacyRuns += 1; return { deleted: 0 }; },
  });
  const result = await runShadow();
  assert.equal(result.hasMore, true);
  assert.equal(result.metrics.shadowMismatches, 0);
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/status'), 'incomplete');
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/hasMore'), true);
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/compactorScanned'), 500);
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/legacyScanned'), 0);
  assert.equal(legacyRuns, 0, 'legacy mutation waits for the complete pre-mutation comparison');
  let resumed = result;
  for (let invocation = 0; invocation < 4 && resumed.hasMore; invocation += 1) {
    resumed = await runShadow();
  }
  assert.equal(resumed.hasMore, false);
  assert.equal(resumed.metrics.shadowEligible, 501);
  assert.equal(resumed.metrics.shadowLegacyEligible, 501);
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/status'), 'passed');
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/compactorScanned'), 501);
  assert.equal(db.getAtPath('notification_retention/v1/evidence/shadow/legacyScanned'), 501);
  assert.equal(legacyRuns, 1);
  assert.ok(resumed.metrics.maxRecordsInMemory <= 26);
});

test('concurrent shadow workers adopt newer durable progress without poisoning evidence', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout('shadow') },
    notification_jobs: {},
    notification_delivery_attempts: {},
  });
  for (let index = 0; index < 20; index += 1) {
    const id = `notif_v1_${index.toString(16).padStart(64, '0')}`;
    await seedScheduledJob(db, canonicalJob(id));
  }
  const runShadow = (ownerId, nowMs) => runNotificationRetentionCycle({
    db, nowMs, ownerId, modeOverride: 'shadow',
    budgets: { maxShadowJobs: 5, maxJobs: 5 },
    legacyCleanup: async () => ({ deleted: 0 }),
  });
  const results = await Promise.all([
    runShadow('concurrent-shadow-a', NOW_MS),
    runShadow('concurrent-shadow-b', NOW_MS + 1),
  ]);
  assert.ok(results.every((result) => result.metrics.shadowMismatches === 0));
  const evidence = db.getAtPath('notification_retention/v1/evidence/shadow');
  assert.notEqual(evidence.status, 'failed');
  assert.ok(evidence.progressRevision >= 1);
  assert.equal(evidence.conflict, undefined);
});

test('the internal deadline covers auxiliary sweeps and leaves later work untouched', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout() },
    notification_retention: { v1: { evidence: retentionEvidence() } },
    notification_jobs: {},
    notification_delivery_attempts: {},
    notification_audience_previews: {
      expired_preview: { expiresAtMs: NOW_MS },
    },
  });
  let wallMs = 0;
  const result = await runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'deadline-worker',
    clock: () => { wallMs += 60; return wallMs; },
    budgets: { internalDeadlineMs: 100 },
  });
  assert.equal(result.budgetExhaustionReason, 'internal_deadline');
  assert.equal(result.metrics.previewsDeleted, 0);
  assert.ok(db.getAtPath('notification_audience_previews/expired_preview'));
});
