'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
  terminalizeOperationJob,
} = require('../functions/lib/operationsTerminalWarnings');

const snapshot = (value) => ({ val: () => value ?? null, exists: () => value !== null && value !== undefined });

const createDb = (initial = {}, { failWarningWrite = false } = {}) => {
  const state = { ...initial };
  return {
    state,
    ref(path) {
      return {
        async transaction(updater) {
          if (failWarningWrite && path.startsWith('operations_terminal_warnings/v1/')) {
            throw new Error('warning unavailable');
          }
          const next = updater(state[path] ?? null);
          if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) };
          if (next === null) delete state[path];
          else state[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
};

test('terminal warning is deterministic, bounded and contains hashes instead of identifiers', () => {
  const input = {
    jobType: 'passenger_role_claim',
    reason: 'AUTH/RETRY with unsafe detail',
    identifiers: { authUid: 'raw-auth-uid', appSessionId: 'raw-session-id' },
    attemptCount: 4,
    firstAttemptAtMs: 10,
    lastAttemptAtMs: 20,
    expiresAtMs: 30,
    nowMs: 40,
  };
  const first = buildOperationsTerminalWarning(input);
  const second = buildOperationsTerminalWarning({ ...input, nowMs: 50 });
  assert.equal(first.warningId, second.warningId);
  assert.match(first.warningId, /^warning_v1_[a-f0-9]{32}$/);
  assert.equal(first.reason, 'auth_retry_with_unsafe_detail');
  assert.equal(first.status, 'open');
  assert.equal(first.acknowledged, false);
  assert.equal(first.acknowledgedAtMs, null);
  assert.equal(first.acknowledgedByHash, null);
  assert.equal(first.resolved, false);
  assert.equal(first.resolvedAtMs, null);
  assert.equal(first.resolvedByHash, null);
  assert.ok(first.retainUntilMs > first.createdAtMs);
  assert.equal(JSON.stringify(first).includes('raw-auth-uid'), false);
  assert.equal(JSON.stringify(first).includes('raw-session-id'), false);
});

test('idempotent warning persistence preserves acknowledgement and resolution metadata', async () => {
  const db = createDb();
  const warning = buildOperationsTerminalWarning({
    jobType: 'driver_policy_cleanup', reason: 'retention_expired', identifiers: { authUid: 'uid-a' },
    attemptCount: 2, firstAttemptAtMs: 10, lastAttemptAtMs: 20, expiresAtMs: 30, nowMs: 40,
  });
  const first = await persistOperationsTerminalWarning({ db, warning });
  db.state[first.path] = {
    ...db.state[first.path],
    status: 'acknowledged',
    acknowledged: true,
    acknowledgedAtMs: 45,
    acknowledgedByHash: 'a'.repeat(24),
    resolvedAtMs: 46,
    resolvedByHash: 'b'.repeat(24),
  };
  const retry = await persistOperationsTerminalWarning({
    db,
    warning: { ...warning, attemptCount: 5, lastAttemptAtMs: 50, updatedAtMs: 50 },
  });
  assert.equal(retry.created, false);
  assert.equal(retry.warning.status, 'acknowledged');
  assert.equal(retry.warning.acknowledgedAtMs, 45);
  assert.equal(retry.warning.acknowledgedByHash, 'a'.repeat(24));
  assert.equal(retry.warning.resolvedAtMs, 46);
  assert.equal(retry.warning.resolvedByHash, 'b'.repeat(24));
  assert.equal(retry.warning.attemptCount, 5);
  assert.equal(retry.warning.lastAttemptAtMs, 50);
});

test('warning persistence reports the final transaction attempt after contention', async () => {
  const warning = buildOperationsTerminalWarning({
    jobType: 'account_deletion', reason: 'storage_unavailable',
    identifiers: { deletionId: 'deletion-a' }, attemptCount: 2,
    firstAttemptAtMs: 10, lastAttemptAtMs: 20, expiresAtMs: 30, nowMs: 40,
  });
  const successor = { ...warning, attemptCount: 3, updatedAtMs: 50 };
  const db = {
    ref() {
      return {
        async transaction(updater) {
          assert.deepEqual(updater(null), warning);
          const merged = updater(successor);
          return { committed: true, snapshot: snapshot(merged) };
        },
      };
    },
  };

  const result = await persistOperationsTerminalWarning({ db, warning });
  assert.equal(result.created, false);
  assert.equal(result.warning.attemptCount, 3);
  assert.equal(result.warning.updatedAtMs, 50);
});

test('source job is deleted only after warning persistence and is retained when warning storage fails', async () => {
  const sourcePath = 'cleanup_jobs/uid-a';
  const job = {
    sessionId: 'session-a', attemptCount: 3, firstAttemptAtMs: 10,
    lastAttemptAtMs: 20, createdAtMs: 1, expiresAtMs: 30,
  };
  const failingDb = createDb({ [sourcePath]: job }, { failWarningWrite: true });
  await assert.rejects(terminalizeOperationJob({
    db: failingDb,
    sourcePath,
    observedJob: job,
    sourceIdentity: { sessionId: 'session-a', expiresAtMs: 30 },
    jobType: 'driver_policy_cleanup',
    reason: 'retention_expired',
    identifiers: { authUid: 'uid-a', appSessionId: 'session-a' },
    nowMs: 40,
  }), /warning unavailable/);
  assert.equal(failingDb.state[sourcePath].sessionId, 'session-a');
  assert.match(failingDb.state[sourcePath].terminalWarningId, /^warning_v1_/);

  const retryDb = createDb({ [sourcePath]: failingDb.state[sourcePath] });
  const result = await terminalizeOperationJob({
    db: retryDb,
    sourcePath,
    observedJob: retryDb.state[sourcePath],
    sourceIdentity: { sessionId: 'session-a', expiresAtMs: 30 },
    jobType: 'driver_policy_cleanup',
    reason: 'retention_expired',
    identifiers: { authUid: 'uid-a', appSessionId: 'session-a' },
    nowMs: 50,
  });
  assert.equal(result.terminalized, true);
  assert.equal(result.sourceDeleted, true);
  assert.equal(retryDb.state[sourcePath], undefined);
});

test('an attempt recorded after terminal claim survives the first delete and is merged on retry', async () => {
  const sourcePath = 'cleanup_jobs/uid-overlap';
  const initialJob = {
    sessionId: 'session-overlap', attemptCount: 3, firstAttemptAtMs: 10,
    lastAttemptAtMs: 20, lastFailureReason: 'third_failure', createdAtMs: 1, expiresAtMs: 30,
  };
  const state = { [sourcePath]: initialJob };
  let injectOverlap = true;
  const db = {
    state,
    ref(path) {
      return {
        async transaction(updater) {
          const current = state[path] ?? null;
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          if (path === sourcePath && injectOverlap && next?.terminalWarningId && !current?.terminalWarningId) {
            injectOverlap = false;
            state[path] = {
              ...next,
              attemptCount: 4,
              lastAttemptAtMs: 25,
              lastFailureReason: 'overlap_failure',
            };
            return { committed: true, snapshot: snapshot(next) };
          }
          if (next === null) delete state[path];
          else state[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
  const input = {
    db,
    sourcePath,
    sourceIdentity: { sessionId: 'session-overlap', expiresAtMs: 30 },
    jobType: 'driver_policy_cleanup',
    reason: 'retention_expired',
    identifiers: { authUid: 'uid-overlap', appSessionId: 'session-overlap' },
  };

  const first = await terminalizeOperationJob({ ...input, observedJob: initialJob, nowMs: 40 });
  assert.equal(first.terminalized, true);
  assert.equal(first.sourceDeleted, false);
  assert.equal(state[sourcePath].attemptCount, 4);
  const warningPath = Object.keys(state).find((path) => path.startsWith('operations_terminal_warnings/v1/'));
  assert.equal(state[warningPath].attemptCount, 3);

  const retry = await terminalizeOperationJob({
    ...input, observedJob: state[sourcePath], nowMs: 50,
  });
  assert.equal(retry.sourceDeleted, true);
  assert.equal(state[sourcePath], undefined);
  assert.equal(state[warningPath].attemptCount, 4);
  assert.equal(state[warningPath].lastAttemptAtMs, 25);
});
