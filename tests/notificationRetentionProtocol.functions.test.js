'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const retention = require('../functions/src/domains/notification-retention/public');
const {
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  RETENTION_ENGINE_SOURCE_PATHS,
  RETENTION_HEARTBEAT_TTL_MS,
  assertRetentionProtocolArtifacts,
  heartbeatPath,
  hashRetentionEngineSources,
  writeRetentionDeploymentHeartbeat,
} = require('../functions/src/domains/notification-retention/protocol');
const { shadowEvidenceStillMatches } = require(
  '../functions/src/domains/notification-retention/state',
);
const {
  createNotificationRetentionMemoryDb,
  setAtPath,
} = require('./helpers/notificationRetentionMemoryDb');

const NOW_MS = 1_800_000_000_000;
const PROTOCOL = retention.compiledRetentionProtocol();
const ENGINE_ROOT = path.resolve(__dirname, '../functions/src/domains/notification-retention');

test('protocol source digest is bound to bytes from every declared engine artifact', () => {
  const changedPath = path.resolve(ENGINE_ROOT, RETENTION_ENGINE_SOURCE_PATHS[0]);
  const changed = hashRetentionEngineSources({
    readFile: (filePath) => {
      const value = fs.readFileSync(filePath);
      return path.resolve(filePath) === changedPath ? Buffer.concat([value, Buffer.from('\nchanged')]) : value;
    },
  });
  assert.notEqual(changed, PROTOCOL.engineSourceDigest);
  assert.ok(RETENTION_ENGINE_SOURCE_PATHS.length >= 20);
});

test('declared rules digest matches the deployable rules artifact', () => {
  const result = assertRetentionProtocolArtifacts();
  assert.equal(result.rulesArtifactDigest, PROTOCOL.engineRulesDigest);
  assert.equal(
    RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.artifactDigest,
    PROTOCOL.engineRulesDigest,
  );
});

const shadowEvidence = () => {
  const value = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision: 8,
    status: 'passed',
    shadowEligible: 0,
    shadowLegacyEligible: 0,
    shadowMismatches: 0,
    compactorScanned: 0,
    legacyScanned: 0,
    progressRevision: 1,
    evaluationNowMs: NOW_MS,
    hasMore: false,
    ...PROTOCOL,
  };
  return { ...value, evidenceFingerprint: retention.buildShadowEvidenceFingerprint(value) };
};

const canaryEvidence = () => {
  const shadow = shadowEvidence();
  const value = {
    schemaVersion: 1,
    phase: 'canary',
    rolloutRevision: 9,
    status: 'passed',
    evidenceDigest: 'protocol-evidence',
    shadowEvidenceFingerprint: shadow.evidenceFingerprint,
    jobsDiscovered: 1,
    jobsClaimed: 1,
    jobsCompleted: 1,
    attemptsDeleted: 1,
    failures: 0,
    fixtureFingerprint: 'c'.repeat(64),
    fixtureCompleted: true,
    ...PROTOCOL,
  };
  return { ...value, evidenceFingerprint: retention.buildCanaryEvidenceFingerprint(value) };
};

const activeRollout = (overrides = {}) => ({
  schemaVersion: 1,
  phase: 'compactor',
  revision: 10,
  preparationComplete: true,
  preparationRolloutRevision: 7,
  evidenceDigest: 'protocol-evidence',
  shadowEvidenceFingerprint: shadowEvidence().evidenceFingerprint,
  shadowEvidenceRevision: 8,
  canaryPassed: true,
  canaryEvidenceFingerprint: canaryEvidence().evidenceFingerprint,
  canaryEvidenceRevision: 9,
  updatedAtMs: NOW_MS - 1,
  ...PROTOCOL,
  expectedEngineProtocolId: PROTOCOL.retentionEngineProtocolId,
  ...overrides,
});

const freshHeartbeat = (overrides = {}) => ({
  schemaVersion: 1,
  ...PROTOCOL,
  functionName: 'cleanupNotificationDeliveryData',
  region: 'europe-west1',
  sequence: 4,
  observedAtMs: NOW_MS - 1,
  expiresAtMs: NOW_MS - 1 + RETENTION_HEARTBEAT_TTL_MS,
  ...overrides,
});

const protocolDb = ({
  rollout = activeRollout(), heartbeat = freshHeartbeat(), attestation = 'auto',
} = {}) => (
  createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout },
    notification_retention: { v1: {
      deployment_heartbeats: heartbeat === null ? {} : {
        [PROTOCOL.retentionEngineProtocolId]: heartbeat,
      },
      evidence: { shadow: shadowEvidence(), canary: canaryEvidence() },
      ...(attestation === 'auto' ? {} : {
        deployment_attestations: attestation === null ? {} : {
          [PROTOCOL.retentionEngineProtocolId]: attestation,
        },
      }),
    } },
  })
);

const deployedArtifacts = (overrides = {}) => {
  const trigger = RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger;
  const projectId = 'retention-test-project';
  return {
    projectId,
    rules: fs.readFileSync(path.resolve(__dirname, '../database.rules.json'), 'utf8'),
    functionConfig: {
      name: `projects/${projectId}/locations/${trigger.region}/functions/${trigger.functionName}`,
      state: 'ACTIVE',
      environment: 'GEN_2',
      buildConfig: { runtime: trigger.runtime },
      serviceConfig: {
        timeoutSeconds: `${trigger.timeoutSeconds}s`,
        maxInstanceCount: trigger.maxInstances,
        allTrafficOnLatestRevision: true,
        uri: `https://${trigger.functionName}.example.test`,
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
    schedulerConfig: {
      name: `projects/${projectId}/locations/${trigger.region}/jobs/${trigger.schedulerJobName}`,
      state: 'PAUSED',
      schedule: trigger.schedule,
      timeZone: trigger.timeZone,
      httpTarget: {
        uri: `https://${trigger.functionName}.example.test`,
        oidcToken: {
          audience: `https://${trigger.functionName}.example.test`,
          serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
        },
      },
    },
    heartbeat: freshHeartbeat(),
    nowMs: NOW_MS,
    ...overrides,
  };
};

test('production attestation requires exact deployed rules, Function and scheduler artifacts', () => {
  const valid = retention.buildRetentionDeploymentProof(deployedArtifacts());
  assert.equal(valid.valid, true);
  for (const [reason, overrides] of [
    ['deployed_rules_mismatch', { rules: { rules: {} } }],
    ['deployed_function_mismatch', {
      functionConfig: { ...deployedArtifacts().functionConfig, state: 'FAILED' },
    }],
    ['deployed_scheduler_mismatch', {
      schedulerConfig: { ...deployedArtifacts().schedulerConfig, schedule: '*/30 * * * *' },
    }],
    ['deployed_scheduler_mismatch', {
      schedulerConfig: {
        ...deployedArtifacts().schedulerConfig,
        schedule: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.schedulerCron,
      },
    }],
    ['deployed_scheduler_mismatch', {
      schedulerConfig: {
        ...deployedArtifacts().schedulerConfig,
        httpTarget: {
          ...deployedArtifacts().schedulerConfig.httpTarget,
          uri: 'https://wrong.example.test/cleanupNotificationDeliveryData',
          oidcToken: {
            ...deployedArtifacts().schedulerConfig.httpTarget.oidcToken,
            audience: 'https://wrong.example.test/cleanupNotificationDeliveryData',
          },
        },
      },
    }],
    ['deployed_scheduler_mismatch', {
      schedulerConfig: {
        ...deployedArtifacts().schedulerConfig,
        httpTarget: {
          ...deployedArtifacts().schedulerConfig.httpTarget,
          oidcToken: {
            ...deployedArtifacts().schedulerConfig.httpTarget.oidcToken,
            serviceAccountEmail: 'wrong@example.test',
          },
        },
      },
    }],
  ]) {
    const candidate = retention.buildRetentionDeploymentProof(
      deployedArtifacts(overrides),
    );
    assert.equal(candidate.valid, false);
    assert.equal(candidate.reason, reason);
  }
});

test('an exact heartbeat without a deployment attestation cannot run compactor', async () => {
  const db = protocolDb({ attestation: null });
  const result = await retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS });
  assert.equal(result.mode, 'paused');
  assert.equal(result.budgetExhaustionReason, 'deployment_attestation_missing');
  assert.equal(db.getAtPath('notification_retention_rollout/v1/phase'), 'paused');
});

test('an expired deployment attestation pauses active compactor execution', async () => {
  const candidate = retention.buildRetentionDeploymentProof(deployedArtifacts());
  assert.equal(candidate.valid, true);
  const laterNowMs = candidate.attestation.expiresAtMs + 1;
  const db = protocolDb({
    attestation: candidate.attestation,
    heartbeat: freshHeartbeat({
      sequence: 5,
      observedAtMs: laterNowMs - 1,
      expiresAtMs: laterNowMs - 1 + RETENTION_HEARTBEAT_TTL_MS,
    }),
  });
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs: laterNowMs,
  });
  assert.equal(result.mode, 'paused');
  assert.equal(result.budgetExhaustionReason, 'deployment_attestation_expired');
  assert.equal(db.getAtPath('notification_retention_rollout/v1/phase'), 'paused');
});

test('missing or expired deployed heartbeat compare-safely pauses destructive rollout', async () => {
  for (const heartbeat of [null, freshHeartbeat({ expiresAtMs: NOW_MS - 1 })]) {
    const db = protocolDb({ heartbeat });
    const result = await retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS });
    assert.equal(result.mode, 'paused');
    assert.match(result.budgetExhaustionReason, /^heartbeat_(missing|expired)$/u);
    const rollout = db.getAtPath('notification_retention_rollout/v1');
    assert.equal(rollout.phase, 'paused');
    assert.equal(rollout.revision, 11);
    assert.equal(rollout.preparationComplete, false);
  }
});

test('source or rules protocol mismatch cannot authorize compactor', async () => {
  for (const mismatch of [
    { engineSourceDigest: '0'.repeat(64) },
    { engineRulesDigest: '1'.repeat(64) },
  ]) {
    const db = protocolDb({ rollout: activeRollout(mismatch) });
    const result = await retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS });
    assert.equal(result.mode, 'paused');
    assert.equal(result.budgetExhaustionReason, 'protocol_mismatch');
    assert.equal(db.getAtPath('notification_retention_rollout/v1').phase, 'paused');
  }
});

test('evidence copied from another protocol is rejected even when its fingerprint is self-consistent', () => {
  const copied = {
    ...shadowEvidence(),
    engineSourceDigest: '2'.repeat(64),
  };
  copied.evidenceFingerprint = retention.buildShadowEvidenceFingerprint(copied);
  assert.equal(
    shadowEvidenceStillMatches(copied, copied.rolloutRevision, copied.evidenceFingerprint),
    false,
  );
});

test('a concurrent rollout change prevents automatic pause from overwriting newer state', async () => {
  let raced = false;
  const rollout = activeRollout({ engineRulesDigest: '3'.repeat(64) });
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: rollout },
    notification_retention: { v1: { deployment_heartbeats: {
      [PROTOCOL.retentionEngineProtocolId]: freshHeartbeat(),
    } } },
  }, {
    beforeTransaction: ({ data, pathName }) => {
      if (raced || pathName !== 'notification_retention_rollout/v1') return;
      raced = true;
      setAtPath(data, pathName, {
        schemaVersion: 1, phase: 'paused', revision: 99,
        preparationComplete: false, updatedAtMs: NOW_MS,
        ...PROTOCOL,
        expectedEngineProtocolId: PROTOCOL.retentionEngineProtocolId,
      });
    },
  });
  const result = await retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS });
  assert.equal(result.mode, 'guard_rejected');
  assert.equal(db.getAtPath('notification_retention_rollout/v1').revision, 99);
  assert.equal(db.getAtPath('notification_retention_rollout/v1').phase, 'paused');
});

test('paused protocol refresh survives an RTDB null-first transaction callback', async () => {
  const staleProtocol = {
    retentionEngineProtocolId: '0'.repeat(64),
    engineSourceDigest: '1'.repeat(64),
    engineRulesDigest: PROTOCOL.engineRulesDigest,
    engineTriggerDigest: PROTOCOL.engineTriggerDigest,
  };
  let rawRollout = {
    schemaVersion: 1,
    phase: 'paused',
    revision: 1,
    preparationComplete: false,
    updatedAtMs: NOW_MS - 1,
    ...staleProtocol,
    expectedEngineProtocolId: staleProtocol.retentionEngineProtocolId,
  };
  let initialProposal;
  const db = {
    ref: (pathName) => {
      assert.equal(pathName, 'notification_retention_rollout/v1');
      return {
        once: async () => ({ val: () => JSON.parse(JSON.stringify(rawRollout)) }),
        transaction: async (updater) => {
          initialProposal = updater(null);
          const next = updater(JSON.parse(JSON.stringify(rawRollout)));
          assert.notEqual(next, undefined);
          rawRollout = next;
          return { committed: true, snapshot: { val: () => next } };
        },
      };
    },
  };

  const result = await retention.transitionNotificationRetentionRollout({
    db,
    expectedPhase: 'paused',
    expectedRevision: 1,
    nextPhase: 'paused',
    actor: 'test-operator',
    nowMs: NOW_MS,
  });

  assert.equal(initialProposal, null);
  assert.equal(result.transitioned, true);
  assert.equal(result.rollout.phase, 'paused');
  assert.equal(result.rollout.revision, 2);
  assert.equal(result.rollout.protocolValid, true);
  assert.equal(result.rollout.retentionEngineProtocolId, PROTOCOL.retentionEngineProtocolId);
});

test('fresh exact deployment heartbeat permits the normal protocol-bound paused-canary gate', async () => {
  const db = protocolDb({ rollout: activeRollout({ canaryPassed: false,
    canaryEvidenceFingerprint: null, canaryEvidenceRevision: null }) });
  const result = await retention.runNotificationRetentionCycle({ db, nowMs: NOW_MS });
  assert.equal(result.mode, 'canary_paused');
  assert.equal(result.budgetExhaustionReason, 'canary_required');
  assert.equal(db.getAtPath('notification_retention_rollout/v1').phase, 'compactor');
});

test('true paused phase performs no scheduling, legacy cleanup or deletion', async () => {
  let legacyCalled = false;
  const paused = {
    schemaVersion: 1,
    phase: 'paused',
    revision: 3,
    preparationComplete: false,
    updatedAtMs: NOW_MS - 1,
    ...PROTOCOL,
    expectedEngineProtocolId: PROTOCOL.retentionEngineProtocolId,
  };
  const db = createNotificationRetentionMemoryDb({
    notification_retention_rollout: { v1: paused },
    notification_retention: { v1: { jobs: { private_job: {
      jobId: 'private_job', generation: 1, status: 'queued', phase: 'attempts',
      retentionDueAtMs: NOW_MS, queueKey: 'private_queue',
    } }, queue: { private_queue: {
      jobId: 'private_job', generation: 1, dueAtMs: NOW_MS,
    } } } },
    notification_jobs: { private_job: {
      jobId: 'private_job', status: 'provider_accepted', completedAtMs: NOW_MS - 1,
      retentionDueAtMs: NOW_MS,
    } },
    notification_delivery_attempts: { private_attempt: {
      attemptId: 'private_attempt', jobId: 'private_job', status: 'provider_accepted',
    } },
  });
  const before = JSON.stringify(db.data);
  const result = await retention.runNotificationRetentionCycle({
    db, nowMs: NOW_MS, legacyCleanup: async () => { legacyCalled = true; },
  });
  assert.equal(result.mode, 'paused');
  assert.equal(result.metrics.attemptsDeleted, 0);
  assert.equal(result.metrics.jobsClaimed, 0);
  assert.equal(legacyCalled, false);
  assert.equal(JSON.stringify(db.data), before);
});

test('server heartbeat is protocol-specific and an older engine path cannot overwrite it', async () => {
  const db = protocolDb({ heartbeat: null, rollout: { schemaVersion: 1, phase: 'paused', revision: 1,
    preparationComplete: false, updatedAtMs: NOW_MS - 1, ...PROTOCOL,
    expectedEngineProtocolId: PROTOCOL.retentionEngineProtocolId } });
  const oldProtocolId = 'f'.repeat(64);
  await db.ref(`notification_retention/v1/deployment_heartbeats/${oldProtocolId}`).set({
    retentionEngineProtocolId: oldProtocolId, sequence: 99,
  });
  const written = await writeRetentionDeploymentHeartbeat({ db, nowMs: NOW_MS });
  assert.equal(written.retentionEngineProtocolId, PROTOCOL.retentionEngineProtocolId);
  assert.equal(db.getAtPath(heartbeatPath()).sequence, 1);
  assert.equal(db.getAtPath(
    `notification_retention/v1/deployment_heartbeats/${oldProtocolId}`,
  ).sequence, 99);
});
