#!/usr/bin/env node
'use strict';

const {
  formatOperationalError, readArg, requireExactProject, runMain, sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const parseRevision = (argv) => {
  const value = Number(readArg(argv, 'expected-revision'));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const parseArgs = (argv = []) => ({
  action: argv.find((arg) => !arg.startsWith('--')) || 'status',
  apply: argv.includes('--apply'),
  confirmProject: readArg(argv, 'confirm-project'),
  expectedPhase: readArg(argv, 'expected-phase'),
  expectedRevision: parseRevision(argv),
});

const fetchJson = async ({ fetchImpl, url, accessToken }) => {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const error = new Error('RETENTION_DEPLOYMENT_PROBE_FAILED');
    error.code = 'RETENTION_DEPLOYMENT_PROBE_FAILED';
    throw error;
  }
  return response.json();
};

const probeProductionDeployment = async ({
  admin, db, projectId, manifest, fetchImpl = globalThis.fetch,
}) => {
  const credential = admin.app().options.credential;
  const tokenResult = await credential?.getAccessToken?.();
  const accessToken = tokenResult?.access_token;
  if (!accessToken || typeof fetchImpl !== 'function') {
    const error = new Error('RETENTION_DEPLOYMENT_CREDENTIAL_UNAVAILABLE');
    error.code = 'RETENTION_DEPLOYMENT_CREDENTIAL_UNAVAILABLE';
    throw error;
  }
  const trigger = manifest.trigger;
  const rulesUrl = new URL(db.ref('/').toString());
  rulesUrl.pathname = '/.settings/rules.json';
  const functionUrl = `https://cloudfunctions.googleapis.com/v2/projects/${projectId}`
    + `/locations/${trigger.region}/functions/${trigger.functionName}`;
  const schedulerUrl = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}`
    + `/locations/${trigger.region}/jobs/${trigger.schedulerJobName}`;
  const [rules, functionConfig, schedulerConfig] = await Promise.all([
    fetchJson({ fetchImpl, url: rulesUrl.toString(), accessToken }),
    fetchJson({ fetchImpl, url: functionUrl, accessToken }),
    fetchJson({ fetchImpl, url: schedulerUrl, accessToken }),
  ]);
  return { rules, functionConfig, schedulerConfig };
};

const validateAttestOptions = (options) => {
  if (!options.apply) throw new Error('Deployment attestation requires --apply');
  if (!['paused', 'compactor'].includes(options.expectedPhase)) {
    throw new Error('Deployment attestation requires --expected-phase=paused|compactor');
  }
  if (options.expectedRevision === null) {
    throw new Error('Deployment attestation requires --expected-revision');
  }
};

const run = async ({
  admin,
  options,
  retention = require('../src/domains/notification-retention/public'),
  nowMs = Date.now(),
  probe = probeProductionDeployment,
}) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  const heartbeat = await retention.readRetentionDeploymentHeartbeat({ db });
  const existing = await retention.readRetentionDeploymentProof({ db });
  if (options.action === 'status') {
    const status = retention.classifyRetentionDeploymentProof({
      attestation: existing, heartbeat, nowMs,
    });
    return sanitizeOperationalOutput({
      mode: 'read-only', projectId, rollout, attestationStatus: status.reason,
      attestation: status.valid ? existing : null,
    });
  }
  if (options.action !== 'attest') throw new Error('Expected attestation action: status or attest');
  validateAttestOptions(options);
  if (rollout.phase !== options.expectedPhase || rollout.revision !== options.expectedRevision) {
    throw new Error('Deployment attestation requires exact rollout state');
  }
  const remote = await probe({
    admin,
    db,
    projectId,
    manifest: retention.RETENTION_ENGINE_PROTOCOL_MANIFEST,
  });
  const latestRollout = await retention.readNotificationRetentionRollout({ db });
  if (latestRollout.phase !== options.expectedPhase
    || latestRollout.revision !== options.expectedRevision) {
    throw new Error('Deployment attestation rollout changed during probe');
  }
  const candidate = retention.buildRetentionDeploymentProof({
    projectId, heartbeat, nowMs, ...remote,
  });
  if (!candidate.valid) return sanitizeOperationalOutput({
    mode: 'apply', projectId, written: false, reason: candidate.reason,
  });
  const result = await retention.writeRetentionDeploymentProof({ db, candidate });
  return sanitizeOperationalOutput({ mode: 'apply', projectId, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  probeProductionDeployment,
  run,
  validateAttestOptions,
};
