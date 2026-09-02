#!/usr/bin/env node
'use strict';

const {
  formatOperationalError, readArg, requireExactProject, runMain, sanitizeOperationalOutput,
} = require('./notificationRetentionTooling');

const parseRevision = (argv) => {
  const value = Number(readArg(argv, 'expected-revision'));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const parseGeneration = (argv) => {
  const value = Number(readArg(argv, 'expected-generation'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const parseArgs = (argv = []) => ({
  action: argv.find((arg) => !arg.startsWith('--')) || 'inspect',
  apply: argv.includes('--apply'),
  confirmProject: readArg(argv, 'confirm-project'),
  jobId: readArg(argv, 'job-id'),
  expectedPhase: readArg(argv, 'expected-phase'),
  expectedRevision: parseRevision(argv),
  expectedGeneration: parseGeneration(argv),
  attentionFingerprint: readArg(argv, 'attention-fingerprint'),
});

const requireJobId = (jobId) => {
  if (typeof jobId !== 'string' || !jobId || jobId.length > 128 || /[.#$\[\]/]/u.test(jobId)) {
    throw new Error('Attention operation requires a valid --job-id');
  }
};

const validateMutation = (options) => {
  if (!options.apply) throw new Error('Attention mutation requires --apply');
  if (options.expectedPhase !== 'paused' || options.expectedRevision === null) {
    throw new Error('Attention mutation requires exact paused phase and revision');
  }
  if (options.expectedGeneration === null
    || !/^attention_v1_[a-f0-9]{32}$/u.test(options.attentionFingerprint)) {
    throw new Error('Attention mutation requires exact generation and attention fingerprint');
  }
};

const run = async ({
  admin, options, retention = require('../src/domains/notification-retention/public'), nowMs = Date.now(),
}) => {
  const projectId = requireExactProject({ admin, confirmProject: options.confirmProject });
  requireJobId(options.jobId);
  const db = admin.database();
  const rollout = await retention.readNotificationRetentionRollout({ db });
  const state = (await db.ref(
    `${retention.NOTIFICATION_RETENTION_PATHS.jobs}/${options.jobId}`,
  ).once('value')).val();
  const attention = typeof retention.readEffectiveNotificationRetentionAttention === 'function'
    ? await retention.readEffectiveNotificationRetentionAttention(db, options.jobId, state)
    : (await db.ref(
      `${retention.NOTIFICATION_RETENTION_PATHS.attention}/${options.jobId}`,
    ).once('value')).val() || state?.attention || null;
  if (options.action === 'inspect') {
    return sanitizeOperationalOutput({
      mode: 'read-only', projectId, found: Boolean(attention), rollout,
      attention: attention || null,
      state: state ? {
        generation: state.generation,
        status: state.status,
        phase: state.phase,
        irreversibleWorkStarted: state.irreversibleWorkStarted === true,
        firstDestructiveCommitAtMs: state.firstDestructiveCommitAtMs || null,
        committedDeletionCount: Number(state.committedDeletionCount || 0),
        destructiveCommit: state.destructiveCommit ? {
          phase: state.destructiveCommit.phase,
          generation: state.destructiveCommit.generation,
          startedAtMs: state.destructiveCommit.startedAtMs,
        } : null,
      } : null,
    });
  }
  if (!['retry', 'abandon'].includes(options.action)) {
    throw new Error('Expected attention action: inspect, retry or abandon');
  }
  validateMutation(options);
  if (rollout.phase !== options.expectedPhase || rollout.revision !== options.expectedRevision) {
    throw new Error('Attention rollout phase/revision changed; rerun inspect');
  }
  const expected = {
    generation: options.expectedGeneration,
    attentionFingerprint: options.attentionFingerprint,
  };
  const result = options.action === 'retry'
    ? await retention.retryNotificationRetentionAttention({
      db, jobId: options.jobId, expected, nowMs,
    })
    : await retention.abandonNotificationRetentionAttention({
      db, jobId: options.jobId, expected,
    });
  return sanitizeOperationalOutput({ mode: 'apply', action: options.action, projectId, ...result });
};

if (require.main === module) {
  runMain((admin) => run({ admin, options: parseArgs(process.argv.slice(2)) })).catch((error) => {
    process.stderr.write(`${formatOperationalError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run, validateMutation };
