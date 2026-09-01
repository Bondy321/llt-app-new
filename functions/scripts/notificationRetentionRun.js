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
  maxJobs: readPositiveInteger(argv, 'max-jobs', 25, 25),
  maxAttemptPagesPerJob: readPositiveInteger(argv, 'max-attempt-pages-per-job', 4, 4),
  maxAttempts: readPositiveInteger(argv, 'max-attempts', 5_000, 5_000),
  maxUpdatePaths: readPositiveInteger(argv, 'max-update-paths', 500, 500),
});

const run = async ({
  admin,
  options,
  retention = require('../src/domains/notification-retention/public'),
  nowMs = Date.now(),
}) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  if (!options.apply) throw new Error('Normal compactor cycle requires --apply');
  if (options.expectedPhase !== 'compactor') {
    throw new Error('Normal compactor cycle requires --expected-phase=compactor');
  }
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error('Normal compactor cycle requires --expected-revision=<positive-integer>');
  }
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  if (rollout.phase !== options.expectedPhase || rollout.revision !== options.expectedRevision) {
    throw new Error('Compactor rollout phase/revision changed; rerun status');
  }
  if (rollout.canaryPassed !== true) {
    throw new Error('Normal compactor cycle requires passing canary evidence');
  }
  const budgets = {
    maxJobs: options.maxJobs,
    maxAttemptPagesPerJob: options.maxAttemptPagesPerJob,
    maxAttemptPages: 20,
    maxAttempts: options.maxAttempts,
    maxUpdatePaths: options.maxUpdatePaths,
  };
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs,
    modeOverride: 'compactor',
    expectedPhase: options.expectedPhase,
    expectedRevision: options.expectedRevision,
    budgets,
  });
  if (result?.budgetExhaustionReason === 'rollout_changed') {
    throw new Error('Compactor rollout phase/revision changed during execution; rerun status');
  }
  return sanitizeOperationalOutput({ mode: 'compactor', projectId, rollout, budgets, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
