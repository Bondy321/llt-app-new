#!/usr/bin/env node
'use strict';

const {
  formatOperationalError, readArg, readPositiveInteger, requireExactProject, runMain,
  sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const readExpectedRevision = (argv) => {
  const value = readArg(argv, 'expected-revision');
  return value === null || value === undefined || value === '' ? null : Number(value);
};

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  restart: argv.includes('--restart'),
  confirmProject: readArg(argv, 'confirm-project'),
  expectedPhase: readArg(argv, 'expected-phase') || 'legacy',
  expectedRevision: readExpectedRevision(argv),
  cursor: readArg(argv, 'cursor') || null,
  pageSize: readPositiveInteger(argv, 'page-size', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
});

const run = async ({ admin, options, retention = require('../src/domains/notification-retention/public'), nowMs = Date.now() }) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  if (options.apply && options.cursor && !options.restart) {
    throw new Error('Refusing apply cursor override without explicit --restart');
  }
  if (options.restart && options.cursor) {
    throw new Error('Retention preparation restart always begins at the canonical initial cursor');
  }
  if (options.apply && (!Number.isSafeInteger(options.expectedRevision)
    || options.expectedRevision < 0)) {
    throw new Error('Retention preparation apply requires --expected-revision=<non-negative-integer>');
  }
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  if (rollout.phase !== options.expectedPhase
    || (options.apply && rollout.phase !== 'paused')
    || (options.apply && rollout.revision !== options.expectedRevision)) {
    throw new Error('Retention preparation apply requires the exact paused rollout phase');
  }
  const result = await retention.runNotificationRetentionPreparation({
    db,
    nowMs,
    apply: options.apply,
    expectedRolloutRevision: options.apply ? options.expectedRevision : rollout.revision,
    pageSize: options.pageSize,
    cursor: options.cursor,
    budgets: { restart: options.restart },
  });
  return sanitizeOperationalOutput({
    mode: options.apply ? 'apply' : 'dry-run', projectId, rollout, ...result,
  });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseArgs, run };
