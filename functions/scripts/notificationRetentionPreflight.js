#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  formatOperationalError, readArg, readPositiveInteger, requireExactProject, runMain,
  sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

const parseArgs = (argv = []) => ({
  confirmProject: readArg(argv, 'confirm-project'),
  expectedPhase: readArg(argv, 'expected-phase') || 'legacy',
  pageSize: readPositiveInteger(argv, 'page-size', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  maxPages: readPositiveInteger(argv, 'max-pages', 2_000, 2_000),
});

const inspectRetentionRules = (rules) => {
  const ruleRoots = rules?.rules || {};
  const privateRoot = (name) => ruleRoots[name]?.['.read'] === false
    && ruleRoots[name]?.['.write'] === false;
  const indexed = (name, field) => Array.isArray(ruleRoots[name]?.['.indexOn'])
    && ruleRoots[name]['.indexOn'].includes(field);
  return {
    retentionJobIndexPresent: indexed('notification_jobs', 'retentionDueAtMs'),
    retentionAttemptIndexPresent: indexed('notification_delivery_attempts', 'retentionDueAtMs'),
    retentionMarketingIndexPresent: indexed('marketing_notification_details', 'retentionDueAtMs'),
    requeueRecoveryIndexPresent: indexed('notification_requeue_jobs', 'recoveryDueAtMs'),
    retentionRootPrivate: privateRoot('notification_retention'),
    retentionStateDueIndexPresent: Array.isArray(
      ruleRoots.notification_retention?.v1?.jobs?.['.indexOn'],
    ) && ruleRoots.notification_retention.v1.jobs['.indexOn'].includes('retentionDueAtMs'),
    rolloutRootPrivate: privateRoot('notification_retention_rollout'),
  };
};

const inspectLocalRetentionSurface = ({ repositoryRoot = path.resolve(__dirname, '../..') } = {}) => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8'));
  const receipts = fs.readFileSync(path.join(repositoryRoot, 'functions/src/domains/notifications/notificationReceipts.js'), 'utf8');
  const publicModule = require('../src/domains/notification-retention/public');
  return {
    cleanupExportPreserved: /cleanupNotificationDeliveryData/u.test(receipts),
    retentionCycleAvailable: typeof publicModule.runNotificationRetentionCycle === 'function',
    ...inspectRetentionRules(rules),
  };
};

const run = async ({ admin, options, retention = require('../src/domains/notification-retention/public'), nowMs = Date.now(), repositoryRoot }) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  if (rollout.phase !== options.expectedPhase) {
    throw new Error(`Retention rollout phase mismatch: expected ${options.expectedPhase}, observed ${rollout.phase}`);
  }
  const local = inspectLocalRetentionSurface({ repositoryRoot });
  if (Object.values(local).some((value) => value !== true)) {
    throw new Error('Local notification retention export/rules preflight failed');
  }
  const result = await retention.runNotificationRetentionPreflightAll({
    db, nowMs, pageSize: options.pageSize, maxPages: options.maxPages,
    rolloutRevision: rollout.revision,
  });
  return sanitizeOperationalOutput({ mode: 'dry-run', projectId, rollout, local, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  inspectLocalRetentionSurface,
  inspectRetentionRules,
  parseArgs,
  run,
};
