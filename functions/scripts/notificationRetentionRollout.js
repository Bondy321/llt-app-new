#!/usr/bin/env node
'use strict';

const {
  formatOperationalError, readArg, requireExactProject, runMain, sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const PHASES = new Set(['legacy', 'paused', 'shadow', 'compactor']);

const parseExpectedRevision = (argv) => {
  const value = readArg(argv, 'expected-revision');
  return value === null || value === undefined || value === '' ? null : Number(value);
};

const parseArgs = (argv = []) => ({
  action: argv.find((arg) => !arg.startsWith('--')) || 'status',
  apply: argv.includes('--apply'),
  confirmProject: readArg(argv, 'confirm-project'),
  expectedPhase: readArg(argv, 'expected-phase'),
  expectedRevision: parseExpectedRevision(argv),
  nextPhase: readArg(argv, 'phase'),
  actor: readArg(argv, 'actor') || 'retention-operations-cli',
  evidenceDigest: readArg(argv, 'evidence-digest') || null,
  preparationComplete: argv.includes('--preparation-complete'),
  activateAfterCanary: argv.includes('--activate-after-canary'),
});

const validateTransitionOptions = (options) => {
  if (!options.apply) throw new Error('Rollout mutation requires --apply');
  if (!PHASES.has(options.expectedPhase) || !PHASES.has(options.nextPhase)) {
    throw new Error('Rollout mutation requires valid --expected-phase and --phase');
  }
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw new Error('Rollout mutation requires --expected-revision=<non-negative-integer>');
  }
  const forward = !['legacy', 'paused'].includes(options.nextPhase)
    && !(options.expectedPhase === 'compactor' && options.nextPhase === 'shadow')
    && options.nextPhase !== options.expectedPhase;
  if (forward && (!options.preparationComplete || !options.evidenceDigest)) {
    throw new Error('Forward rollout mutation requires --preparation-complete and --evidence-digest');
  }
  const activatesPausedCompactor = options.expectedPhase === 'compactor'
    && options.nextPhase === 'compactor';
  if (activatesPausedCompactor && (!options.activateAfterCanary || !options.evidenceDigest)) {
    throw new Error('Compactor activation requires --activate-after-canary and --evidence-digest');
  }
};

const run = async ({ admin, options, retention = require('../src/domains/notification-retention/public'), nowMs = Date.now() }) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  const db = admin.database();
  if (options.action === 'status') {
    const rollout = await retention.readNotificationRetentionRollout({ db });
    const heartbeat = await retention.readRetentionDeploymentHeartbeat({ db });
    const heartbeatStatus = retention.classifyRetentionHeartbeat({ heartbeat, nowMs });
    const attestation = await retention.readRetentionDeploymentProof({ db });
    const attestationStatus = retention.classifyRetentionDeploymentProof({
      attestation, heartbeat, nowMs,
    });
    return sanitizeOperationalOutput({
      mode: 'read-only', projectId, rollout,
      compiledProtocol: retention.compiledRetentionProtocol(),
      heartbeat: heartbeatStatus.valid ? heartbeat : null,
      heartbeatStatus: heartbeatStatus.reason,
      deploymentProof: attestationStatus.valid ? attestation : null,
      deploymentProofStatus: attestationStatus.reason,
    });
  }
  if (options.action !== 'set') throw new Error('Expected rollout action: status or set');
  validateTransitionOptions(options);
  const result = await retention.transitionNotificationRetentionRollout({
    db,
    expectedPhase: options.expectedPhase,
    expectedRevision: options.expectedRevision,
    nextPhase: options.nextPhase,
    actor: options.actor,
    nowMs,
    preparationComplete: options.preparationComplete,
    evidenceDigest: options.evidenceDigest,
  });
  return sanitizeOperationalOutput({ mode: 'apply', projectId, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { PHASES, parseArgs, run, validateTransitionOptions };
