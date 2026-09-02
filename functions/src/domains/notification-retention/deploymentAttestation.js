'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const {
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  classifyRetentionHeartbeat,
  compiledRetentionProtocol,
  protocolEvidenceMatches,
} = require('./protocol');

const RETENTION_DEPLOYMENT_ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
};
const hashCanonical = (value) => createHash('sha256')
  .update(JSON.stringify(sortValue(value))).digest('hex');
const hashRulesSemantics = (rules) => {
  const parsed = Buffer.isBuffer(rules) || typeof rules === 'string'
    ? JSON.parse(rules.toString('utf8')) : rules;
  return hashCanonical(parsed);
};

const expectedDeploymentProjection = () => ({
  rulesSemanticDigest: RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.semanticArtifactDigest,
  function: {
    functionName: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.functionName,
    region: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.region,
    runtime: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.runtime,
    maxInstances: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.maxInstances,
    timeoutSeconds: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.timeoutSeconds,
  },
  scheduler: {
    jobName: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.schedulerJobName,
    schedule: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.schedule,
    timeZone: RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger.timeZone,
  },
});

const RETENTION_DEPLOYMENT_CONFIG_FINGERPRINT = hashCanonical(expectedDeploymentProjection());
const durationSeconds = (value) => {
  if (Number.isSafeInteger(value)) return value;
  const match = String(value || '').match(/^(\d+)s$/u);
  return match ? Number(match[1]) : null;
};

const deployedFunctionMatches = ({ functionConfig, projectId }) => {
  const expected = RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger;
  const expectedName = `projects/${projectId}/locations/${expected.region}/functions/${expected.functionName}`;
  return functionConfig?.name === expectedName
    && functionConfig?.state === 'ACTIVE'
    && functionConfig?.environment === 'GEN_2'
    && functionConfig?.buildConfig?.runtime === expected.runtime
    && durationSeconds(functionConfig?.serviceConfig?.timeoutSeconds) === expected.timeoutSeconds
    && Number(functionConfig?.serviceConfig?.maxInstanceCount) === expected.maxInstances
    && functionConfig?.serviceConfig?.allTrafficOnLatestRevision !== false;
};

const normalizedHttpsUri = (value) => {
  try {
    const uri = new URL(String(value || ''));
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash) return null;
    return uri.toString().replace(/\/$/u, '');
  } catch (_error) {
    return null;
  }
};

// eslint-disable-next-line complexity -- each scheduler identity and OIDC authority field must match exactly.
const deployedSchedulerMatches = ({ schedulerConfig, functionConfig, projectId }) => {
  const expected = RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger;
  const expectedName = `projects/${projectId}/locations/${expected.region}/jobs/${expected.schedulerJobName}`;
  const functionUri = normalizedHttpsUri(functionConfig?.serviceConfig?.uri);
  const schedulerUri = normalizedHttpsUri(schedulerConfig?.httpTarget?.uri);
  const audience = normalizedHttpsUri(
    schedulerConfig?.httpTarget?.oidcToken?.audience || schedulerConfig?.httpTarget?.uri,
  );
  const expectedServiceAccount = functionConfig?.serviceConfig?.serviceAccountEmail;
  return schedulerConfig?.name === expectedName
    && ['ENABLED', 'PAUSED'].includes(schedulerConfig?.state)
    && schedulerConfig?.schedule === expected.schedule
    && schedulerConfig?.timeZone === expected.timeZone
    && Boolean(functionUri)
    && schedulerUri === functionUri
    && audience === functionUri
    && typeof expectedServiceAccount === 'string'
    && expectedServiceAccount.length > 0
    && schedulerConfig?.httpTarget?.oidcToken?.serviceAccountEmail === expectedServiceAccount;
};

const buildAttestationFingerprint = (value) => hashCanonical({
  ...compiledRetentionProtocol(),
  deploymentConfigFingerprint: value?.deploymentConfigFingerprint,
  rulesSemanticDigest: value?.rulesSemanticDigest,
  heartbeatSequence: value?.heartbeatSequence,
  heartbeatObservedAtMs: value?.heartbeatObservedAtMs,
  attestedAtMs: value?.attestedAtMs,
});

const deploymentAttestationPath = (protocolId = compiledRetentionProtocol().retentionEngineProtocolId) => (
  `${NOTIFICATION_RETENTION_PATHS.deploymentAttestations}/${protocolId}`
);

const buildRetentionDeploymentAttestation = ({
  projectId, rules, functionConfig, schedulerConfig, heartbeat, nowMs,
}) => {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { valid: false, reason: 'attestation_time_invalid' };
  }
  const heartbeatStatus = classifyRetentionHeartbeat({ heartbeat, nowMs });
  if (!heartbeatStatus.valid) return { valid: false, reason: heartbeatStatus.reason };
  let rulesSemanticDigest;
  try {
    rulesSemanticDigest = hashRulesSemantics(rules);
  } catch (_error) {
    return { valid: false, reason: 'deployed_rules_invalid' };
  }
  if (rulesSemanticDigest !== RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.semanticArtifactDigest) {
    return { valid: false, reason: 'deployed_rules_mismatch' };
  }
  if (!deployedFunctionMatches({ functionConfig, projectId })) {
    return { valid: false, reason: 'deployed_function_mismatch' };
  }
  if (!deployedSchedulerMatches({ schedulerConfig, functionConfig, projectId })) {
    return { valid: false, reason: 'deployed_scheduler_mismatch' };
  }
  const attestation = {
    schemaVersion: 1,
    ...compiledRetentionProtocol(),
    deploymentConfigFingerprint: RETENTION_DEPLOYMENT_CONFIG_FINGERPRINT,
    rulesSemanticDigest,
    heartbeatSequence: heartbeat.sequence,
    heartbeatObservedAtMs: heartbeat.observedAtMs,
    schedulerState: schedulerConfig.state,
    attestedAtMs: nowMs,
    expiresAtMs: nowMs + RETENTION_DEPLOYMENT_ATTESTATION_TTL_MS,
  };
  return {
    valid: true,
    reason: 'attested',
    attestation: {
      ...attestation,
      attestationFingerprint: buildAttestationFingerprint(attestation),
    },
  };
};

const classifyRetentionDeploymentAttestation = ({ attestation, heartbeat, nowMs }) => {
  if (!attestation) return { valid: false, reason: 'deployment_attestation_missing' };
  if (!protocolEvidenceMatches(attestation)
    || attestation.deploymentConfigFingerprint !== RETENTION_DEPLOYMENT_CONFIG_FINGERPRINT
    || attestation.rulesSemanticDigest
      !== RETENTION_ENGINE_PROTOCOL_MANIFEST.rules.semanticArtifactDigest
    || attestation.attestationFingerprint !== buildAttestationFingerprint(attestation)) {
    return { valid: false, reason: 'deployment_attestation_mismatch' };
  }
  if (!Number.isSafeInteger(attestation.attestedAtMs)
    || !Number.isSafeInteger(attestation.expiresAtMs)
    || attestation.attestedAtMs > nowMs
    || attestation.expiresAtMs < nowMs
    || attestation.expiresAtMs - attestation.attestedAtMs
      !== RETENTION_DEPLOYMENT_ATTESTATION_TTL_MS) {
    return { valid: false, reason: 'deployment_attestation_expired' };
  }
  if (!heartbeat || Number(attestation.heartbeatSequence) > Number(heartbeat.sequence)
    || Number(attestation.heartbeatObservedAtMs) > Number(heartbeat.observedAtMs)) {
    return { valid: false, reason: 'deployment_attestation_heartbeat_mismatch' };
  }
  return { valid: true, reason: 'deployment_attested', attestation };
};

const readRetentionDeploymentAttestation = async ({ db }) => (
  (await db.ref(deploymentAttestationPath()).once('value')).val()
);

const writeRetentionDeploymentAttestation = async ({ db, candidate }) => {
  if (!candidate?.valid || !candidate.attestation) {
    return { written: false, reason: candidate?.reason || 'attestation_invalid' };
  }
  let written = false;
  const result = await db.ref(deploymentAttestationPath()).transaction((current) => {
    if (Number(current?.attestedAtMs || 0) > candidate.attestation.attestedAtMs) return undefined;
    written = true;
    return candidate.attestation;
  }, undefined, false);
  return {
    written: Boolean(written && result?.committed),
    reason: written && result?.committed ? 'attested' : 'attestation_changed',
    attestation: result?.snapshot?.val?.() || null,
  };
};

module.exports = {
  RETENTION_DEPLOYMENT_ATTESTATION_TTL_MS,
  RETENTION_DEPLOYMENT_CONFIG_FINGERPRINT,
  buildRetentionDeploymentAttestation,
  classifyRetentionDeploymentAttestation,
  deployedFunctionMatches,
  deployedSchedulerMatches,
  deploymentAttestationPath,
  hashRulesSemantics,
  readRetentionDeploymentAttestation,
  writeRetentionDeploymentAttestation,
};
