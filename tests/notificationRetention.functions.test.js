const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-notification-retention',
  databaseURL: 'https://demo-llt-notification-retention.firebaseio.com',
});

const retention = require('../functions/src/domains/notification-retention/public');
const {
  cleanupOldNotificationDeliveryData,
} = require('../functions/src/domains/notifications/notificationReceipts');
const {
  requeueFailedNotificationJob,
} = require('../functions/src/domains/notifications/notificationAdminFunctions');
const {
  createNotificationRetentionMemoryDb,
  setAtPath,
} = require('./helpers/notificationRetentionMemoryDb');
const { buildRetentionQueueKey } = require('../functions/src/domains/notification-retention/state');
const RETENTION_PROTOCOL = retention.compiledRetentionProtocol();
const protocolRollout = (value) => ({
  ...value,
  ...RETENTION_PROTOCOL,
  expectedEngineProtocolId: RETENTION_PROTOCOL.retentionEngineProtocolId,
});

const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const JOB_ID = 'notif_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const terminalJob = (overrides = {}) => ({
  schemaVersion: 1,
  jobId: JOB_ID,
  status: 'provider_accepted',
  createdAtMs: NOW_MS - (40 * DAY_MS),
  completedAtMs: NOW_MS - RETENTION_MS,
  retentionDueAtMs: NOW_MS,
  updatedAtMs: NOW_MS - DAY_MS,
  queueKind: null,
  queueKey: null,
  queueVersion: 2,
  ...overrides,
});

test('retention public API is production-shaped and exposes no test-only registry', () => {
  const required = [
    'classifyNotificationRetentionEligibility',
    'ensureNotificationRetentionScheduled',
    'isNotificationRetentionFenced',
    'nextNotificationRetentionGeneration',
    'readNotificationRetentionRollout',
    'runNotificationRetentionCycle',
    'runNotificationRetentionPreflight',
    'runNotificationRetentionPreparation',
    'transitionNotificationRetentionRollout',
  ];
  required.forEach((name) => assert.equal(typeof retention[name], 'function', `${name} must be public`));
  assert.deepEqual(Object.keys(retention).filter((name) => /^__|test/iu.test(name)), []);

  const composition = fs.readFileSync(path.resolve(__dirname, '../functions/src/compositionRoot.js'), 'utf8');
  assert.match(composition, /cleanupNotificationDeliveryData:\s*notificationReceipts\.cleanupNotificationDeliveryData/u);
});

test('ordinary eligibility accepts every established terminal status at the immutable due boundary', () => {
  const statuses = [
    'ticket_rejected', 'provider_accepted', 'provider_rejected', 'partial',
    'submission_unknown', 'expired', 'no_recipients',
  ];
  for (const status of statuses) {
    const result = retention.classifyNotificationRetentionEligibility({
      job: terminalJob({ status }),
      nowMs: NOW_MS,
    });
    assert.equal(result.eligible, true, `${status}: ${result.reason}`);
    assert.equal(result.kind, 'ordinary');
    assert.equal(result.retentionDueAtMs, NOW_MS);
    assert.equal(result.dueAtMs, NOW_MS);
  }
});

test('ordinary eligibility fails closed for unsafe completion, status, lease, requeue and hold state', () => {
  const cases = [
    [terminalJob({ completedAtMs: null, retentionDueAtMs: null }), 'missing completion'],
    [terminalJob({ status: 'retrying' }), 'non-terminal status'],
    [terminalJob({ completedAtMs: NOW_MS - RETENTION_MS, retentionDueAtMs: NOW_MS + 1 }), 'not due'],
    [terminalJob({ completedAtMs: NOW_MS - RETENTION_MS, retentionDueAtMs: NOW_MS + DAY_MS }), 'moved due boundary'],
    [terminalJob({ lease: { ownerId: 'live-worker', expiresAtMs: NOW_MS + 1 } }), 'live lease'],
    [terminalJob({ retentionHold: true }), 'retention hold'],
  ];
  for (const [job, label] of cases) {
    assert.equal(retention.classifyNotificationRetentionEligibility({ job, nowMs: NOW_MS }).eligible, false, label);
  }
  assert.equal(retention.classifyNotificationRetentionEligibility({
    job: terminalJob(), nowMs: NOW_MS, activeRequeue: true,
  }).eligible, false, 'active requeue');
});

test('privacy deletion remains fenced until its explicit tombstone expiry', () => {
  const privacy = terminalJob({
    status: 'privacy_deleted',
    completedAtMs: NOW_MS - (365 * DAY_MS),
    retentionDueAtMs: NOW_MS - (335 * DAY_MS),
    expiresAtMs: NOW_MS + 1,
  });
  const before = retention.classifyNotificationRetentionEligibility({ job: privacy, nowMs: NOW_MS });
  assert.equal(before.eligible, false);
  const after = retention.classifyNotificationRetentionEligibility({
    job: { ...privacy, expiresAtMs: NOW_MS }, nowMs: NOW_MS,
  });
  assert.equal(after.eligible, true);
  assert.equal(after.kind, 'privacy_tombstone');
  assert.equal(after.privacyTombstone, true);
  assert.equal(after.retentionDueAtMs, NOW_MS);
});

test('retention generation is monotonic and a canonical fence blocks stale work', () => {
  assert.equal(retention.nextNotificationRetentionGeneration({ retentionGeneration: 7 }), 8);
  assert.equal(retention.nextNotificationRetentionGeneration({}), 1);
  const fenced = terminalJob({
    retentionGeneration: 4,
    retentionFence: {
      fenceId: 'retention_fence_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'active',
      completedAtMs: NOW_MS - RETENTION_MS,
      generation: 4,
      leaseRevision: 2,
    },
  });
  assert.equal(retention.isNotificationRetentionFenced(fenced, {
    nowMs: NOW_MS,
    fenceId: 'retention_fence_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }), true);
  assert.equal(retention.isNotificationRetentionFenced(fenced, {
    nowMs: NOW_MS,
    fenceId: fenced.retentionFence.fenceId,
  }), false);
});

test('malformed shadow and compactor rollout records fail safely to legacy', async () => {
  for (const value of [
    {
      schemaVersion: 1, phase: 'shadow', revision: 1, preparationComplete: false,
      evidenceDigest: null, updatedAtMs: NOW_MS,
    },
    {
      schemaVersion: 1, phase: 'compactor', revision: 2, preparationComplete: true,
      evidenceDigest: 'evidence', updatedAtMs: NOW_MS,
    },
  ]) {
    const db = createNotificationRetentionMemoryDb({ notification_retention_rollout: { v1: value } });
    const rollout = await retention.readNotificationRetentionRollout({ db });
    assert.equal(rollout.phase, 'legacy');
    assert.equal(rollout.valid, false);
  }
});

test('guarded execution rejects a rollout change before any mode can mutate', async () => {
  let legacyCalled = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
  });
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    expectedPhase: 'shadow',
    expectedRevision: 8,
    modeOverride: 'shadow',
    legacyCleanup: async () => { legacyCalled = true; return { deleted: 1 }; },
  });
  assert.equal(result.mode, 'guard_rejected');
  assert.equal(result.hasMore, true);
  assert.equal(result.budgetExhaustionReason, 'rollout_changed');
  assert.equal(legacyCalled, false);
});

test('legacy and shadow ignore the retired compatibility mutation path', async () => {
  const legacyDb = createNotificationRetentionMemoryDb({});
  const legacy = await retention.runNotificationRetentionCycle({
    db: legacyDb,
    nowMs: NOW_MS,
    legacyCleanup: async () => ({ deleted: 0, rolloutChanged: true }),
  });
  assert.equal(legacy.mode, 'legacy');
  assert.equal(legacy.hasMore, false);
  assert.equal(legacy.budgetExhaustionReason, 'legacy_fail_closed');

  const shadowRollout = protocolRollout({
    schemaVersion: 1,
    phase: 'shadow',
    revision: 8,
    preparationComplete: true,
    preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: null,
    shadowEvidenceRevision: null,
    canaryPassed: false,
    canaryEvidenceFingerprint: null,
    canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS,
  });
  const shadowDb = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: shadowRollout },
  });
  const shadow = await retention.runNotificationRetentionCycle({
    db: shadowDb,
    nowMs: NOW_MS,
    modeOverride: 'shadow',
    expectedPhase: 'shadow',
    expectedRevision: 8,
    legacyCleanup: async () => {
      await shadowDb.ref('notification_retention_rollout/v1').set({
        schemaVersion: 1,
        phase: 'legacy',
        revision: 9,
        preparationComplete: false,
        evidenceDigest: null,
        updatedAtMs: NOW_MS + 1,
      });
      return { deleted: 0, rolloutChanged: true };
    },
  });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.hasMore, false);
  assert.equal(shadow.budgetExhaustionReason, null);
  assert.equal((await retention.readNotificationRetentionRollout({ db: shadowDb })).phase, 'shadow');
});

const compactorShadowEvidence = (rolloutRevision = 8) => {
  const evidence = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision,
    status: 'passed',
    shadowEligible: 1,
    shadowLegacyEligible: 1,
    shadowMismatches: 0,
    compactorScanned: 1,
    legacyScanned: 1,
    hasMore: false,
    ...RETENTION_PROTOCOL,
  };
  return { ...evidence, evidenceFingerprint: retention.buildShadowEvidenceFingerprint(evidence) };
};

const compactorCanaryEvidence = (rolloutRevision = 9, shadow = compactorShadowEvidence()) => {
  const evidence = {
    schemaVersion: 1,
    phase: 'canary',
    rolloutRevision,
    status: 'passed',
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    jobsDiscovered: 1,
    jobsClaimed: 1,
    jobsCompleted: 1,
    attemptsDeleted: 1,
    failures: 0,
    fixtureFingerprint: 'a'.repeat(64),
    fixtureCompleted: true,
    ...RETENTION_PROTOCOL,
  };
  return { ...evidence, evidenceFingerprint: retention.buildCanaryEvidenceFingerprint(evidence) };
};

const compactorRollout = () => ({
  schemaVersion: 1,
  phase: 'compactor',
  revision: 10,
  preparationComplete: true,
  preparationRolloutRevision: 7,
  evidenceDigest: 'retention-recovery-evidence',
  shadowEvidenceFingerprint: compactorShadowEvidence().evidenceFingerprint,
  shadowEvidenceRevision: 8,
  canaryPassed: true,
  canaryEvidenceFingerprint: compactorCanaryEvidence().evidenceFingerprint,
  canaryEvidenceRevision: 9,
  updatedAtMs: NOW_MS - 1,
  ...RETENTION_PROTOCOL,
  expectedEngineProtocolId: RETENTION_PROTOCOL.retentionEngineProtocolId,
});

test('paused compactor permits only the explicit bounded canary before activation', async () => {
  const shadow = compactorShadowEvidence();
  const pausedRollout = protocolRollout({
    schemaVersion: 1,
    phase: 'compactor',
    revision: 9,
    preparationComplete: true,
    preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    shadowEvidenceRevision: 8,
    canaryPassed: false,
    canaryEvidenceFingerprint: null,
    canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const job = terminalJob({ retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: pausedRollout },
    notification_retention: { v1: { evidence: { shadow } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: {
      canary_attempt: {
        schemaVersion: 2,
        attemptId: 'canary_attempt',
        jobId: JOB_ID,
        status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });

  const scheduledBeforeCanary = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'scheduled-before-canary',
  });
  assert.equal(scheduledBeforeCanary.mode, 'canary_paused');
  assert.equal(scheduledBeforeCanary.metrics.jobsClaimed, 0);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.ok(db.getAtPath('notification_delivery_attempts/canary_attempt'));
  const fixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...pausedRollout, valid: true }, nowMs: NOW_MS,
  });
  assert.equal(fixture.ready, true);

  const canary = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'explicit-canary',
    modeOverride: 'compactor',
    budgets: {
      maxJobs: 1,
      maxAttemptPagesPerJob: 1,
      maxAttemptPages: 1,
      maxAttempts: 100,
      pageSize: 100,
      orphanPageSize: 1,
      auxiliaryPageSize: 1,
      maxAuxiliaryPages: 1,
    },
    canary: {
      enabled: true,
      expectedPhase: 'compactor',
      expectedRevision: 9,
      evidenceDigest: 'retention-recovery-evidence',
      fixtureFingerprint: fixture.fixtureFingerprint,
      fixtureJobId: fixture.jobId,
    },
  });
  assert.equal(canary.mode, 'canary');
  assert.equal(canary.canaryEvidenceStatus, 'passed');
  assert.equal(canary.metrics.jobsClaimed, 1);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`), 'ambient production work is not canary input');
  assert.ok(db.getAtPath('notification_delivery_attempts/canary_attempt'));

  const replay = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'explicit-canary-replay',
    modeOverride: 'compactor',
    canary: {
      enabled: true,
      expectedPhase: 'compactor',
      expectedRevision: 9,
      evidenceDigest: 'retention-recovery-evidence',
    },
  });
  assert.equal(replay.mode, 'canary_replay');
  assert.equal(replay.metrics.jobsClaimed, 0);

  const scheduledAfterCanary = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'scheduled-after-canary',
  });
  assert.equal(scheduledAfterCanary.mode, 'canary_paused');
  assert.equal(scheduledAfterCanary.metrics.jobsClaimed, 0);

  const activated = await retention.transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'compactor',
    expectedRevision: 9,
    nextPhase: 'compactor',
    actor: 'operations',
    nowMs: NOW_MS + 1,
    evidenceDigest: 'retention-recovery-evidence',
  });
  assert.equal(activated.transitioned, true);
  assert.equal(activated.rollout.phase, 'compactor');
  assert.equal(activated.rollout.revision, 10);
  assert.equal(activated.rollout.canaryPassed, true);

  const normal = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS + 1, ownerId: 'normal-after-canary',
  });
  assert.equal(normal.mode, 'compactor');
});

test('a bounded partial canary fails, retains its cumulative fence and cannot activate', async () => {
  const shadow = compactorShadowEvidence();
  const pausedRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: pausedRollout },
    notification_retention: { v1: { evidence: { shadow } } },
  });
  const fixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...pausedRollout, valid: true }, nowMs: NOW_MS,
  });
  assert.equal(fixture.ready, true);
  for (let index = 0; index < 101; index += 1) {
    await db.ref(`notification_delivery_attempts/extra_canary_${String(index).padStart(3, '0')}`)
      .set({
        schemaVersion: 2,
        attemptId: `extra_canary_${String(index).padStart(3, '0')}`,
        jobId: fixture.jobId,
        status: 'expired',
        retentionDueAtMs: NOW_MS - 1,
      });
  }
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'partial-canary',
    modeOverride: 'compactor',
    budgets: { maxJobs: 1, maxAttempts: 100, maxAttemptsPerJob: 100, pageSize: 100 },
    canary: {
      enabled: true, expectedPhase: 'compactor', expectedRevision: 9,
      evidenceDigest: 'retention-recovery-evidence',
      fixtureFingerprint: fixture.fixtureFingerprint, fixtureJobId: fixture.jobId,
    },
  });
  assert.equal(result.canaryEvidenceStatus, 'failed');
  assert.equal(result.metrics.jobsClaimed, 1);
  assert.equal(result.metrics.jobsCompleted, 0);
  assert.equal(
    db.getAtPath(`notification_jobs/${fixture.jobId}/retentionFence/irreversibleWorkStarted`),
    true,
  );
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${fixture.jobId}/status`), 'queued');
  const activation = await retention.transitionNotificationRetentionRollout({
    db, expectedPhase: 'compactor', expectedRevision: 9, nextPhase: 'compactor',
    actor: 'operations', nowMs: NOW_MS + 1,
    evidenceDigest: 'retention-recovery-evidence',
  });
  assert.equal(activation.transitioned, false);
  assert.equal(activation.reason, 'activation_evidence_required');
});

test('canary fails closed when a non-compactor worker removed its synthetic attempt', async () => {
  const shadow = compactorShadowEvidence();
  const pausedRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: pausedRollout },
    notification_retention: { v1: { evidence: { shadow } } },
  });
  const fixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...pausedRollout, valid: true }, nowMs: NOW_MS,
  });
  await db.ref(`notification_delivery_attempts/${fixture.attemptId}`).remove();
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'canary-missing-attempt', modeOverride: 'compactor',
    budgets: { maxJobs: 1, maxAttempts: 100, maxAttemptsPerJob: 100, pageSize: 100 },
    canary: {
      enabled: true, expectedPhase: 'compactor', expectedRevision: 9,
      evidenceDigest: pausedRollout.evidenceDigest,
      fixtureFingerprint: fixture.fixtureFingerprint, fixtureJobId: fixture.jobId,
    },
  });
  assert.equal(result.canaryEvidenceStatus, 'failed');
  assert.equal(result.metrics.jobsCompleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${fixture.jobId}`));
  assert.equal(db.getAtPath('notification_retention/v1/evidence/canary_fixture/finalizationProof'), undefined);
});

test('canary recovers a crash after final deletion but before completion proof', async () => {
  const shadow = compactorShadowEvidence();
  const pausedRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  let crashAfterStateDelete = false;
  let crashed = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: pausedRollout },
    notification_retention: { v1: { evidence: { shadow } } },
  }, {
    afterTransaction: ({ pathName, next }) => {
      if (crashAfterStateDelete && !crashed
        && pathName.startsWith('notification_retention/v1/jobs/') && next === null) {
        crashed = true;
        throw new Error('crash_after_authoritative_state_delete');
      }
    },
  });
  const fixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...pausedRollout, valid: true }, nowMs: NOW_MS,
  });
  assert.equal(fixture.ready, true);
  crashAfterStateDelete = true;
  await assert.rejects(() => retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'canary-finalization-crash',
    modeOverride: 'compactor',
    budgets: { maxJobs: 1, maxAttempts: 100, maxAttemptsPerJob: 100, pageSize: 100 },
    canary: {
      enabled: true, expectedPhase: 'compactor', expectedRevision: 9,
      evidenceDigest: 'retention-recovery-evidence',
      fixtureFingerprint: fixture.fixtureFingerprint, fixtureJobId: fixture.jobId,
    },
  }), /crash_after_authoritative_state_delete/u);
  assert.equal(crashed, true);
  assert.ok(db.getAtPath('notification_retention/v1/evidence/canary_fixture/finalizationProof'));

  const recovered = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS + 1, ownerId: 'canary-finalization-recovery',
    modeOverride: 'compactor',
    budgets: { maxJobs: 1, maxAttempts: 100, maxAttemptsPerJob: 100, pageSize: 100 },
    canary: {
      enabled: true, expectedPhase: 'compactor', expectedRevision: 9,
      evidenceDigest: 'retention-recovery-evidence',
      fixtureFingerprint: fixture.fixtureFingerprint, fixtureJobId: fixture.jobId,
    },
  });
  assert.equal(recovered.canaryEvidenceStatus, 'passed');
  assert.equal(recovered.metrics.jobsDiscovered, 1);
  assert.equal(recovered.metrics.jobsClaimed, 1);
  assert.equal(recovered.metrics.jobsCompleted, 1);
  const completed = db.getAtPath('notification_retention/v1/evidence/canary_fixture');
  assert.equal(completed.completionProof, 'exact_fixture_paths_absent');
  assert.equal(completed.recoveredAfterFinalization, true);
});

test('a completed canary control is compare-safely replaced by a newer rollout canary', async () => {
  const firstShadow = compactorShadowEvidence();
  const firstRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: firstShadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: firstRollout },
    notification_retention: { v1: { evidence: { shadow: firstShadow } } },
  });
  const firstFixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...firstRollout, valid: true }, nowMs: NOW_MS,
  });
  const runCanary = (rollout, fixture, ownerId, nowMs) => retention.runNotificationRetentionCycle({
    db, nowMs, ownerId, modeOverride: 'compactor',
    budgets: { maxJobs: 1, maxAttempts: 100, maxAttemptsPerJob: 100, pageSize: 100 },
    canary: {
      enabled: true, expectedPhase: 'compactor', expectedRevision: rollout.revision,
      evidenceDigest: rollout.evidenceDigest,
      fixtureFingerprint: fixture.fixtureFingerprint, fixtureJobId: fixture.jobId,
    },
  });
  const firstResult = await runCanary(firstRollout, firstFixture, 'first-canary', NOW_MS);
  assert.equal(firstResult.canaryEvidenceStatus, 'passed', JSON.stringify(firstResult));

  const secondShadow = compactorShadowEvidence(11);
  const secondRollout = protocolRollout({
    ...firstRollout,
    revision: 12,
    evidenceDigest: 'retention-recovery-evidence-next',
    shadowEvidenceFingerprint: secondShadow.evidenceFingerprint,
    shadowEvidenceRevision: 11,
    updatedAtMs: NOW_MS + 1,
  });
  await db.ref('notification_retention/v1/evidence/shadow').set(secondShadow);
  await db.ref('notification_retention_rollout/v1').set(secondRollout);
  const secondFixture = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...secondRollout, valid: true }, nowMs: NOW_MS + 2,
  });
  assert.equal(secondFixture.ready, true);
  assert.notEqual(secondFixture.fixtureFingerprint, firstFixture.fixtureFingerprint);
  const secondResult = await runCanary(
    secondRollout, secondFixture, 'second-canary', NOW_MS + 2,
  );
  assert.equal(secondResult.canaryEvidenceStatus, 'passed');
  assert.equal(secondResult.metrics.jobsCompleted, 1);
  const persistedSecond = db.getAtPath('notification_retention/v1/evidence/canary');
  assert.equal(persistedSecond.rolloutRevision, 12);
  assert.equal(persistedSecond.fixtureFingerprint, secondFixture.fixtureFingerprint);
  const activated = await retention.transitionNotificationRetentionRollout({
    db, expectedPhase: 'compactor', expectedRevision: 12, nextPhase: 'compactor',
    actor: 'operations', nowMs: NOW_MS + 3,
    evidenceDigest: secondRollout.evidenceDigest,
  });
  assert.equal(activated.transitioned, true);
  assert.equal(activated.rollout.canaryPassed, true);
});

test('a newer rollout reconciles an abandoned ready canary fixture', async () => {
  const firstShadow = compactorShadowEvidence();
  const firstRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: firstShadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: firstRollout },
    notification_retention: { v1: { evidence: { shadow: firstShadow } } },
  });
  const abandoned = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...firstRollout, valid: true }, nowMs: NOW_MS,
  });
  const secondShadow = compactorShadowEvidence(11);
  const secondRollout = protocolRollout({
    ...firstRollout, revision: 12, evidenceDigest: 'next-evidence',
    shadowEvidenceFingerprint: secondShadow.evidenceFingerprint,
    shadowEvidenceRevision: 11, updatedAtMs: NOW_MS + 1,
  });
  await db.ref('notification_retention/v1/evidence/shadow').set(secondShadow);
  await db.ref('notification_retention_rollout/v1').set(secondRollout);
  const next = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...secondRollout, valid: true }, nowMs: NOW_MS + 2,
  });
  assert.equal(next.ready, true);
  assert.notEqual(next.fixtureFingerprint, abandoned.fixtureFingerprint);
  assert.equal(db.getAtPath(`notification_jobs/${abandoned.jobId}`), undefined);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${abandoned.jobId}`), undefined);
});

test('a newer rollout reconciles an expired creating canary reservation', async () => {
  const shadow = compactorShadowEvidence();
  const firstRollout = protocolRollout({
    schemaVersion: 1, phase: 'compactor', revision: 9,
    preparationComplete: true, preparationRolloutRevision: 7,
    evidenceDigest: 'retention-recovery-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    shadowEvidenceRevision: 8, canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null,
    updatedAtMs: NOW_MS - 1,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: firstRollout },
    notification_retention: { v1: { evidence: { shadow } } },
  });
  await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...firstRollout, valid: true }, nowMs: NOW_MS,
  });
  const oldControl = db.getAtPath('notification_retention/v1/evidence/canary_fixture');
  await db.ref('notification_retention/v1/evidence/canary_fixture').set({
    ...oldControl, status: 'creating', ownerId: 'crashed-owner', leaseExpiresAtMs: NOW_MS,
  });
  const nextShadow = compactorShadowEvidence(11);
  const nextRollout = protocolRollout({
    ...firstRollout, revision: 12, evidenceDigest: 'next-evidence',
    shadowEvidenceFingerprint: nextShadow.evidenceFingerprint,
    shadowEvidenceRevision: 11, updatedAtMs: NOW_MS + 1,
  });
  await db.ref('notification_retention/v1/evidence/shadow').set(nextShadow);
  await db.ref('notification_retention_rollout/v1').set(nextRollout);
  const next = await retention.ensureNotificationRetentionCanaryFixture({
    db, rollout: { ...nextRollout, valid: true }, nowMs: NOW_MS + 1,
  });
  assert.equal(next.ready, true);
  assert.notEqual(next.fixtureFingerprint, oldControl.fixtureFingerprint);
});

const seedReplayableJob = async (hooks = {}) => {
  const job = terminalJob({
    sourceType: 'tour_announcement',
    tourId: 'test-tour',
    sourceOrderMs: NOW_MS - (40 * DAY_MS),
    navigation: { messageId: 'test-message' },
    retentionGeneration: 0,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: {
      attempt_1: {
        schemaVersion: 2,
        attemptId: 'attempt_1',
        jobId: JOB_ID,
        status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
    notification_job_token_claims: { [JOB_ID]: { token_1: true } },
    notification_job_recipients: { [JOB_ID]: { recipient_1: true } },
    notification_job_audience_claims: { [JOB_ID]: { claim_1: true } },
    notification_delivery_warnings: { [JOB_ID]: { code: 'bounded-test-warning' } },
    broadcasts: {
      'test-tour': {
        'test-message': {
          deliveryJobId: JOB_ID,
          createdAtMs: job.sourceOrderMs,
        },
      },
    },
  }, hooks);
  const scheduled = await retention.ensureNotificationRetentionScheduled({
    db, jobId: JOB_ID, job, nowMs: NOW_MS,
  });
  assert.equal(scheduled.reason, 'scheduled');
  return db;
};

test('retention scheduling is idempotent and creates exactly one durable queue item', async () => {
  const job = terminalJob({ retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({ notification_jobs: { [JOB_ID]: job } });
  const first = await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  const second = await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  assert.equal(first.reason, 'scheduled');
  assert.ok(['scheduled', 'already_scheduled'].includes(second.reason), second.reason);
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue') || {}).length, 1);
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/jobs') || {}).length, 1);
  assert.equal(db.transactionLog.some(({ pathName }) => pathName === 'notification_retention/v1'), false);
  assert.equal(db.transactionLog.some(({ pathName }) => pathName
    === `notification_retention/v1/jobs/${JOB_ID}`), true);
});

test('terminal repair replaces a stale prior generation instead of deferring forever', async () => {
  const job = terminalJob({ status: 'provider_rejected', retentionGeneration: 1 });
  const staleQueueKey = buildRetentionQueueKey(JOB_ID, NOW_MS, 1);
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: {
      v1: {
        evidence: { shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence() },
        jobs: {
          [JOB_ID]: {
            schemaVersion: 1, jobId: JOB_ID, generation: 1, status: 'queued', phase: 'attempts',
            targetStatus: job.status, targetCompletedAtMs: job.completedAtMs,
            retentionDueAtMs: NOW_MS, queueKey: staleQueueKey, queueVersion: 1,
            lease: null, leaseRevision: 0,
          },
        },
        queue: { [staleQueueKey]: { jobId: JOB_ID, generation: 1, dueAtMs: NOW_MS } },
      },
    },
    notification_jobs: { [JOB_ID]: job },
  });
  const first = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'stale-generation-repair',
  });
  assert.equal(first.metrics.jobsDeferred, 1);
  assert.equal(first.metrics.terminalRepairsScheduled, 1);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}/generation`), 2);
  assert.equal(db.getAtPath(`notification_retention/v1/queue/${staleQueueKey}`), undefined);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}/status`), 'queued');
});

test('expired processing requeue state survives cleanup and resumes from its exact cursor', async () => {
  const requeueId = 'requeue_v1_durable';
  const job = terminalJob({
    status: 'retrying', expiresAtMs: NOW_MS + DAY_MS,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: {},
    notification_requeue_jobs: {
      [JOB_ID]: {
        schemaVersion: 1, requeueId, jobId: JOB_ID,
        sourceStatus: 'provider_rejected', sourceCompletedAtMs: job.completedAtMs,
        cursor: 'recipient_cursor', status: 'processing', requeued: 4, skipped: 2,
        lease: { ownerId: 'crashed-requeue', expiresAtMs: NOW_MS - 1 },
        createdAtMs: NOW_MS - (2 * 60 * 60 * 1000),
        updatedAtMs: NOW_MS - (2 * 60 * 60 * 1000), expiresAtMs: NOW_MS - 1,
      },
    },
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  const preserved = db.getAtPath(`notification_requeue_jobs/${JOB_ID}`);
  assert.equal(preserved.requeueId, requeueId);
  assert.equal(preserved.cursor, 'recipient_cursor');
  assert.equal(preserved.requeued, 4);
  assert.equal(preserved.expiresAtMs, NOW_MS - 1);
  assert.equal(preserved.lease.ownerId, 'crashed-requeue');
  const resumed = await requeueFailedNotificationJob({ db, jobId: JOB_ID, nowMs: NOW_MS + 1 });
  assert.equal(resumed.success, true);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.requeueId, requeueId);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/status`), 'retrying');
  assert.equal(db.getAtPath(`notification_requeue_jobs/${JOB_ID}/requeued`), 4);

  const auxiliaryDb = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: {
      v1: { evidence: { shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence() } },
    },
    notification_requeue_jobs: {
      [JOB_ID]: {
        schemaVersion: 1, requeueId, jobId: JOB_ID,
        sourceStatus: 'provider_rejected', sourceCompletedAtMs: job.completedAtMs,
        cursor: 'recipient_cursor', status: 'processing', requeued: 4, skipped: 2,
        lease: { ownerId: 'crashed-requeue', expiresAtMs: NOW_MS - 1 },
        expiresAtMs: NOW_MS - 1,
      },
    },
  });
  await retention.runNotificationRetentionCycle({
    db: auxiliaryDb, nowMs: NOW_MS, ownerId: 'requeue-auxiliary-recovery',
  });
  assert.equal(auxiliaryDb.getAtPath(`notification_requeue_jobs/${JOB_ID}/status`), 'processing');
  assert.equal(auxiliaryDb.getAtPath(`notification_requeue_jobs/${JOB_ID}/cursor`), 'recipient_cursor');
  assert.equal(auxiliaryDb.getAtPath(`notification_requeue_jobs/${JOB_ID}/expiresAtMs`), null);
});

test('scheduled recovery resumes a crashed processing requeue without an operator retry', async () => {
  const job = terminalJob({
    status: 'retrying', retentionGeneration: 1, expiresAtMs: NOW_MS + DAY_MS,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: { [JOB_ID]: {} },
    notification_requeue_jobs: {
      [JOB_ID]: {
        schemaVersion: 1, requeueId: 'requeue_v1_crash_recovery', jobId: JOB_ID,
        sourceStatus: 'provider_rejected', sourceCompletedAtMs: job.completedAtMs,
        cursor: null, status: 'processing', requeued: 0, skipped: 0,
        lease: null, expiresAtMs: null, recoveryDueAtMs: NOW_MS,
        createdAtMs: NOW_MS - 1, updatedAtMs: NOW_MS - 1,
      },
    },
  });
  await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'scheduled-requeue-recovery',
    resumeRequeue: (options) => requeueFailedNotificationJob(options),
  });
  assert.equal(db.getAtPath(`notification_requeue_jobs/${JOB_ID}/status`), 'complete');
  assert.equal(db.getAtPath(`notification_requeue_jobs/${JOB_ID}/recoveryDueAtMs`), null);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/status`), 'provider_rejected');
  assert.ok(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}`));
});

test('manual requeue cannot take over an active compactor page commit', async () => {
  const job = terminalJob({
    status: 'provider_rejected',
    retentionGeneration: 0,
    expiresAtMs: NOW_MS + DAY_MS,
    updatedAtMs: NOW_MS - (40 * DAY_MS),
  });
  let takeover = null;
  let handoffTakeover = null;
  let db;
  db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: {
      commit_attempt: {
        attemptId: 'commit_attempt',
        jobId: JOB_ID,
        status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
  }, {
    beforeUpdate: async ({ pathName, patch }) => {
      if (takeover || pathName
        || !Object.hasOwn(patch || {}, 'notification_delivery_attempts/commit_attempt')) return;
      await db.ref('notification_retention_rollout/v1').set(null);
      takeover = await requeueFailedNotificationJob({
        db,
        jobId: JOB_ID,
        nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 1,
      });
    },
    afterTransaction: async ({ pathName, current, next }) => {
      if (handoffTakeover || pathName !== `notification_jobs/${JOB_ID}`
        || current?.retentionFence?.kind === 'legacy'
        || next?.retentionFence?.kind !== 'legacy') return;
      handoffTakeover = await requeueFailedNotificationJob({
        db,
        jobId: JOB_ID,
        nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 3,
      });
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'compactor-page-commit-owner',
  });
  assert.equal(takeover?.success, false);
  assert.equal(takeover?.reason, 'NOTIFICATION_RETENTION_IN_PROGRESS');
  assert.equal(result.budgetExhaustionReason, 'rollout_changed');
  assert.equal(result.metrics.jobsCompleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.equal(
    db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/commitStatus`),
    'destructive',
  );
  assert.equal(db.getAtPath('notification_delivery_attempts/commit_attempt'), undefined);
  const recovered = await cleanupOldNotificationDeliveryData({
    db,
    nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 2,
  });
  assert.equal(recovered.deleted, 0);
  assert.equal(recovered.failClosed, true);
  assert.equal(handoffTakeover, null);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.equal(
    db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/irreversibleWorkStarted`),
    true,
  );
});

test('compactor requeue recovery cursor advances beyond a hundred unrecoverable records', async () => {
  const requeues = {};
  for (let index = 0; index < 100; index += 1) {
    const jobId = `missing_requeue_${String(index).padStart(3, '0')}`;
    requeues[jobId] = {
      schemaVersion: 1,
      requeueId: `requeue_v1_missing_${index}`,
      jobId,
      status: 'processing',
      recoveryDueAtMs: NOW_MS,
    };
  }
  requeues.zz_recoverable_requeue = {
    schemaVersion: 1,
    requeueId: 'requeue_v1_recoverable',
    jobId: 'zz_recoverable_requeue',
    status: 'processing',
    recoveryDueAtMs: NOW_MS,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_requeue_jobs: requeues,
  });
  const resumed = [];
  const resumeRequeue = async ({ db: targetDb, jobId }) => {
    resumed.push(jobId);
    if (jobId !== 'zz_recoverable_requeue') return { success: false, complete: false };
    await targetDb.ref(`notification_requeue_jobs/${jobId}`).update({
      status: 'complete', recoveryDueAtMs: null, expiresAtMs: NOW_MS + DAY_MS,
    });
    return { success: true, complete: true };
  };
  await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'requeue-recovery-prefix-1',
    budgets: { auxiliaryPageSize: 100 },
    resumeRequeue,
  });
  assert.equal(resumed.includes('zz_recoverable_requeue'), false);
  await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'requeue-recovery-prefix-2',
    budgets: { auxiliaryPageSize: 100 },
    resumeRequeue,
  });
  assert.equal(resumed.includes('zz_recoverable_requeue'), true);
  assert.equal(
    db.getAtPath('notification_requeue_jobs/zz_recoverable_requeue/recoveryDueAtMs'),
    undefined,
  );
});

test('rollback recovers an exact fence left by a hard crash after lease expiry', async () => {
  const job = terminalJob({
    status: 'provider_rejected', retentionGeneration: 0, expiresAtMs: NOW_MS + DAY_MS,
  });
  let crashed = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: {
      v1: { evidence: { shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence() } },
    },
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: {},
  }, {
    afterTransaction: ({ pathName, next }) => {
      if (!crashed && pathName === `notification_jobs/${JOB_ID}`
        && next?.retentionFence?.status === 'active') {
        crashed = true;
        throw new Error('simulated hard crash after canonical fence');
      }
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  await assert.rejects(() => retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'hard-crash-worker',
  }), /simulated hard crash/u);
  await db.ref('notification_retention_rollout/v1').set({
    schemaVersion: 1, phase: 'legacy', revision: 11,
    preparationComplete: false, evidenceDigest: null, updatedAtMs: NOW_MS + 1,
  });
  const resumed = await requeueFailedNotificationJob({
    db,
    jobId: JOB_ID,
    nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.leaseMs + 1,
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.reason, undefined);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence`), null);
});

test('active compactor recovers a stale legacy fence after its exact lease expires', async () => {
  const job = terminalJob({
    status: 'provider_rejected',
    retentionGeneration: 0,
    updatedAtMs: NOW_MS - (40 * DAY_MS),
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  await db.ref(`notification_jobs/${JOB_ID}`).update({
    retentionGeneration: 1,
    retentionFence: {
      fenceId: 'legacy_retention_fence_v2_expired_precommit',
      kind: 'legacy',
      status: 'active',
      completedAtMs: job.completedAtMs,
      generation: 1,
      leaseOwnerId: 'expired-legacy-owner',
      leaseRevision: 1,
      leaseExpiresAtMs: NOW_MS - 1,
      rolloutPhase: 'shadow',
      rolloutRevision: 8,
      commitStatus: null,
    },
  });
  const recovered = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS,
    ownerId: 'legacy-fence-recovered',
  });
  assert.equal(recovered.metrics.jobsCompleted, 1);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}`), undefined);
});

test('legacy fence recovery restores the exact fence when malformed rollout raw state changes', async () => {
  const fence = {
    fenceId: `legacy_retention_fence_v2_${'a'.repeat(32)}`,
    kind: 'legacy',
    status: 'active',
    completedAtMs: NOW_MS - RETENTION_MS,
    generation: 1,
    leaseOwnerId: 'expired-legacy-owner',
    leaseRevision: 3,
    leaseExpiresAtMs: NOW_MS - 1,
    rolloutPhase: 'legacy',
    rolloutRevision: 0,
  };
  let swapped = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: { malformed: 'before' } },
    notification_jobs: {
      [JOB_ID]: terminalJob({
        retentionGeneration: 1,
        retentionFence: fence,
        updatedAtMs: NOW_MS - (40 * DAY_MS),
      }),
    },
  }, {
    afterTransaction: ({ data, pathName, next }) => {
      if (swapped || pathName !== `notification_jobs/${JOB_ID}`
        || next?.retentionFence !== null) return;
      swapped = true;
      setAtPath(data, 'notification_retention_rollout/v1', { malformed: 'after' });
    },
  });
  const recovered = await retention.recoverInactiveCompactorFence({
    db, jobId: JOB_ID, nowMs: NOW_MS,
  });
  assert.equal(recovered, null);
  assert.equal(swapped, true);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/fenceId`), fence.fenceId);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/retentionGeneration`), 1);
});

test('the bounded terminal repair sweep recovers a crash before retention scheduling', async () => {
  const job = terminalJob({ retentionGeneration: 0, retentionDueAtMs: undefined });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: {},
  });
  const repaired = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'terminal-repair-worker',
    budgets: { auxiliaryPageSize: 10, maxAuxiliaryPages: 1, orphanPageSize: 1 },
  });
  assert.equal(repaired.metrics.terminalRepairsScheduled, 1);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/retentionDueAtMs`), NOW_MS);
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue') || {}).length, 1);
  const completed = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'terminal-repair-completion', budgets: { orphanPageSize: 1 },
  });
  assert.equal(completed.metrics.jobsCompleted, 1);
});

test('compactor authorization fails closed when bound shadow evidence changes', async () => {
  const db = await seedReplayableJob();
  const failed = {
    ...compactorShadowEvidence(),
    status: 'failed',
    shadowMismatches: 1,
  };
  failed.evidenceFingerprint = retention.buildShadowEvidenceFingerprint(failed);
  await db.ref('notification_retention/v1/evidence/shadow').set(failed);
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'stale-evidence-worker', budgets: { orphanPageSize: 1 },
  });
  assert.equal(result.budgetExhaustionReason, 'rollout_changed');
  assert.equal(result.metrics.jobsClaimed, 0);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.ok(db.getAtPath('notification_delivery_attempts/attempt_1'));
});

test('canary requires the exact rollout evidence digest before any mutation', async () => {
  const db = await seedReplayableJob();
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'digest-mismatch-canary',
    modeOverride: 'compactor',
    canary: {
      enabled: true,
      expectedPhase: 'compactor',
      expectedRevision: compactorRollout().revision,
      evidenceDigest: 'wrong-evidence',
    },
  });
  assert.equal(result.mode, 'canary_rejected');
  assert.equal(result.budgetExhaustionReason, 'canary_rollout_mismatch');
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.ok(db.getAtPath('notification_delivery_attempts/attempt_1'));
});

test('evidence revocation preserves an in-flight commit fence and retention resumes safely', async () => {
  const attempts = {};
  for (let index = 0; index < 400; index += 1) {
    const attemptId = `evidence_attempt_${String(index).padStart(4, '0')}`;
    attempts[attemptId] = {
      attemptId, jobId: JOB_ID, status: 'provider_accepted', retentionDueAtMs: NOW_MS,
    };
  }
  const passing = compactorShadowEvidence();
  const failed = { ...passing, status: 'failed', shadowMismatches: 1 };
  failed.evidenceFingerprint = retention.buildShadowEvidenceFingerprint(failed);
  let revoked = false;
  const job = terminalJob({ retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: passing, canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: attempts,
  }, {
    beforeUpdate: async ({ data, pathName, patch }) => {
      if (revoked || pathName
        || !Object.keys(patch || {}).some((key) => key.startsWith('notification_delivery_attempts/'))) return;
      revoked = true;
      setAtPath(data, 'notification_retention/v1/evidence/shadow', failed);
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  const stopped = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'evidence-revoked-worker', budgets: { orphanPageSize: 1 },
  });
  assert.equal(stopped.budgetExhaustionReason, 'rollout_changed');
  assert.equal(
    db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/commitStatus`),
    'destructive',
  );
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/retentionGeneration`), 1);
  await db.ref('notification_retention/v1/evidence/shadow').set(passing);
  const resumed = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS + 1, ownerId: 'evidence-restored-worker', budgets: { orphanPageSize: 1 },
  });
  assert.equal(resumed.metrics.jobsCompleted, 1);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}`), undefined);
  assert.equal(Object.keys(db.getAtPath('notification_delivery_attempts') || {}).length, 0);
});

for (const crashPoint of ['attempt_page', 'job_children', 'source_record', 'canonical_parent']) {
  test(`a restart resumes safely after a crash following ${crashPoint} deletion`, async () => {
    let crashed = false;
    let recoveryPromotedCumulativeBoundary = false;
    const crashOnce = () => {
      if (crashed) return;
      crashed = true;
      throw new Error(`simulated crash after ${crashPoint}`);
    };
    const db = await seedReplayableJob({
      afterUpdate: async ({ pathName, patch }) => {
        if (pathName) return;
        const paths = Object.keys(patch || {});
        if (crashPoint === 'attempt_page'
          && paths.some((entry) => entry.startsWith('notification_delivery_attempts/'))) crashOnce();
        if (crashPoint === 'job_children'
          && paths.some((entry) => entry.startsWith(`notification_job_recipients/${JOB_ID}`))) crashOnce();
      },
      afterTransaction: async ({ pathName, committed, current, next }) => {
        if (pathName === `notification_retention/v1/jobs/${JOB_ID}`
          && current?.destructiveCommit
          && current?.irreversibleWorkStarted !== true
          && next?.lease?.ownerId === 'restart-worker'
          && next?.irreversibleWorkStarted === true) {
          recoveryPromotedCumulativeBoundary = true;
        }
        if (!committed || next !== null) return;
        if (crashPoint === 'source_record' && pathName === 'broadcasts/test-tour/test-message') crashOnce();
        if (crashPoint === 'canonical_parent' && pathName === `notification_jobs/${JOB_ID}`) crashOnce();
      },
    });
    await assert.rejects(
      retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS, ownerId: 'crashing-worker' }),
      new RegExp(`simulated crash after ${crashPoint}`, 'u'),
    );
    assert.equal(crashed, true);
    const cumulativeBoundaryAlreadyDurable = db.getAtPath(
      `notification_retention/v1/jobs/${JOB_ID}/irreversibleWorkStarted`,
    ) === true;
    const restarted = await retention.runNotificationRetentionCycle({
      db,
      nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 1,
      ownerId: 'restart-worker',
      budgets: { orphanPageSize: 250 },
    });
    assert.equal(restarted.metrics.jobsCompleted, 1, JSON.stringify({
      restarted,
      job: db.getAtPath(`notification_jobs/${JOB_ID}`),
      state: db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}`),
      queue: db.getAtPath('notification_retention/v1/queue'),
    }));
    assert.equal(cumulativeBoundaryAlreadyDurable || recoveryPromotedCumulativeBoundary, true);
    assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}`), undefined);
    assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}`), undefined);
    assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue') || {}).length, 0);
    assert.equal(db.getAtPath('broadcasts/test-tour/test-message'), undefined);
  });
}

test('an old finalizer preserves a privacy tombstone and its newer retention generation', async () => {
  let injected = false;
  let db;
  db = await seedReplayableJob({
    afterTransaction: async ({ data, pathName, committed, next }) => {
      if (injected || pathName !== `notification_jobs/${JOB_ID}` || !committed || next !== null) return;
      injected = true;
      const privacy = terminalJob({
        status: 'privacy_deleted',
        completedAtMs: NOW_MS,
        updatedAtMs: NOW_MS,
        expiresAtMs: NOW_MS + RETENTION_MS,
        retentionDueAtMs: NOW_MS + RETENTION_MS,
        retentionGeneration: 1,
        presentation: undefined,
        navigation: undefined,
      });
      setAtPath(data, `notification_jobs/${JOB_ID}`, privacy);
      const scheduled = await retention.ensureNotificationRetentionScheduled({
        db, jobId: JOB_ID, job: privacy, nowMs: NOW_MS,
      });
      assert.equal(scheduled.reason, 'scheduled');
    },
  });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'privacy-finalize-race', budgets: { orphanPageSize: 1 },
  });
  assert.equal(result.metrics.jobsCompleted, 1);
  assert.equal(injected, true);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/status`), 'privacy_deleted');
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}/generation`), 2);
  const queued = Object.values(db.getAtPath('notification_retention/v1/queue') || {});
  assert.equal(queued.length, 1);
  assert.equal(queued[0].generation, 2);
});

test('orphan repair preserves an attempt when its canonical parent is created during compare-delete', async () => {
  const parent = terminalJob({ completedAtMs: NOW_MS, retentionDueAtMs: NOW_MS + RETENTION_MS });
  let parentCreated = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_delivery_attempts: {
      orphan_attempt: {
        schemaVersion: 2,
        attemptId: 'orphan_attempt',
        jobId: JOB_ID,
        status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
  }, {
    beforeTransaction: async ({ data, pathName }) => {
      if (parentCreated || pathName !== 'notification_delivery_attempts/orphan_attempt') return;
      parentCreated = true;
      setAtPath(data, `notification_jobs/${JOB_ID}`, parent);
    },
  });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'orphan-race-worker', budgets: { orphanPageSize: 250 },
  });
  assert.equal(parentCreated, true);
  assert.equal(result.metrics.orphanAttemptsDeleted, 0);
  assert.ok(db.getAtPath('notification_delivery_attempts/orphan_attempt'));
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
});

test('attempt cleanup removes only an exact queue version and fail-closes on nonterminal work', async () => {
  const exactJobId = `notif_v1_${'b'.repeat(64)}`;
  const blockedJobId = `notif_v1_${'c'.repeat(64)}`;
  const exactJob = terminalJob({ jobId: exactJobId, retentionGeneration: 0 });
  const blockedJob = terminalJob({ jobId: blockedJobId, retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [exactJobId]: exactJob, [blockedJobId]: blockedJob },
    notification_delivery_attempts: {
      exact_attempt: {
        attemptId: 'exact_attempt', jobId: exactJobId, status: 'provider_accepted',
        retentionDueAtMs: NOW_MS, queueKind: 'retry', queueKey: 'retry_exact', queueVersion: 1,
      },
      blocked_attempt: {
        attemptId: 'blocked_attempt', jobId: blockedJobId, status: 'retrying',
        retentionDueAtMs: NOW_MS,
      },
    },
    notification_attempt_retry_queue: {
      retry_exact: { targetId: 'exact_attempt', version: 2, dueAtMs: NOW_MS },
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: exactJobId, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: blockedJobId, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'exact-pointer-worker', budgets: { orphanPageSize: 1 },
  });
  assert.equal(db.getAtPath(`notification_jobs/${exactJobId}`), undefined);
  assert.equal(db.getAtPath('notification_attempt_retry_queue/retry_exact/version'), 2);
  assert.equal(result.metrics.retryPointersDeleted, 0);
  assert.equal(db.getAtPath(`notification_jobs/${blockedJobId}`).status, 'provider_accepted');
  assert.equal(db.getAtPath('notification_delivery_attempts/blocked_attempt').status, 'retrying');
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${blockedJobId}/status`), 'requires_attention');
  assert.equal(Object.keys(db.getAtPath('operations_terminal_warnings/v1') || {}).length, 1);
});

test('a later nonterminal page retains cumulative fencing and resumes only through exact attention retry', async () => {
  const jobId = `notif_v1_${'d'.repeat(64)}`;
  const job = terminalJob({
    jobId, status: 'provider_rejected', retentionGeneration: 0,
    expiresAtMs: NOW_MS + DAY_MS,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [jobId]: job },
    notification_delivery_attempts: {
      a_terminal: {
        attemptId: 'a_terminal', jobId, status: 'provider_rejected', retentionDueAtMs: NOW_MS,
      },
      b_nonterminal: {
        attemptId: 'b_nonterminal', jobId, status: 'retrying', retentionDueAtMs: NOW_MS,
      },
    },
  });
  await retention.writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({ db, jobId, job, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'cumulative-attention-worker',
    budgets: { pageSize: 1, maxAttemptsPerJob: 10, maxAttemptsPerJobPerCycle: 10 },
  });

  assert.equal(result.metrics.attemptsDeleted, 1);
  assert.equal(db.getAtPath('notification_delivery_attempts/a_terminal'), undefined);
  assert.equal(db.getAtPath('notification_delivery_attempts/b_nonterminal/status'), 'retrying');
  const state = db.getAtPath(`notification_retention/v1/jobs/${jobId}`);
  assert.equal(state.status, 'requires_attention');
  assert.equal(state.irreversibleWorkStarted, true);
  assert.equal(state.committedDeletionCount, 1);
  assert.equal(state.firstDestructiveCommitAtMs, NOW_MS);
  assert.equal(state.destructiveCommit, null);
  assert.equal(state.retentionDueAtMs, NOW_MS);
  const fence = db.getAtPath(`notification_jobs/${jobId}/retentionFence`);
  assert.equal(fence.irreversibleWorkStarted, true);
  assert.equal(fence.firstDestructiveCommitAtMs, NOW_MS);
  assert.equal(fence.irreversibleGeneration, state.generation);
  assert.equal(fence.commitStatus, 'destructive');
  const attention = db.getAtPath(`notification_retention/v1/attention/${jobId}`);
  assert.match(attention.attentionFingerprint, /^attention_v1_[a-f0-9]{32}$/u);
  assert.equal(db.getAtPath(`notification_retention/v1/queue/${state.queueKey}`), undefined);
  assert.equal(state.attention.attentionFingerprint, attention.attentionFingerprint);
  assert.equal(attention.irreversibleWorkStarted, true);
  assert.equal(attention.committedDeletionCount, 1);

  const manual = await requeueFailedNotificationJob({ db, jobId, nowMs: NOW_MS + 1 });
  assert.equal(manual.success, false);
  assert.equal(manual.reason, 'NOTIFICATION_RETENTION_IN_PROGRESS');
  await db.ref(`notification_jobs/${jobId}`).update({
    retentionFence: null,
    retentionGeneration: Math.max(0, state.generation - 1),
  });
  const stateGuarded = await requeueFailedNotificationJob({ db, jobId, nowMs: NOW_MS + 1 });
  assert.equal(stateGuarded.success, false);
  assert.equal(stateGuarded.reason, 'NOTIFICATION_RETENTION_IN_PROGRESS');

  await db.ref('notification_delivery_attempts/b_nonterminal').update({
    status: 'provider_rejected',
  });
  const retried = await retention.retryNotificationRetentionAttention({
    db,
    jobId,
    expected: {
      generation: attention.generation,
      attentionFingerprint: attention.attentionFingerprint,
    },
    nowMs: NOW_MS + 2,
  });
  assert.equal(retried.retried, true);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${jobId}/status`), 'queued');
  assert.equal(db.getAtPath(`notification_retention/v1/attention/${jobId}`), undefined);
  const completed = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS + 2,
    ownerId: 'cumulative-attention-resume',
    budgets: { pageSize: 1, maxAttemptsPerJob: 10, maxAttemptsPerJobPerCycle: 10 },
  });
  assert.equal(completed.metrics.jobsCompleted, 1, JSON.stringify({
    completed,
    state: db.getAtPath(`notification_retention/v1/jobs/${jobId}`),
    job: db.getAtPath(`notification_jobs/${jobId}`),
  }));
  assert.equal(db.getAtPath(`notification_jobs/${jobId}`), undefined);
});

test('warning persistence is the commit boundary before attention can release ownership', async () => {
  const jobId = `notif_v1_${'e'.repeat(64)}`;
  const job = terminalJob({ jobId, retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [jobId]: job },
    notification_delivery_attempts: {
      blocked_attempt: {
        attemptId: 'blocked_attempt', jobId, status: 'retrying', retentionDueAtMs: NOW_MS,
      },
    },
  }, {
    beforeTransaction: ({ pathName }) => {
      if (pathName.startsWith('operations_terminal_warnings/v1/')) {
        throw new Error('warning_store_unavailable');
      }
    },
  });
  await retention.writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({ db, jobId, job, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'warning-first-attention-worker',
  });
  const state = db.getAtPath(`notification_retention/v1/jobs/${jobId}`);
  assert.equal(result.metrics.jobsRequiresAttention, 1);
  assert.equal(state.status, 'queued');
  assert.equal(state.retentionDueAtMs, NOW_MS);
  assert.ok(db.getAtPath(`notification_jobs/${jobId}/retentionFence`));
  assert.ok(db.getAtPath(`notification_retention/v1/queue/${state.queueKey}`));
  assert.equal(db.getAtPath(`notification_retention/v1/attention/${jobId}`), undefined);
});

test('a crash before attention projection leaves authoritative state non-claimable and repairable', async () => {
  const jobId = `notif_v1_${'6'.repeat(64)}`;
  const job = terminalJob({ jobId, retentionGeneration: 0 });
  let projectionCrashed = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [jobId]: job },
    notification_delivery_attempts: {
      blocked_attempt: {
        attemptId: 'blocked_attempt', jobId, status: 'retrying', retentionDueAtMs: NOW_MS,
      },
    },
  }, {
    beforeTransaction: ({ pathName }) => {
      if (!projectionCrashed
        && pathName === `notification_retention/v1/attention/${jobId}`) {
        projectionCrashed = true;
        throw new Error('attention_projection_crash');
      }
    },
  });
  await retention.writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({ db, jobId, job, nowMs: NOW_MS });

  await assert.rejects(
    retention.runNotificationRetentionCycle({
      db, nowMs: NOW_MS, ownerId: 'attention-crash-worker',
    }),
    /attention_projection_crash/u,
  );
  const stateAfterCrash = db.getAtPath(`notification_retention/v1/jobs/${jobId}`);
  assert.equal(stateAfterCrash.status, 'requires_attention');
  assert.equal(stateAfterCrash.lease, null);
  assert.match(stateAfterCrash.attention.attentionFingerprint, /^attention_v1_[a-f0-9]{32}$/u);
  assert.equal(db.getAtPath(`notification_retention/v1/attention/${jobId}`), undefined);
  assert.ok(db.getAtPath(`notification_retention/v1/queue/${stateAfterCrash.queueKey}`));

  const repairCycle = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS + 1, ownerId: 'attention-repair-worker',
  });
  assert.equal(repairCycle.metrics.attemptsDeleted, 0);
  assert.equal(db.getAtPath('notification_delivery_attempts/blocked_attempt/status'), 'retrying');
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${jobId}/status`), 'requires_attention');
  const projected = db.getAtPath(`notification_retention/v1/attention/${jobId}`);
  assert.equal(projected.attentionFingerprint, stateAfterCrash.attention.attentionFingerprint);
  assert.equal(db.getAtPath(`notification_retention/v1/queue/${stateAfterCrash.queueKey}`), undefined);

  await db.ref('notification_delivery_attempts/blocked_attempt').update({
    status: 'provider_rejected',
  });
  const retried = await retention.retryNotificationRetentionAttention({
    db,
    jobId,
    expected: {
      generation: stateAfterCrash.generation,
      attentionFingerprint: stateAfterCrash.attention.attentionFingerprint,
    },
    nowMs: NOW_MS + 2,
  });
  assert.equal(retried.retried, true);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${jobId}/status`), 'queued');
});

test('completed child deletion followed by invalid source metadata remains fenced and repairable', async () => {
  const jobId = `notif_v1_${'9'.repeat(64)}`;
  const job = terminalJob({
    jobId,
    retentionGeneration: 0,
    sourceType: 'future_tour_category_broadcast',
    categoryKey: 'safe_category',
    navigation: { broadcastId: 'safe_broadcast' },
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [jobId]: job },
    notification_job_recipients: { [jobId]: { bounded_recipient: { status: 'skipped' } } },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId, job, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'child-then-invalid-source',
  });
  assert.equal(result.metrics.jobsCompleted, 0);
  assert.equal(db.getAtPath(`notification_job_recipients/${jobId}`), undefined);
  const state = db.getAtPath(`notification_retention/v1/jobs/${jobId}`);
  assert.equal(state.phase, 'source_records');
  assert.equal(state.status, 'requires_attention');
  assert.equal(state.irreversibleWorkStarted, true);
  assert.ok(state.committedDeletionCount >= 4);
  assert.equal(db.getAtPath(`notification_jobs/${jobId}/retentionFence/irreversibleWorkStarted`), true);
  assert.equal(db.getAtPath(`notification_retention/v1/queue/${state.queueKey}`), undefined);
  const attention = db.getAtPath(`notification_retention/v1/attention/${jobId}`);
  assert.ok(attention);
  assert.equal(state.attention.attentionFingerprint, attention.attentionFingerprint);
});

test('rollout revocation after a completed page preserves the cumulative fence', async () => {
  const jobId = `notif_v1_${'1'.repeat(64)}`;
  const job = terminalJob({
    jobId, status: 'provider_rejected', retentionGeneration: 0,
    expiresAtMs: NOW_MS + DAY_MS,
  });
  let revokedAfterTransition = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [jobId]: job },
    notification_delivery_attempts: {
      a_first: {
        attemptId: 'a_first', jobId, status: 'provider_rejected', retentionDueAtMs: NOW_MS,
      },
      b_second: {
        attemptId: 'b_second', jobId, status: 'provider_rejected', retentionDueAtMs: NOW_MS,
      },
    },
  }, {
    afterTransaction: ({ data, pathName, next }) => {
      if (revokedAfterTransition
        || pathName !== `notification_retention/v1/jobs/${jobId}`
        || next?.attemptPagesProcessed !== 1
        || next?.destructiveCommit !== null) return;
      revokedAfterTransition = true;
      setAtPath(data, 'notification_retention_rollout/v1', {
        schemaVersion: 1,
        phase: 'legacy',
        revision: compactorRollout().revision + 1,
        preparationComplete: false,
        updatedAtMs: NOW_MS + 1,
      });
    },
  });
  await retention.writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({ db, jobId, job, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'post-page-rollout-revocation',
    budgets: { pageSize: 1, maxAttemptsPerJob: 10, maxAttemptsPerJobPerCycle: 10 },
  });

  assert.equal(revokedAfterTransition, true);
  assert.equal(result.budgetExhaustionReason, 'rollout_changed');
  assert.equal(result.metrics.attemptsDeleted, 1);
  assert.equal(db.getAtPath('notification_delivery_attempts/a_first'), undefined);
  assert.ok(db.getAtPath('notification_delivery_attempts/b_second'));
  const state = db.getAtPath(`notification_retention/v1/jobs/${jobId}`);
  assert.equal(state.status, 'queued');
  assert.equal(state.irreversibleWorkStarted, true);
  assert.equal(state.committedDeletionCount, 1);
  assert.equal(state.destructiveCommit, null);
  const fence = db.getAtPath(`notification_jobs/${jobId}/retentionFence`);
  assert.equal(fence.irreversibleWorkStarted, true);
  assert.equal(fence.commitStatus, 'destructive');
  assert.ok(db.getAtPath(`notification_retention/v1/queue/${state.queueKey}`));
  const manual = await requeueFailedNotificationJob({ db, jobId, nowMs: NOW_MS + 2 });
  assert.equal(manual.success, false);
  assert.equal(manual.reason, 'NOTIFICATION_RETENTION_IN_PROGRESS');
});

test('zero-work attention requires an exact fingerprint to retry or abandon', async () => {
  const retryJobId = `notif_v1_${'f'.repeat(64)}`;
  const abandonJobId = `notif_v1_${'0'.repeat(64)}`;
  const retryJob = terminalJob({ jobId: retryJobId, retentionGeneration: 0 });
  const abandonJob = terminalJob({ jobId: abandonJobId, retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [retryJobId]: retryJob, [abandonJobId]: abandonJob },
    notification_delivery_attempts: {
      retry_blocked: {
        attemptId: 'retry_blocked', jobId: retryJobId, status: 'retrying', retentionDueAtMs: NOW_MS,
      },
      abandon_blocked: {
        attemptId: 'abandon_blocked', jobId: abandonJobId, status: 'retrying', retentionDueAtMs: NOW_MS,
      },
    },
  });
  await retention.writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  await retention.ensureNotificationRetentionScheduled({
    db, jobId: retryJobId, job: retryJob, nowMs: NOW_MS,
  });
  await retention.ensureNotificationRetentionScheduled({
    db, jobId: abandonJobId, job: abandonJob, nowMs: NOW_MS,
  });
  await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'zero-work-attention-worker',
  });

  const retryAttention = db.getAtPath(`notification_retention/v1/attention/${retryJobId}`);
  const staleRetry = await retention.retryNotificationRetentionAttention({
    db,
    jobId: retryJobId,
    expected: { generation: retryAttention.generation, attentionFingerprint: 'attention_v1_bad' },
    nowMs: NOW_MS + 1,
  });
  assert.equal(staleRetry.reason, 'attention_changed');
  const retried = await retention.retryNotificationRetentionAttention({
    db,
    jobId: retryJobId,
    expected: {
      generation: retryAttention.generation,
      attentionFingerprint: retryAttention.attentionFingerprint,
    },
    nowMs: NOW_MS + 1,
  });
  assert.equal(retried.retried, true);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${retryJobId}/status`), 'queued');
  assert.ok(db.getAtPath(`notification_retention/v1/queue/${retryAttention.queueKey}`));

  const abandonAttention = db.getAtPath(`notification_retention/v1/attention/${abandonJobId}`);
  const abandoned = await retention.abandonNotificationRetentionAttention({
    db,
    jobId: abandonJobId,
    expected: {
      generation: abandonAttention.generation,
      attentionFingerprint: abandonAttention.attentionFingerprint,
    },
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${abandonJobId}`), undefined);
  assert.equal(db.getAtPath(`notification_retention/v1/attention/${abandonJobId}`), undefined);
});

test('zero-result requeue recovery does not mutate canonical state before its warning is durable', async () => {
  const jobId = `notif_v1_${'2'.repeat(64)}`;
  const job = terminalJob({
    jobId,
    status: 'retrying',
    retentionGeneration: 1,
    expiresAtMs: NOW_MS + DAY_MS,
  });
  const requeueState = {
    schemaVersion: 1,
    requeueId: 'requeue_v1_warning_first',
    jobId,
    sourceStatus: 'provider_rejected',
    sourceCompletedAtMs: job.completedAtMs,
    status: 'complete',
    requeued: 0,
    skipped: 1,
    expiresAtMs: NOW_MS + DAY_MS,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [jobId]: job },
    notification_requeue_jobs: { [jobId]: requeueState },
  }, {
    beforeTransaction: ({ pathName }) => {
      if (pathName.startsWith('operations_terminal_warnings/v1/')) {
        throw new Error('warning_store_unavailable');
      }
    },
  });
  const recovered = await retention.recoverZeroResultRequeue({
    db, jobId, state: requeueState, nowMs: NOW_MS,
  });
  assert.equal(recovered.status, 'retrying');
  assert.equal(db.getAtPath(`notification_jobs/${jobId}/status`), 'retrying');
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${jobId}`), undefined);
});

test('legacy cleanup preserves held-parent attempts and marketing details', async () => {
  const held = terminalJob({
    retentionHold: true,
    updatedAtMs: NOW_MS - (40 * DAY_MS),
  });
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: held },
    notification_delivery_attempts: {
      held_attempt: {
        attemptId: 'held_attempt', jobId: JOB_ID, status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
    marketing_notification_details: {
      held_detail: { deliveryJobId: JOB_ID, retentionDueAtMs: NOW_MS, updatedAtMs: NOW_MS },
    },
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.ok(db.getAtPath('notification_delivery_attempts/held_attempt'));
  assert.ok(db.getAtPath('marketing_notification_details/held_detail'));
});

test('missing rollout is a fail-closed non-destructive compatibility default', async () => {
  const job = terminalJob({ updatedAtMs: NOW_MS - (40 * DAY_MS) });
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: {},
  });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'missing-rollout-legacy',
    legacyCleanup: (options) => cleanupOldNotificationDeliveryData(options),
  });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.metrics.legacyDeletionPaths, 0);
  assert.equal(result.budgetExhaustionReason, 'legacy_fail_closed');
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
});

test('legacy cleanup preserves every parent regardless of prefix size', async () => {
  const jobs = {};
  for (let index = 0; index < 100; index += 1) {
    const jobId = `blocked_${String(index).padStart(3, '0')}`;
    jobs[jobId] = {
      jobId, status: 'processing', updatedAtMs: NOW_MS - (50 * DAY_MS),
    };
  }
  const eligibleId = `terminal_${'f'.repeat(32)}`;
  jobs[eligibleId] = {
    ...terminalJob({ jobId: eligibleId }),
    updatedAtMs: NOW_MS - (40 * DAY_MS),
  };
  const db = createNotificationRetentionMemoryDb({ notification_jobs: jobs });
  const first = await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(first.deleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${eligibleId}`));
  const second = await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(second.deleted, 0);
  assert.equal(second.failClosed, true);
  assert.ok(db.getAtPath(`notification_jobs/${eligibleId}`));
});

test('legacy cleanup preserves parentless attempts as well as parent-owned attempts', async () => {
  const attempts = {};
  for (let index = 0; index < 100; index += 1) {
    const attemptId = `retained_attempt_${String(index).padStart(3, '0')}`;
    attempts[attemptId] = {
      attemptId,
      jobId: JOB_ID,
      status: 'provider_accepted',
      retentionDueAtMs: NOW_MS,
    };
  }
  attempts.zz_orphan_attempt = {
    attemptId: 'zz_orphan_attempt',
    jobId: 'missing_terminal_parent',
    status: 'provider_accepted',
    retentionDueAtMs: NOW_MS,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [JOB_ID]: terminalJob({
        retentionHold: true,
        updatedAtMs: NOW_MS - (40 * DAY_MS),
      }),
    },
    notification_delivery_attempts: attempts,
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath('notification_delivery_attempts/zz_orphan_attempt'));
  assert.ok(db.getAtPath('notification_delivery_attempts/retained_attempt_000'));
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath('notification_delivery_attempts/zz_orphan_attempt'));
  assert.ok(db.getAtPath('notification_delivery_attempts/retained_attempt_099'));
});

test('legacy cleanup preserves parentless and parent-owned marketing details', async () => {
  const details = {};
  for (let index = 0; index < 100; index += 1) {
    const detailId = `retained_detail_${String(index).padStart(3, '0')}`;
    details[detailId] = {
      deliveryJobId: JOB_ID,
      retentionDueAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    };
  }
  details.zz_orphan_detail = {
    deliveryJobId: 'missing_terminal_parent',
    retentionDueAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [JOB_ID]: terminalJob({
        retentionHold: true,
        updatedAtMs: NOW_MS - (40 * DAY_MS),
      }),
    },
    marketing_notification_details: details,
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath('marketing_notification_details/zz_orphan_detail'));
  assert.ok(db.getAtPath('marketing_notification_details/retained_detail_000'));
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath('marketing_notification_details/zz_orphan_detail'));
  assert.ok(db.getAtPath('marketing_notification_details/retained_detail_099'));
});

test('legacy compatibility mode does not invoke requeue recovery callbacks', async () => {
  const requeues = {};
  for (let index = 0; index < 100; index += 1) {
    const jobId = `missing_legacy_requeue_${String(index).padStart(3, '0')}`;
    requeues[jobId] = {
      schemaVersion: 1,
      requeueId: `requeue_v1_missing_legacy_${index}`,
      jobId,
      status: 'processing',
      recoveryDueAtMs: NOW_MS,
    };
  }
  requeues.zz_recoverable_legacy_requeue = {
    schemaVersion: 1,
    requeueId: 'requeue_v1_recoverable_legacy',
    jobId: 'zz_recoverable_legacy_requeue',
    status: 'processing',
    recoveryDueAtMs: NOW_MS,
  };
  const db = createNotificationRetentionMemoryDb({ notification_requeue_jobs: requeues });
  const resumed = [];
  const resumeRequeue = async ({ db: targetDb, jobId }) => {
    resumed.push(jobId);
    if (jobId !== 'zz_recoverable_legacy_requeue') {
      return { success: false, complete: false };
    }
    await targetDb.ref(`notification_requeue_jobs/${jobId}`).update({
      status: 'complete', recoveryDueAtMs: null, expiresAtMs: NOW_MS + DAY_MS,
    });
    return { success: true, complete: true };
  };
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS, resumeRequeue });
  assert.equal(resumed.includes('zz_recoverable_legacy_requeue'), false);
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS, resumeRequeue });
  assert.equal(resumed.includes('zz_recoverable_legacy_requeue'), false);
  assert.equal(
    db.getAtPath('notification_requeue_jobs/zz_recoverable_legacy_requeue/recoveryDueAtMs'),
    NOW_MS,
  );
});

test('fail-closed legacy cleanup never installs a fence or deletes children', async () => {
  const job = terminalJob({
    status: 'provider_rejected', updatedAtMs: NOW_MS - (40 * DAY_MS),
    expiresAtMs: NOW_MS + DAY_MS,
  });
  let armed = false;
  let tookOver = false;
  let db;
  db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: { [JOB_ID]: { retained_recipient: { status: 'skipped' } } },
  }, {
    afterTransaction: async ({ pathName, next }) => {
      if (!armed || tookOver || pathName !== `notification_jobs/${JOB_ID}`
        || next?.retentionFence?.kind !== 'legacy') return;
      tookOver = true;
      await requeueFailedNotificationJob({
        db, jobId: JOB_ID,
        nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.leaseMs + 1,
      });
    },
  });
  armed = true;
  const result = await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(tookOver, false);
  assert.equal(result.deleted, 0);
  assert.ok(db.getAtPath(`notification_job_recipients/${JOB_ID}/retained_recipient`));
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
});

test('fail-closed legacy cleanup never creates a destructive commit', async () => {
  const job = terminalJob({
    status: 'provider_rejected',
    updatedAtMs: NOW_MS - (40 * DAY_MS),
    expiresAtMs: NOW_MS + DAY_MS,
  });
  let takeover = null;
  let db;
  db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: { [JOB_ID]: { retained_recipient: { status: 'skipped' } } },
  }, {
    beforeUpdate: async ({ pathName, patch }) => {
      if (takeover || pathName
        || !Object.hasOwn(patch || {}, `notification_job_recipients/${JOB_ID}`)) return;
      takeover = await requeueFailedNotificationJob({
        db,
        jobId: JOB_ID,
        nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 1,
      });
    },
  });
  const result = await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(takeover, null);
  assert.equal(result.deleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
});

test('retired legacy cleanup cannot enter its former destructive recovery path', async () => {
  const job = terminalJob({
    status: 'provider_rejected',
    updatedAtMs: NOW_MS - (40 * DAY_MS),
    expiresAtMs: NOW_MS + DAY_MS,
  });
  let crashed = false;
  let recovering = false;
  let handoffTakeover = null;
  let db;
  db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: job },
    notification_job_recipients: { [JOB_ID]: { retained_recipient: { status: 'skipped' } } },
  }, {
    afterUpdate: ({ pathName, patch }) => {
      if (crashed || pathName
        || !Object.hasOwn(patch || {}, `notification_job_recipients/${JOB_ID}`)) return;
      crashed = true;
      throw new Error('legacy_destructive_hard_crash');
    },
    afterTransaction: async ({ pathName, current, next }) => {
      if (!recovering || handoffTakeover || pathName !== `notification_jobs/${JOB_ID}`
        || current?.retentionFence?.kind !== 'legacy'
        || current.retentionFence.commitStatus !== 'destructive'
        || next?.retentionFence?.kind !== 'legacy'
        || current.retentionFence.leaseOwnerId === next.retentionFence.leaseOwnerId) return;
      handoffTakeover = await requeueFailedNotificationJob({
        db,
        jobId: JOB_ID,
        nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 2,
      });
    },
  });
  const first = await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(first.deleted, 0);
  recovering = true;
  const recovered = await cleanupOldNotificationDeliveryData({
    db,
    nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 1,
  });
  assert.equal(handoffTakeover, null);
  assert.equal(recovered.deleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
});

test('legacy destructive recovery preserves both markers during compactor handoff', async () => {
  const job = terminalJob({
    status: 'provider_rejected',
    retentionGeneration: 0,
    updatedAtMs: NOW_MS - (40 * DAY_MS),
    expiresAtMs: NOW_MS + DAY_MS,
  });
  let crashed = false;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
  }, {
    afterTransaction: ({ pathName, current, next }) => {
      if (crashed || pathName !== `notification_jobs/${JOB_ID}`
        || current?.retentionFence?.kind !== 'legacy'
        || current.retentionFence.commitStatus !== 'destructive'
        || next?.retentionFence?.kind === 'legacy') return;
      crashed = true;
      throw new Error('legacy_to_compactor_handoff_crash');
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, job, nowMs: NOW_MS });
  await db.ref(`notification_jobs/${JOB_ID}`).update({
    retentionGeneration: 1,
    retentionFence: {
      fenceId: 'legacy_retention_fence_v2_destructive_handoff',
      kind: 'legacy',
      status: 'active',
      completedAtMs: job.completedAtMs,
      generation: 1,
      leaseOwnerId: 'expired-legacy-owner',
      leaseRevision: 1,
      leaseExpiresAtMs: NOW_MS - 1,
      rolloutPhase: 'shadow',
      rolloutRevision: 9,
      commitStatus: 'destructive',
    },
  });
  await assert.rejects(
    retention.runNotificationRetentionCycle({
      db, nowMs: NOW_MS, ownerId: 'compactor-recovery-owner',
    }),
    /legacy_to_compactor_handoff_crash/u,
  );
  assert.equal(crashed, true);
  assert.equal(
    db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/commitStatus`),
    'destructive',
  );
  assert.ok(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}/destructiveCommit`));
  await db.ref('notification_retention_rollout/v1').set(null);
  const takeover = await requeueFailedNotificationJob({
    db,
    jobId: JOB_ID,
    nowMs: NOW_MS + retention.DEFAULT_RETENTION_BUDGETS.destructiveCommitLeaseMs + 1,
  });
  assert.equal(takeover.success, false);
  assert.equal(takeover.reason, 'NOTIFICATION_RETENTION_IN_PROGRESS');
});

test('legacy marketing cleanup is fail-closed before and after the detail boundary', async () => {
  const dueAtMs = NOW_MS + DAY_MS;
  const db = createNotificationRetentionMemoryDb({
    marketing_notification_details: {
      future_detail: {
        deliveryJobId: 'missing-job', retentionDueAtMs: dueAtMs,
        updatedAtMs: NOW_MS - (40 * DAY_MS),
      },
    },
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.ok(db.getAtPath('marketing_notification_details/future_detail'));
  await cleanupOldNotificationDeliveryData({ db, nowMs: dueAtMs });
  assert.ok(db.getAtPath('marketing_notification_details/future_detail'));
});

test('legacy cleanup performs no canonical transaction or child deletion', async () => {
  let replaced = false;
  const oldJob = terminalJob({ updatedAtMs: NOW_MS - (40 * DAY_MS) });
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [JOB_ID]: oldJob },
    notification_job_recipients: { [JOB_ID]: { successor: true } },
  }, {
    beforeTransaction: async ({ data, pathName }) => {
      if (replaced || pathName !== `notification_jobs/${JOB_ID}`) return;
      replaced = true;
      setAtPath(data, pathName, terminalJob({
        status: 'privacy_deleted',
        completedAtMs: NOW_MS,
        updatedAtMs: NOW_MS,
        expiresAtMs: NOW_MS + RETENTION_MS,
        retentionDueAtMs: NOW_MS + RETENTION_MS,
        retentionGeneration: 2,
      }));
    },
  });
  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS });
  assert.equal(replaced, false);
  assert.equal(db.getAtPath(`notification_jobs/${JOB_ID}/status`), 'provider_accepted');
  assert.ok(db.getAtPath(`notification_job_recipients/${JOB_ID}/successor`));
});

test('delayed source and coalescing cleanup preserve a newer owner while completing the old job', async () => {
  const oldJobId = `notif_v1_${'d'.repeat(64)}`;
  const newJobId = `notif_v1_${'e'.repeat(64)}`;
  const job = terminalJob({
    jobId: oldJobId,
    retentionGeneration: 0,
    sourceType: 'tour_announcement',
    tourId: 'tour-reused',
    sourceOrderMs: NOW_MS - (40 * DAY_MS),
    navigation: { messageId: 'message-reused' },
    coalescingKey: 'coalescing-reused',
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [oldJobId]: job },
    notification_delivery_attempts: {},
    broadcasts: {
      'tour-reused': {
        'message-reused': { deliveryJobId: newJobId, createdAtMs: NOW_MS },
      },
    },
    notification_job_coalescing: {
      'coalescing-reused': { jobId: newJobId, previousJobId: oldJobId, sourceOrderMs: NOW_MS },
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: oldJobId, nowMs: NOW_MS });
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'source-worker', budgets: { orphanPageSize: 1 },
  });
  assert.equal(result.metrics.jobsCompleted, 1);
  assert.equal(db.getAtPath(`notification_jobs/${oldJobId}`), undefined);
  assert.equal(db.getAtPath('broadcasts/tour-reused/message-reused/deliveryJobId'), newJobId);
  assert.equal(db.getAtPath('notification_job_coalescing/coalescing-reused/jobId'), newJobId);
  assert.equal(db.getAtPath('notification_job_coalescing/coalescing-reused/previousJobId'), null);
});

test('privacy tombstones use only explicit expiry and compact without copied content', async () => {
  const privacyJobId = `notif_v1_${'f'.repeat(64)}`;
  const privacy = terminalJob({
    jobId: privacyJobId,
    status: 'privacy_deleted',
    completedAtMs: NOW_MS - (365 * DAY_MS),
    retentionDueAtMs: NOW_MS - (335 * DAY_MS),
    expiresAtMs: NOW_MS + 1,
    retentionGeneration: 0,
    presentation: undefined,
    navigation: undefined,
  });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [privacyJobId]: privacy },
    notification_delivery_attempts: {},
  });
  const scheduled = await retention.ensureNotificationRetentionScheduled({
    db, jobId: privacyJobId, nowMs: NOW_MS,
  });
  assert.equal(scheduled.dueAtMs, NOW_MS + 1);
  const early = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'privacy-early', budgets: { orphanPageSize: 1 },
  });
  assert.equal(early.metrics.jobsCompleted, 0);
  assert.ok(db.getAtPath(`notification_jobs/${privacyJobId}`));
  const due = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS + 1, ownerId: 'privacy-due', budgets: { orphanPageSize: 1 },
  });
  assert.equal(due.metrics.jobsCompleted, 1);
  assert.equal(db.getAtPath(`notification_jobs/${privacyJobId}`), undefined);
});

test('orphan cursor skips malformed and active-parent records without starving equal timestamps', async () => {
  const activeJobId = `notif_v1_${'1'.repeat(64)}`;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [activeJobId]: { jobId: activeJobId, status: 'retrying' } },
    notification_delivery_attempts: {
      a_malformed: { attemptId: 'a_malformed', jobId: 'missing-a', status: 'prepared', retentionDueAtMs: NOW_MS },
      b_orphan: { attemptId: 'b_orphan', jobId: 'missing-b', status: 'provider_accepted', retentionDueAtMs: NOW_MS },
      c_orphan: { attemptId: 'c_orphan', jobId: 'missing-c', status: 'superseded', retentionDueAtMs: NOW_MS },
      d_active: { attemptId: 'd_active', jobId: activeJobId, status: 'provider_accepted', retentionDueAtMs: NOW_MS },
    },
  });
  const first = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'orphan-page-1',
    budgets: {
      orphanPageSize: 2, maxOrphanPages: 1, auxiliaryPageSize: 1, maxAuxiliaryPages: 1,
    },
  });
  assert.equal(first.metrics.orphanAttemptsMalformed, 1);
  assert.equal(first.metrics.orphanAttemptsDeleted, 1);
  assert.equal(first.hasMore, true);
  const second = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'orphan-page-2',
    budgets: {
      orphanPageSize: 2, maxOrphanPages: 1, auxiliaryPageSize: 1, maxAuxiliaryPages: 1,
    },
  });
  assert.equal(second.metrics.orphanAttemptsDeleted, 1);
  assert.ok(db.getAtPath('notification_delivery_attempts/a_malformed'));
  assert.ok(db.getAtPath('notification_delivery_attempts/d_active'));
  assert.equal(db.getAtPath('notification_delivery_attempts/b_orphan'), undefined);
  assert.equal(db.getAtPath('notification_delivery_attempts/c_orphan'), undefined);
});

test('orphan marketing cursor advances beyond a full retained-parent page', async () => {
  const activeJobId = `notif_v1_${'2'.repeat(64)}`;
  const details = {};
  for (let index = 0; index < 250; index += 1) {
    const detailId = `retained_marketing_${String(index).padStart(3, '0')}`;
    details[detailId] = {
      deliveryJobId: activeJobId,
      retentionDueAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    };
  }
  details.zz_orphan_marketing = {
    deliveryJobId: 'missing_marketing_parent',
    retentionDueAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [activeJobId]: { jobId: activeJobId, status: 'retrying' } },
    marketing_notification_details: details,
  });
  const first = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'orphan-marketing-page-1',
    budgets: { orphanPageSize: 1, auxiliaryPageSize: 250 },
  });
  assert.equal(first.metrics.marketingDetailsDeleted, 0);
  assert.equal(first.hasMore, true);
  assert.ok(db.getAtPath('marketing_notification_details/zz_orphan_marketing'));
  const second = await retention.runNotificationRetentionCycle({
    db,
    nowMs: NOW_MS,
    ownerId: 'orphan-marketing-page-2',
    budgets: { orphanPageSize: 1, auxiliaryPageSize: 250 },
  });
  assert.equal(second.metrics.marketingDetailsDeleted, 1);
  assert.equal(db.getAtPath('marketing_notification_details/zz_orphan_marketing'), undefined);
  assert.ok(db.getAtPath('marketing_notification_details/retained_marketing_249'));
});

test('preview and requeue expiry drains several bounded pages with exact continuation', async () => {
  const previews = {};
  const requeues = {};
  for (let index = 0; index < 450; index += 1) {
    const key = `record_${String(index).padStart(4, '0')}`;
    previews[key] = { expiresAtMs: NOW_MS };
    requeues[key] = { status: 'complete', expiresAtMs: NOW_MS };
  }
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: {},
    notification_delivery_attempts: {},
    notification_audience_previews: previews,
    notification_requeue_jobs: requeues,
  });
  let previewsDeleted = 0;
  let requeuesDeleted = 0;
  let result;
  for (let invocation = 0; invocation < 3; invocation += 1) {
    result = await retention.runNotificationRetentionCycle({
      db,
      nowMs: NOW_MS,
      ownerId: `aux-${invocation}`,
      budgets: { orphanPageSize: 1, auxiliaryPageSize: 100, maxAuxiliaryPages: 2 },
    });
    previewsDeleted += result.metrics.previewsDeleted;
    requeuesDeleted += result.metrics.requeueJobsDeleted;
    assert.ok(result.metrics.maxRecordsInMemory <= 101);
  }
  assert.equal(previewsDeleted, 450);
  assert.equal(requeuesDeleted, 450);
  assert.equal(result.hasMore, false);
  assert.equal(Object.keys(db.getAtPath('notification_audience_previews') || {}).length, 0);
  assert.equal(Object.keys(db.getAtPath('notification_requeue_jobs') || {}).length, 0);
});

test('a compare-safe rollback stops an in-flight compactor before its next page or phase', async () => {
  const attempts = {};
  for (let index = 0; index < 400; index += 1) {
    const attemptId = `rollback_attempt_${String(index).padStart(4, '0')}`;
    attempts[attemptId] = {
      schemaVersion: 2,
      attemptId,
      jobId: JOB_ID,
      status: 'provider_accepted',
      retentionDueAtMs: NOW_MS,
    };
  }
  let rolledBack = false;
  const job = terminalJob({ retentionGeneration: 0 });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: compactorRollout() },
    notification_retention: { v1: { evidence: {
      shadow: compactorShadowEvidence(), canary: compactorCanaryEvidence(),
    } } },
    notification_jobs: { [JOB_ID]: job },
    notification_delivery_attempts: attempts,
    notification_job_recipients: { [JOB_ID]: { recipient_1: true } },
  }, {
    beforeUpdate: async ({ data, pathName, patch }) => {
      if (rolledBack || pathName
        || !Object.keys(patch || {}).some((key) => key.startsWith('notification_delivery_attempts/'))) return;
      rolledBack = true;
      setAtPath(data, 'notification_retention_rollout/v1', {
        schemaVersion: 1,
        phase: 'legacy',
        revision: compactorRollout().revision + 1,
        preparationComplete: false,
        evidenceDigest: compactorRollout().evidenceDigest,
        updatedAtMs: NOW_MS,
      });
    },
  });
  await retention.ensureNotificationRetentionScheduled({ db, jobId: JOB_ID, nowMs: NOW_MS });

  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, ownerId: 'rollback-worker', budgets: { orphanPageSize: 1 },
  });

  assert.equal(rolledBack, true);
  assert.equal(result.budgetExhaustionReason, 'rollout_changed');
  assert.equal(result.metrics.rolloutAuthorizationFailures, 1);
  assert.equal(result.metrics.attemptsDeleted, 0, 'stale metrics must not claim the bounded page');
  assert.equal(Object.keys(db.getAtPath('notification_delivery_attempts') || {}).length, 150);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${JOB_ID}/phase`), 'attempts');
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.ok(db.getAtPath(`notification_job_recipients/${JOB_ID}/recipient_1`));

  await cleanupOldNotificationDeliveryData({ db, nowMs: NOW_MS + RETENTION_MS });
  assert.ok(db.getAtPath(`notification_jobs/${JOB_ID}`));
  assert.equal(
    db.getAtPath(`notification_jobs/${JOB_ID}/retentionFence/commitStatus`),
    'destructive',
  );
  const recoveryEvidence = compactorShadowEvidence(10);
  const recoveryCanary = compactorCanaryEvidence(11, recoveryEvidence);
  await db.ref('notification_retention/v1/evidence').set({
    shadow: recoveryEvidence,
    canary: recoveryCanary,
  });
  await db.ref('notification_retention_rollout/v1').set(protocolRollout({
    schemaVersion: 1,
    phase: 'compactor',
    revision: 12,
    preparationComplete: true,
    preparationRolloutRevision: 7,
    evidenceDigest: compactorRollout().evidenceDigest,
    shadowEvidenceFingerprint: recoveryEvidence.evidenceFingerprint,
    shadowEvidenceRevision: 10,
    canaryPassed: true,
    canaryEvidenceFingerprint: recoveryCanary.evidenceFingerprint,
    canaryEvidenceRevision: 11,
    updatedAtMs: NOW_MS + RETENTION_MS + 1,
  }));
  await retention.writeRetentionDeploymentHeartbeat({
    db, nowMs: NOW_MS + RETENTION_MS + 1,
  });
  await db.ref('notification_retention/v1/deployment_attestations').remove();
  const recoveredDb = createNotificationRetentionMemoryDb(db.data);
  const recovered = await retention.runNotificationRetentionCycle({
    db: recoveredDb, nowMs: NOW_MS + RETENTION_MS + 1, ownerId: 'rollback-recovery-worker',
  });
  assert.equal(recovered.metrics.jobsDeferred, 0);
  assert.equal(recoveredDb.getAtPath(`notification_retention/v1/jobs/${JOB_ID}`), undefined);
  assert.equal(Object.keys(recoveredDb.getAtPath('notification_retention/v1/queue') || {}).length, 0);
  assert.equal(Object.keys(recoveredDb.getAtPath('notification_delivery_attempts') || {}).length, 0);
});
