'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RETENTION_MS,
  buildCanaryEvidenceFingerprint,
  buildShadowEvidenceFingerprint,
  ensureNotificationRetentionScheduled,
  runNotificationRetentionPreflight,
  runNotificationRetentionPreflightAll,
  runNotificationRetentionPreparation,
  transitionNotificationRetentionRollout,
} = require('../functions/src/domains/notification-retention/public');
const {
  createNotificationRetentionMemoryDb,
  setAtPath,
} = require('./helpers/notificationRetentionMemoryDb');

const NOW_MS = 1_800_000_000_000;
const jobId = (character) => `notif_v1_${character.repeat(64)}`;
const terminalJob = (id, completedAtMs = NOW_MS - RETENTION_MS) => ({
  schemaVersion: 1,
  jobId: id,
  status: 'provider_accepted',
  completedAtMs,
  updatedAtMs: 123,
});

test('scheduling once-writes a future ordinary boundary and ignores an active requeue until execution', async () => {
  const id = jobId('a');
  const completedAtMs = NOW_MS - 1_000;
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [id]: {
        ...terminalJob(id, completedAtMs),
        lease: { ownerId: 'delivery-worker', expiresAtMs: NOW_MS + 60_000 },
      },
    },
    notification_requeue_jobs: { [id]: { status: 'processing', expiresAtMs: NOW_MS + 60_000 } },
  });
  const first = await ensureNotificationRetentionScheduled({ db, jobId: id, nowMs: NOW_MS });
  const second = await ensureNotificationRetentionScheduled({ db, jobId: id, nowMs: NOW_MS });
  assert.equal(first.reason, 'scheduled');
  assert.equal(first.dueAtMs, completedAtMs + RETENTION_MS);
  assert.equal(second.reason, 'already_scheduled');
  assert.equal(db.getAtPath(`notification_jobs/${id}/updatedAtMs`), 123);
  assert.equal(db.getAtPath(`notification_jobs/${id}/lease/ownerId`), 'delivery-worker');
  assert.equal(Object.keys(db.getAtPath('notification_retention/v1/queue')).length, 1);
});

test('preparation preserves indexed order, resumes by CAS and schedules ordinary and privacy records', async () => {
  const firstId = jobId('b');
  const secondId = jobId('c');
  const privacyId = jobId('d');
  const recentId = jobId('f');
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [secondId]: terminalJob(secondId, NOW_MS - RETENTION_MS),
      [firstId]: terminalJob(firstId, NOW_MS - RETENTION_MS - 1),
      [recentId]: terminalJob(recentId, NOW_MS - 1_000),
      [privacyId]: {
        schemaVersion: 1,
        jobId: privacyId,
        status: 'privacy_deleted',
        completedAtMs: NOW_MS - (365 * 24 * 60 * 60 * 1000),
        expiresAtMs: NOW_MS + 60_000,
      },
    },
    notification_delivery_attempts: {
      orphan_1: {
        attemptId: 'orphan_1',
        jobId: jobId('9'),
        status: 'provider_accepted',
        retentionDueAtMs: NOW_MS,
      },
    },
  });
  let result;
  for (let page = 0; page < 8; page += 1) {
    result = await runNotificationRetentionPreparation({
      db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0,
      pageSize: 1, budgets: { orphanPageSize: 1 },
    });
    if (result.preparationComplete) break;
  }
  assert.equal(result.preparationComplete, true);
  assert.equal(result.cumulative.materialized, 3);
  assert.equal(result.cumulative.scheduled, 4);
  assert.equal(result.cumulative.orphanAttemptsFound, 1);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/status'), 'complete');
  assert.deepEqual(
    Object.keys(db.getAtPath('notification_retention/v1/jobs')).sort(),
    [firstId, secondId, recentId, privacyId].sort(),
  );
});

test('stale preparation progress cannot advance over a concurrent revision', async () => {
  const id = jobId('e');
  let injected = false;
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [id]: terminalJob(id) },
    notification_delivery_attempts: {},
  }, {
    beforeTransaction: ({ data, pathName }) => {
      if (injected || pathName !== 'notification_retention/v1/preparation') return;
      injected = true;
      setAtPath(data, pathName, {
        schemaVersion: 1,
        revision: 1,
        cursor: 'ordinary~0~',
        orphanCursor: null,
        cumulative: {},
        status: 'processing',
        preparationComplete: false,
      });
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.progressConflict, true);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/revision'), 1);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/cursor'), 'ordinary~0~');
});

test('preparation apply requires the exact rollout revision before every write', async () => {
  const id = jobId('7');
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [id]: terminalJob(id) },
  });
  const missingRevision = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, pageSize: 10,
  });
  assert.equal(missingRevision.reason, 'expected_rollout_revision_required');
  const staleRevision = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 1, pageSize: 10,
  });
  assert.equal(staleRevision.reason, 'rollout_changed');
  assert.equal(db.getAtPath(`notification_jobs/${id}/retentionDueAtMs`), undefined);
  assert.equal(db.getAtPath('notification_retention/v1/preparation'), undefined);
});

test('rollout change after one idempotent preparation write never advances progress', async () => {
  const id = jobId('8');
  let changed = false;
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: { [id]: terminalJob(id) },
  }, {
    afterTransaction: ({ data, pathName, committed }) => {
      if (!changed && committed && pathName === `notification_jobs/${id}`) {
        changed = true;
        setAtPath(data, 'notification_retention_rollout/v1', {
          schemaVersion: 1, phase: 'shadow', revision: 1,
          preparationComplete: true, preparationRolloutRevision: 0,
          evidenceDigest: 'changed', updatedAtMs: NOW_MS,
        });
      }
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.reason, 'rollout_changed');
  assert.equal(result.hasMore, true);
  assert.equal(db.getAtPath(`notification_jobs/${id}/retentionDueAtMs`), NOW_MS);
  assert.equal(db.getAtPath('notification_retention/v1/preparation'), undefined);
  assert.equal(db.getAtPath(`notification_retention/v1/jobs/${id}`), undefined);
});

test('completed preparation from an older rollout requires explicit restart', async () => {
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: {
      v1: { schemaVersion: 1, phase: 'legacy', revision: 2, preparationComplete: false },
    },
    notification_retention: {
      v1: {
        preparation: {
          schemaVersion: 1, revision: 3, rolloutRevision: 0,
          cursor: 'privacy~0~', orphanCursor: null, cumulative: {},
          status: 'complete', preparationComplete: true, evidenceDigest: 'old',
        },
      },
    },
  });
  const rejected = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 2, pageSize: 10,
  });
  assert.equal(rejected.reason, 'rollout_revision_restart_required');
  const restarted = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 2,
    pageSize: 10, budgets: { restart: true },
  });
  assert.notEqual(restarted.reason, 'rollout_revision_restart_required');
  assert.equal(db.getAtPath('notification_retention/v1/preparation/rolloutRevision'), 2);
});

test('preflight reports active, nonterminal, privacy and malformed-orphan exclusions', async () => {
  const eligibleId = jobId('2');
  const activeLeaseId = jobId('3');
  const nonTerminalId = jobId('4');
  const privacyId = jobId('5');
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: {
      [eligibleId]: {
        ...terminalJob(eligibleId), retentionDueAtMs: NOW_MS,
      },
      [activeLeaseId]: {
        ...terminalJob(activeLeaseId, NOW_MS - 1_000),
        retentionDueAtMs: NOW_MS - 1_000 + RETENTION_MS,
        lease: { ownerId: 'live', expiresAtMs: NOW_MS + 1 },
      },
      [nonTerminalId]: {
        ...terminalJob(nonTerminalId), status: 'retrying', retentionDueAtMs: NOW_MS,
      },
      [privacyId]: {
        jobId: privacyId, status: 'privacy_deleted', expiresAtMs: NOW_MS + 10_000,
      },
    },
    notification_delivery_attempts: {
      malformed: {
        attemptId: 'malformed', jobId: 'missing', status: 'prepared', retentionDueAtMs: NOW_MS,
      },
    },
  });
  const ordinary = await runNotificationRetentionPreflight({
    db, nowMs: NOW_MS, pageSize: 10, budgets: { orphanPageSize: 10 },
  });
  assert.equal(ordinary.ordinaryEligible, 1);
  assert.equal(ordinary.activeLeaseExcluded, 1);
  assert.equal(ordinary.nonTerminalExcluded, 1);
  assert.equal(ordinary.orphanAttemptsMalformed, 1);
  assert.equal(ordinary.requiresAttention, 1);
  const privacy = await runNotificationRetentionPreflight({
    db, nowMs: NOW_MS, pageSize: 10, cursor: ordinary.cursor,
    budgets: { orphanPageSize: 10 },
  });
  assert.equal(privacy.privacyNotDue, 1);
  assert.equal(privacy.privacyEligible, 0);
});

test('complete preflight drains 500 jobs without cursor feedback or unbounded memory', async () => {
  const jobs = {};
  for (let index = 0; index < 500; index += 1) {
    const id = `notif_v1_${index.toString(16).padStart(64, '0')}`;
    jobs[id] = terminalJob(id);
  }
  const db = createNotificationRetentionMemoryDb({
    notification_jobs: jobs,
    notification_delivery_attempts: {},
  });
  const result = await runNotificationRetentionPreflightAll({
    db, nowMs: NOW_MS, pageSize: 100, maxPages: 20, budgets: { orphanPageSize: 100 },
  });
  assert.equal(result.hasMore, false);
  assert.equal(result.preparationComplete, true);
  assert.equal(result.ordinaryEligible, 500);
  assert.ok(result.pagesScanned <= 8);
  assert.ok(result.maxRecordsInMemory <= 101);
});

test('forward rollout transitions require matching completed preparation evidence', async () => {
  const db = createNotificationRetentionMemoryDb({});
  const blocked = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'legacy',
    expectedRevision: 0,
    nextPhase: 'shadow',
    actor: 'operations',
    nowMs: NOW_MS,
    preparationComplete: true,
  });
  assert.equal(blocked.transitioned, false);
  await db.ref('notification_retention/v1/preparation').set({
    schemaVersion: 1,
    revision: 2,
    rolloutRevision: 0,
    status: 'complete',
    preparationComplete: true,
    evidenceDigest: 'evidence-1',
    cumulative: { requiresAttention: 0, orphanAttemptsFound: 0 },
  });
  const shadow = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'legacy',
    expectedRevision: 0,
    nextPhase: 'shadow',
    actor: 'operations',
    nowMs: NOW_MS,
    preparationComplete: true,
    evidenceDigest: 'evidence-1',
  });
  assert.equal(shadow.transitioned, true);
  const blockedCompactor = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'shadow',
    expectedRevision: 1,
    nextPhase: 'compactor',
    actor: 'operations',
    nowMs: NOW_MS + 1,
    preparationComplete: true,
    evidenceDigest: 'evidence-1',
  });
  assert.equal(blockedCompactor.transitioned, false);
  const shadowEvidence = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision: 1,
    status: 'passed',
    shadowEligible: 1,
    shadowLegacyEligible: 1,
    shadowMismatches: 0,
    compactorScanned: 1,
    legacyScanned: 1,
    hasMore: false,
  };
  await db.ref('notification_retention/v1/evidence/shadow').set({
    ...shadowEvidence,
    evidenceFingerprint: buildShadowEvidenceFingerprint(shadowEvidence),
  });
  const compactor = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'shadow',
    expectedRevision: 1,
    nextPhase: 'compactor',
    actor: 'operations',
    nowMs: NOW_MS + 2,
    preparationComplete: true,
    evidenceDigest: 'evidence-1',
  });
  assert.equal(compactor.transitioned, true);
  assert.equal(compactor.rollout.revision, 2);
  assert.equal(compactor.rollout.canaryPassed, false);

  const canaryEvidence = {
    schemaVersion: 1,
    phase: 'canary',
    rolloutRevision: 2,
    status: 'passed',
    evidenceDigest: 'evidence-1',
    shadowEvidenceFingerprint: compactor.rollout.shadowEvidenceFingerprint,
    jobsDiscovered: 1,
    jobsClaimed: 1,
    jobsCompleted: 1,
    attemptsDeleted: 1,
    failures: 0,
    fixtureFingerprint: 'c'.repeat(64),
    fixtureCompleted: true,
  };
  await db.ref('notification_retention/v1/evidence/canary').set({
    ...canaryEvidence,
    evidenceFingerprint: buildCanaryEvidenceFingerprint(canaryEvidence),
  });
  const activated = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'compactor',
    expectedRevision: 2,
    nextPhase: 'compactor',
    actor: 'operations',
    nowMs: NOW_MS + 3,
    evidenceDigest: 'evidence-1',
  });
  assert.equal(activated.transitioned, true);
  assert.equal(activated.rollout.revision, 3);
  assert.equal(activated.rollout.canaryPassed, true);
});

test('a shadow evidence change during activation is automatically rolled back', async () => {
  const passed = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision: 1,
    status: 'passed',
    shadowEligible: 2,
    shadowLegacyEligible: 2,
    shadowMismatches: 0,
    compactorScanned: 2,
    legacyScanned: 2,
    hasMore: false,
  };
  passed.evidenceFingerprint = buildShadowEvidenceFingerprint(passed);
  const failed = {
    ...passed,
    status: 'failed',
    shadowMismatches: 1,
  };
  failed.evidenceFingerprint = buildShadowEvidenceFingerprint(failed);
  let evidenceReads = 0;
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: {
      v1: {
        schemaVersion: 1,
        phase: 'shadow',
        revision: 1,
        preparationComplete: true,
        preparationRolloutRevision: 0,
        evidenceDigest: 'evidence-1',
        updatedAtMs: NOW_MS,
      },
    },
    notification_retention: {
      v1: {
        preparation: {
          schemaVersion: 1,
          status: 'complete',
          preparationComplete: true,
          rolloutRevision: 0,
          evidenceDigest: 'evidence-1',
          cumulative: { requiresAttention: 0 },
        },
        evidence: { shadow: passed },
      },
    },
  }, {
    beforeOnce: async ({ data, pathName }) => {
      if (pathName !== 'notification_retention/v1/evidence/shadow') return;
      evidenceReads += 1;
      if (evidenceReads === 2) {
        setAtPath(data, 'notification_retention/v1/evidence/shadow', failed);
      }
    },
  });
  const result = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'shadow',
    expectedRevision: 1,
    nextPhase: 'compactor',
    actor: 'operations',
    nowMs: NOW_MS + 1,
    preparationComplete: true,
    evidenceDigest: 'evidence-1',
  });
  assert.equal(result.transitioned, false);
  assert.equal(result.reason, 'activation_evidence_changed');
  assert.equal(result.rollout.phase, 'shadow');
  assert.equal(result.rollout.revision, 3);
});
