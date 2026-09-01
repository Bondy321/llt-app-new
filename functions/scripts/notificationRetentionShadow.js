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
});

const run = async ({
  admin,
  options,
  retention = require('../src/domains/notification-retention/public'),
  legacyCleanup = require('../src/domains/notifications/notificationReceipts')
    .cleanupOldNotificationDeliveryData,
  nowMs = Date.now(),
}) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  if (!options.apply) throw new Error('Shadow cycle requires --apply because legacy cleanup remains authoritative');
  if (options.expectedPhase !== 'shadow') throw new Error('Shadow cycle requires --expected-phase=shadow');
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error('Shadow cycle requires --expected-revision=<positive-integer>');
  }
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  if (rollout.phase !== options.expectedPhase || rollout.revision !== options.expectedRevision) {
    throw new Error('Shadow rollout phase/revision changed; rerun status');
  }
  const result = await retention.runNotificationRetentionCycle({
    db,
    nowMs,
    modeOverride: 'shadow',
    expectedPhase: options.expectedPhase,
    expectedRevision: options.expectedRevision,
    budgets: { maxJobs: options.maxJobs },
    legacyCleanup: (cleanupOptions) => legacyCleanup({
      ...cleanupOptions,
      db: cleanupOptions.db || db,
      nowMs: Number.isSafeInteger(cleanupOptions.nowMs) ? cleanupOptions.nowMs : nowMs,
    }),
  });
  if (result?.budgetExhaustionReason === 'rollout_changed') {
    throw new Error('Shadow rollout phase/revision changed during execution; rerun status');
  }
  return sanitizeOperationalOutput({ mode: 'shadow', projectId, rollout, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
