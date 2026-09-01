#!/usr/bin/env node
'use strict';

const {
  formatOperationalError, readArg, readPositiveInteger, requireExactProject, runMain,
  sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  confirmProject: readArg(argv, 'confirm-project'),
  expectedPhase: readArg(argv, 'expected-phase'),
  expectedRevision: Number(readArg(argv, 'expected-revision')),
  evidenceDigest: readArg(argv, 'evidence-digest') || null,
  maxJobs: readPositiveInteger(argv, 'max-jobs', 1, 2),
  maxAttemptPagesPerJob: readPositiveInteger(argv, 'max-attempt-pages-per-job', 1, 2),
  maxAttempts: readPositiveInteger(argv, 'max-attempts', 100, 500),
  maxUpdatePaths: readPositiveInteger(argv, 'max-update-paths', 500, 500),
});

const run = async ({ admin, options, retention = require('../src/domains/notification-retention/public'), nowMs = Date.now() }) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  if (!options.apply) throw new Error('Retention canary requires --apply');
  if (options.expectedPhase !== 'compactor') {
    throw new Error('Retention canary requires --expected-phase=compactor');
  }
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error('Retention canary requires --expected-revision=<positive-integer>');
  }
  if (!options.evidenceDigest) throw new Error('Retention canary requires --evidence-digest');
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  if (rollout.phase !== options.expectedPhase || Number(rollout.revision) !== options.expectedRevision) {
    throw new Error('Retention canary rollout phase/revision changed; rerun preflight');
  }
  if (rollout.canaryPassed !== false || rollout.evidenceDigest !== options.evidenceDigest) {
    throw new Error('Retention canary requires the exact paused compactor evidence state');
  }
  const fixture = await retention.ensureNotificationRetentionCanaryFixture({ db, rollout, nowMs });
  if (!fixture.ready && !fixture.completed) {
    throw new Error(`Retention canary fixture is not ready: ${fixture.reason || 'unknown'}`);
  }
  const budgets = {
    maxJobs: options.maxJobs,
    maxAttemptPagesPerJob: options.maxAttemptPagesPerJob,
    maxAttemptPages: options.maxJobs * options.maxAttemptPagesPerJob,
    maxAttempts: options.maxAttempts,
    maxUpdatePaths: options.maxUpdatePaths,
    pageSize: Math.min(250, options.maxAttempts),
    orphanPageSize: 1,
    auxiliaryPageSize: 1,
    maxAuxiliaryPages: 1,
  };
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs,
    modeOverride: 'compactor',
    budgets,
    canary: {
      enabled: true,
      expectedPhase: options.expectedPhase,
      expectedRevision: options.expectedRevision,
      evidenceDigest: options.evidenceDigest,
      fixtureFingerprint: fixture.fixtureFingerprint,
      fixtureJobId: fixture.jobId,
    },
  });
  return sanitizeOperationalOutput({ mode: 'canary', projectId, rollout, budgets, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
