'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');

const hashCanonical = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeTextArtifact = (value) => Buffer.isBuffer(value)
  ? value.toString('utf8').replaceAll('\r\n', '\n')
  : String(value).replaceAll('\r\n', '\n');
const hashTextArtifact = (value) => createHash('sha256')
  .update(normalizeTextArtifact(value)).digest('hex');

const RETENTION_ENGINE_SOURCE_PATHS = Object.freeze([
  'attentionTransition.js',
  'canaryFixture.js',
  'constants.js',
  'deploymentAttestation.js',
  'eligibility.js',
  'engine.js',
  'preparation.js',
  'preparationPages.js',
  'protocol.js',
  'public.js',
  'requeueRecovery.js',
  'retentionAuxiliarySweeps.js',
  'retentionContext.js',
  'retentionDueQueue.js',
  'retentionEngineRuntime.js',
  'retentionFenceRecovery.js',
  'retentionJobPhases.js',
  'retentionOwnership.js',
  'retentionRequeueSweep.js',
  'retentionScheduling.js',
  'shadow.js',
  'state.js',
  '../notifications/notificationAdminFunctions.js',
  '../notifications/notificationLegacyFence.js',
  '../notifications/notificationReceipts.js',
  '../notifications/notificationRetentionIntegration.js',
  '../../../scripts/notificationRetentionDeploymentAttestation.js',
]);

// This manifest is the review boundary for every safety-critical retention
// deployment. A change to its engine, rules, or trigger contract produces a
// different immutable protocol ID and cannot reuse evidence or heartbeats.
const RETENTION_ENGINE_PROTOCOL_MANIFEST = Object.freeze({
  schemaVersion: 1,
  engine: Object.freeze({
    revision: 'notification-retention-recovery-v2',
    closure: RETENTION_ENGINE_SOURCE_PATHS,
  }),
  rules: Object.freeze({
    revision: 'notification-retention-private-indexes-v2',
    artifactDigest: 'fb69d3e1af155b201250e34244993b5ffa2aef461636f4954c0d27bb6a7b0598',
    semanticArtifactDigest: '832300490d2ec09cc6276375be807fb05d197bf16c78bff4ac8122c6afb41703',
    privateRoots: Object.freeze(['notification_retention/v1', 'notification_retention_rollout/v1']),
    indexes: Object.freeze({
      notification_delivery_attempts: Object.freeze(['jobId', 'retentionDueAtMs', 'updatedAtMs']),
      notification_jobs: Object.freeze(['retentionDueAtMs', 'updatedAtMs']),
      notification_retention_jobs: Object.freeze([
        'leaseExpiresAtMs', 'phase', 'retentionDueAtMs', 'status',
      ]),
    }),
  }),
  trigger: Object.freeze({
    functionName: 'cleanupNotificationDeliveryData',
    region: 'europe-west1',
    runtime: 'nodejs22',
    schedule: 'every 15 minutes',
    schedulerCron: '*/15 * * * *',
    schedulerJobName: 'firebase-schedule-cleanupNotificationDeliveryData-europe-west1',
    timeZone: 'Europe/London',
    maxInstances: 1,
    timeoutSeconds: 540,
  }),
});

const hashRetentionEngineSources = ({ readFile = fs.readFileSync } = {}) => hashCanonical(
  RETENTION_ENGINE_SOURCE_PATHS.map((relativePath) => ({
    path: relativePath,
    digest: hashTextArtifact(readFile(path.resolve(__dirname, relativePath))),
  })),
);

const rulesArtifactPath = () => path.resolve(__dirname, '../../../../database.rules.json');

const assertRetentionProtocolArtifacts = ({ readFile = fs.readFileSync } = {}) => {
  const rulesSource = readFile(rulesArtifactPath());
  const actualRulesDigest = hashTextArtifact(rulesSource);
  if (actualRulesDigest !== RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.artifactDigest) {
    throw new Error('RETENTION_RULES_PROTOCOL_ARTIFACT_MISMATCH');
  }
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  };
  const semanticRulesDigest = hashCanonical(sortValue(JSON.parse(rulesSource.toString('utf8'))));
  if (semanticRulesDigest !== RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.semanticArtifactDigest) {
    throw new Error('RETENTION_RULES_PROTOCOL_SEMANTIC_MISMATCH');
  }
  return {
    rulesArtifactDigest: actualRulesDigest,
    rulesSemanticDigest: semanticRulesDigest,
    sourceFileCount: RETENTION_ENGINE_SOURCE_PATHS.length,
  };
};

const RETENTION_ENGINE_SOURCE_DIGEST = hashRetentionEngineSources();
const RETENTION_ENGINE_RULES_DIGEST = RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.artifactDigest;
const RETENTION_ENGINE_TRIGGER_DIGEST = hashCanonical(RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger);
const RETENTION_ENGINE_PROTOCOL_ID = hashCanonical({
  schemaVersion: RETENTION_ENGINE_PROTOCOL_MANIFEST.schemaVersion,
  sourceDigest: RETENTION_ENGINE_SOURCE_DIGEST,
  rulesDigest: RETENTION_ENGINE_RULES_DIGEST,
  triggerDigest: RETENTION_ENGINE_TRIGGER_DIGEST,
});
const RETENTION_HEARTBEAT_TTL_MS = 45 * 60 * 1000;

const compiledRetentionProtocol = () => ({
  retentionEngineProtocolId: RETENTION_ENGINE_PROTOCOL_ID,
  engineSourceDigest: RETENTION_ENGINE_SOURCE_DIGEST,
  engineRulesDigest: RETENTION_ENGINE_RULES_DIGEST,
  engineTriggerDigest: RETENTION_ENGINE_TRIGGER_DIGEST,
});

const protocolEvidenceMatches = (value) => Boolean(value
  && (value.retentionEngineProtocolId || value.expectedEngineProtocolId)
    === RETENTION_ENGINE_PROTOCOL_ID
  && (!value.retentionEngineProtocolId
    || !value.expectedEngineProtocolId
    || value.retentionEngineProtocolId === value.expectedEngineProtocolId)
  && value.engineSourceDigest === RETENTION_ENGINE_SOURCE_DIGEST
  && value.engineRulesDigest === RETENTION_ENGINE_RULES_DIGEST
  && value.engineTriggerDigest === RETENTION_ENGINE_TRIGGER_DIGEST);

const heartbeatPath = (protocolId = RETENTION_ENGINE_PROTOCOL_ID) => (
  `${NOTIFICATION_RETENTION_PATHS.deploymentHeartbeats}/${protocolId}`
);

const writeRetentionDeploymentHeartbeat = async ({ db, nowMs }) => {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('RETENTION_HEARTBEAT_TIME_INVALID');
  let written = null;
  const result = await db.ref(heartbeatPath()).transaction((current) => {
    const sequence = Number.isSafeInteger(current?.sequence) ? current.sequence + 1 : 1;
    written = {
      schemaVersion: 1,
      ...compiledRetentionProtocol(),
      functionName: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.functionName,
      region: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.region,
      sequence,
      observedAtMs: nowMs,
      expiresAtMs: nowMs + RETENTION_HEARTBEAT_TTL_MS,
    };
    return written;
  }, undefined, false);
  if (!result?.committed || !written) throw new Error('RETENTION_HEARTBEAT_WRITE_FAILED');
  return written;
};

const readRetentionDeploymentHeartbeat = async ({ db }) => (
  (await db.ref(heartbeatPath()).once('value')).val()
);

const classifyRetentionHeartbeat = ({ heartbeat, nowMs }) => {
  if (!heartbeat) return { valid: false, reason: 'heartbeat_missing' };
  if (!protocolEvidenceMatches(heartbeat)) return { valid: false, reason: 'protocol_mismatch' };
  if (heartbeat.functionName !== RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.functionName
    || heartbeat.region !== RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.region) {
    return { valid: false, reason: 'deployment_mismatch' };
  }
  if (!Number.isSafeInteger(heartbeat.observedAtMs)
    || !Number.isSafeInteger(heartbeat.expiresAtMs)
    || heartbeat.observedAtMs > nowMs
    || heartbeat.expiresAtMs < nowMs
    || heartbeat.expiresAtMs - heartbeat.observedAtMs !== RETENTION_HEARTBEAT_TTL_MS) {
    return { valid: false, reason: 'heartbeat_expired' };
  }
  return { valid: true, reason: 'authorized', heartbeat };
};

module.exports = {
  RETENTION_ENGINE_PROTOCOL_ID,
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  RETENTION_ENGINE_SOURCE_PATHS,
  RETENTION_ENGINE_RULES_DIGEST,
  RETENTION_ENGINE_SOURCE_DIGEST,
  RETENTION_ENGINE_TRIGGER_DIGEST,
  RETENTION_HEARTBEAT_TTL_MS,
  assertRetentionProtocolArtifacts,
  classifyRetentionHeartbeat,
  compiledRetentionProtocol,
  heartbeatPath,
  hashRetentionEngineSources,
  protocolEvidenceMatches,
  readRetentionDeploymentHeartbeat,
  writeRetentionDeploymentHeartbeat,
};
