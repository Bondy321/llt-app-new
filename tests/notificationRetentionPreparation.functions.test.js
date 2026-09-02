'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RETENTION_MS,
  buildCanaryEvidenceFingerprint,
  buildShadowEvidenceFingerprint,
  compiledRetentionProtocol,
  ensureNotificationRetentionScheduled,
  runNotificationRetentionPreflight,
  runNotificationRetentionPreflightAll,
  runNotificationRetentionPreparation,
  transitionNotificationRetentionRollout,
  writeRetentionDeploymentHeartbeat,
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
const pausedRollout = (revision = 0) => {
  const protocol = compiledRetentionProtocol();
  return {
    schemaVersion: 1, phase: 'paused', revision, preparationComplete: false,
    ...protocol, expectedEngineProtocolId: protocol.retentionEngineProtocolId, updatedAtMs: NOW_MS,
  };
};
const createPausedPreparationDb = (initial = {}, hooks = {}) => createNotificationRetentionMemoryDb({
  ...initial,
  notification_retention_rollout: initial.notification_retention_rollout
    || { v1: pausedRollout() },
}, hooks);

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
  const db = createPausedPreparationDb({
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
        schemaVersion: 1,
        attemptId: 'orphan_1',
        jobId: jobId('9'),
        status: 'provider_accepted',
        createdAtMs: NOW_MS - RETENTION_MS,
        updatedAtMs: NOW_MS - RETENTION_MS,
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

test('preparation resumes against authoritative RTDB values after null-first callbacks', async () => {
  const firstId = jobId('a');
  const secondId = jobId('b');
  const db = createPausedPreparationDb({
    notification_jobs: {
      [firstId]: terminalJob(firstId, NOW_MS - RETENTION_MS - 2),
      [secondId]: terminalJob(secondId, NOW_MS - RETENTION_MS - 1),
    },
    notification_delivery_attempts: {},
  }, { nullFirstTransactions: true });

  const first = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 1,
  });
  const second = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 1,
  });

  assert.equal(first.progressConflict, false);
  assert.equal(second.progressConflict, false);
  assert.equal(second.cumulative.scanned, 2);
  assert.equal(second.cumulative.requiresAttention, 0);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/revision'), 2);
});

test('stale preparation progress cannot advance over a concurrent revision', async () => {
  const id = jobId('e');
  let injected = false;
  const db = createPausedPreparationDb({
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
  const db = createPausedPreparationDb({
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
  const db = createPausedPreparationDb({
    notification_jobs: { [id]: terminalJob(id) },
  }, {
    afterTransaction: ({ data, pathName, committed }) => {
      if (!changed && committed && pathName === `notification_jobs/${id}`) {
        changed = true;
        setAtPath(data, 'notification_retention_rollout/v1', {
          schemaVersion: 1, phase: 'shadow', revision: 1,
          ...compiledRetentionProtocol(),
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
  const db = createPausedPreparationDb({
    notification_retention_rollout: {
      v1: pausedRollout(2),
    },
    notification_retention: {
      v1: {
        preparation: {
          schemaVersion: 1, revision: 3, rolloutRevision: 0,
          cursor: 'privacy~0~', orphanCursor: null, cumulative: {},
          status: 'complete', preparationComplete: true, evidenceDigest: 'old',
          ...compiledRetentionProtocol(),
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
        schemaVersion: 1,
        attemptId: 'malformed',
        jobId: 'missing',
        status: 'prepared',
        createdAtMs: NOW_MS - 1,
        updatedAtMs: NOW_MS,
        retentionDueAtMs: NOW_MS,
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

test('historical v1 and v2 terminal attempts receive durable boundaries before orphan discovery', async () => {
  const parentlessJob = jobId('6');
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      attempt_v1: {
        schemaVersion: 1, attemptId: 'attempt_v1', jobId: parentlessJob,
        status: 'provider_accepted', createdAtMs: NOW_MS - RETENTION_MS - 20,
        updatedAtMs: NOW_MS - RETENTION_MS - 10,
      },
      attempt_v2: {
        schemaVersion: 2, attemptId: 'attempt_v2', jobId: parentlessJob,
        status: 'ticket_rejected', createdAtMs: NOW_MS - RETENTION_MS - 10,
        updatedAtMs: NOW_MS - RETENTION_MS,
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
  assert.equal(result.cumulative.attemptBoundariesMaterialized, 2);
  assert.equal(result.cumulative.orphanAttemptsFound, 2);
  assert.equal(db.getAtPath('notification_delivery_attempts/attempt_v1/retentionDueAtMs'), NOW_MS - 10);
  assert.equal(db.getAtPath('notification_delivery_attempts/attempt_v2/retentionDueAtMs'), NOW_MS);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/attemptMigrationComplete'), true);
  assert.equal(db.getAtPath('notification_retention/v1/preparation/attemptScanEndAtMs'), NOW_MS);
  const attemptQueries = db.queryLog.filter((entry) => entry.pathName === 'notification_delivery_attempts');
  assert.ok(attemptQueries.findIndex((entry) => entry.query.orderBy?.field === 'updatedAtMs')
    < attemptQueries.findIndex((entry) => entry.query.orderBy?.field === 'retentionDueAtMs'));
});

test('equal updatedAtMs cursors are exact and a progress crash replays idempotently', async () => {
  const attempts = {};
  for (let index = 0; index < 5; index += 1) {
    const attemptId = `same_time_${index}`;
    attempts[attemptId] = {
      schemaVersion: index % 2 ? 1 : 2,
      attemptId,
      jobId: jobId(String(index + 1)),
      status: 'provider_rejected',
      createdAtMs: NOW_MS - 2_000,
      updatedAtMs: NOW_MS - 1_000,
    };
  }
  let injected = false;
  const db = createPausedPreparationDb({ notification_delivery_attempts: attempts }, {
    beforeTransaction: ({ data, pathName }) => {
      if (injected || pathName !== 'notification_retention/v1/preparation') return;
      injected = true;
      setAtPath(data, pathName, {
        schemaVersion: 1, revision: 1, rolloutRevision: null,
        cursor: 'ordinary~0~', orphanCursor: null, cumulative: {},
        status: 'processing', preparationComplete: false, ...compiledRetentionProtocol(),
      });
    },
  });
  const crashed = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 2,
  });
  assert.equal(crashed.progressConflict, true);
  assert.equal(db.getAtPath('notification_delivery_attempts/same_time_0/retentionDueAtMs'), NOW_MS - 1_000 + RETENTION_MS);
  assert.equal(db.getAtPath('notification_delivery_attempts/same_time_1/retentionDueAtMs'), NOW_MS - 1_000 + RETENTION_MS);

  let result;
  for (let page = 0; page < 10; page += 1) {
    result = await runNotificationRetentionPreparation({
      db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0,
      pageSize: 2, budgets: { orphanPageSize: 2 },
    });
    if (result.preparationComplete) break;
  }
  assert.equal(result.preparationComplete, true);
  assert.equal(result.cumulative.attemptBoundariesMaterialized, 3);
  assert.equal(result.cumulative.attemptBoundariesAlreadyPrepared, 2);
  assert.equal(new Set(Object.values(db.getAtPath('notification_delivery_attempts'))
    .map((attempt) => attempt.retentionDueAtMs)).size, 1);
});

test('unsafe historical attempts fail closed with a hashed terminal warning', async () => {
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      unsafe_attempt: {
        schemaVersion: 1, attemptId: 'unsafe_attempt', jobId: jobId('a'),
        status: 'unknown_terminal_state', createdAtMs: NOW_MS - 2_000, updatedAtMs: NOW_MS - 1_000,
      },
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.attemptMigrationWarnings, 1);
  assert.equal(result.requiresAttention, 1);
  assert.equal(db.getAtPath('notification_delivery_attempts/unsafe_attempt/retentionDueAtMs'), undefined);
  const warnings = Object.values(db.getAtPath('operations_terminal_warnings/v1'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].reason, 'unsafe_historical_attempt');
  assert.notEqual(warnings[0].identifierHashes.attemptId, 'unsafe_attempt');
});

test('historical attempts missing a positive updated timestamp are scanned, preserved and warned', async () => {
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      missing_updated_at: {
        schemaVersion: 1,
        attemptId: 'missing_updated_at',
        jobId: jobId('c'),
        status: 'provider_accepted',
        createdAtMs: NOW_MS - 1_000,
      },
      zero_updated_at: {
        schemaVersion: 2,
        attemptId: 'zero_updated_at',
        jobId: jobId('d'),
        status: 'provider_rejected',
        createdAtMs: NOW_MS - 1_000,
        updatedAtMs: 0,
      },
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.attemptsScanned, 2);
  assert.equal(result.attemptMigrationWarnings, 2);
  assert.equal(result.preparationComplete, false);
  assert.equal(db.getAtPath('notification_delivery_attempts/missing_updated_at/retentionDueAtMs'), undefined);
  assert.equal(db.getAtPath('notification_delivery_attempts/zero_updated_at/retentionDueAtMs'), undefined);
  assert.equal(Object.keys(db.getAtPath('operations_terminal_warnings/v1')).length, 2);
});

test('non-numeric timestamps cannot sit beyond a numeric migration bound', async () => {
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      string_timestamp: {
        schemaVersion: 1,
        attemptId: 'string_timestamp',
        jobId: jobId('7'),
        status: 'provider_accepted',
        createdAtMs: NOW_MS - 1_000,
        updatedAtMs: 'not-a-timestamp',
      },
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.attemptsScanned, 1);
  assert.equal(result.attemptMigrationWarnings, 1);
  assert.equal(result.preparationComplete, false);
  assert.equal(Object.keys(db.getAtPath('operations_terminal_warnings/v1')).length, 1);
});

test('an unpageable malformed timestamp suffix blocks instead of skipping unseen records', async () => {
  const attempts = Object.fromEntries(['a', 'b'].map((suffix) => [`object_${suffix}`, {
    schemaVersion: 1,
    attemptId: `object_${suffix}`,
    jobId: jobId('8'),
    status: 'provider_accepted',
    createdAtMs: NOW_MS - 1_000,
    updatedAtMs: { malformed: true },
  }]));
  const db = createPausedPreparationDb({ notification_delivery_attempts: attempts });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 1,
  });
  assert.equal(result.attemptsScanned, 1);
  assert.equal(result.attemptMigrationWarnings, 1);
  assert.equal(result.attemptMigrationComplete, false);
  assert.equal(result.attemptCursor, null);
  assert.equal(result.preparationComplete, false);
});

test('unsupported attempt schemas and shortened existing boundaries block preparation', async () => {
  const expectedBoundary = NOW_MS - 1_000 + RETENTION_MS;
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      future_schema: {
        schemaVersion: 3,
        attemptId: 'future_schema',
        jobId: jobId('e'),
        status: 'provider_accepted',
        createdAtMs: NOW_MS - 2_000,
        updatedAtMs: NOW_MS - 1_000,
      },
      shortened_boundary: {
        schemaVersion: 1,
        attemptId: 'shortened_boundary',
        jobId: jobId('f'),
        status: 'provider_rejected',
        createdAtMs: NOW_MS - 2_000,
        updatedAtMs: NOW_MS - 1_000,
        retentionDueAtMs: expectedBoundary - 1,
      },
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(result.attemptBoundariesMaterialized, 0);
  assert.equal(result.attemptMigrationWarnings, 2);
  assert.equal(result.preparationComplete, false);
  assert.equal(db.getAtPath('notification_delivery_attempts/future_schema/retentionDueAtMs'), undefined);
  assert.equal(
    db.getAtPath('notification_delivery_attempts/shortened_boundary/retentionDueAtMs'),
    expectedBoundary - 1,
  );
});

test('a concurrently shortened boundary is rejected and warned inside the transaction', async () => {
  const attemptId = 'concurrently_shortened';
  let shortened = false;
  const db = createPausedPreparationDb({
    notification_delivery_attempts: {
      [attemptId]: {
        schemaVersion: 1,
        attemptId,
        jobId: jobId('6'),
        status: 'provider_accepted',
        createdAtMs: NOW_MS - 2_000,
        updatedAtMs: NOW_MS - 1_000,
      },
    },
  }, {
    beforeTransaction: ({ data, pathName }) => {
      if (!shortened && pathName === `notification_delivery_attempts/${attemptId}`) {
        shortened = true;
        setAtPath(data, `${pathName}/retentionDueAtMs`, 1);
      }
    },
  });
  const result = await runNotificationRetentionPreparation({
    db, nowMs: NOW_MS, apply: true, expectedRolloutRevision: 0, pageSize: 10,
  });
  assert.equal(shortened, true);
  assert.equal(result.attemptBoundariesMaterialized, 0);
  assert.equal(result.attemptMigrationWarnings, 1);
  assert.equal(result.preparationComplete, false);
  assert.equal(db.getAtPath(`notification_delivery_attempts/${attemptId}/retentionDueAtMs`), 1);
});

test('restart ignores a supplied future cursor and begins from canonical initial progress', async () => {
  const eligibleId = jobId('1');
  const eligible = terminalJob(eligibleId);
  const db = createPausedPreparationDb({ notification_jobs: { [eligible.jobId]: eligible } });
  const result = await runNotificationRetentionPreparation({
    db,
    nowMs: NOW_MS,
    apply: true,
    expectedRolloutRevision: 0,
    cursor: 'ordinary~9999999999999~zzzz',
    pageSize: 10,
    budgets: { restart: true },
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.materialized, 1);
  assert.equal(db.getAtPath(`notification_jobs/${eligibleId}/retentionDueAtMs`), NOW_MS);
});

test('a 100k-attempt history keeps migration reads at page plus one', async () => {
  const attempts = {};
  for (let index = 0; index < 100_000; index += 1) {
    const attemptId = `historical_${index.toString().padStart(6, '0')}`;
    attempts[attemptId] = {
      schemaVersion: 1, attemptId, jobId: jobId('b'), status: 'retrying',
      createdAtMs: NOW_MS - 200_000 + index,
      updatedAtMs: NOW_MS - 100_000 + index,
    };
  }
  const db = createNotificationRetentionMemoryDb({ notification_delivery_attempts: attempts });
  const result = await runNotificationRetentionPreflight({
    db, nowMs: NOW_MS, pageSize: 25, budgets: { orphanPageSize: 25 },
  });
  assert.equal(result.attemptsScanned, 25);
  assert.equal(result.attemptNonTerminalExcluded, 25);
  assert.equal(result.attemptMigrationComplete, false);
  assert.ok(result.maxRecordsInMemory <= 26);
  const attemptQuery = db.queryLog.find((entry) => entry.pathName === 'notification_delivery_attempts'
    && entry.query.orderBy?.field === 'updatedAtMs');
  assert.equal(attemptQuery.returned, 26);
});

test('forward rollout transitions require matching completed preparation evidence', async () => {
  const db = createPausedPreparationDb({});
  const blocked = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'paused',
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
    ...compiledRetentionProtocol(),
  });
  await writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  const shadow = await transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'paused',
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
    ...compiledRetentionProtocol(),
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
    ...compiledRetentionProtocol(),
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
    ...compiledRetentionProtocol(),
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
        ...compiledRetentionProtocol(),
        expectedEngineProtocolId: compiledRetentionProtocol().retentionEngineProtocolId,
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
          ...compiledRetentionProtocol(),
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
  await writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
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
  assert.equal(result.rollout.phase, 'paused');
  assert.equal(result.rollout.revision, 3);
});
