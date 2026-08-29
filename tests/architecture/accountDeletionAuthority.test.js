'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');
const source = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const { sanitizeLogData } = require('../../functions/src/infrastructure/logging/safeLogger');

test('safe logger masks account, session, tour, driver, message and Storage identifiers', () => {
  const sanitized = sanitizeLogData({
    deletionId: 'acctdel-secret', sessionId: 'session-secret', principalId: 'principal-secret',
    driverId: 'driver-secret', tourId: 'tour-secret', messageId: 'message-secret',
    storagePath: 'private/path/secret.jpg', deletionReceipt: 'receipt-secret',
    path: 'sensitive/path', adminUid: 'admin-secret', principalKey: 'principal-key-secret',
    eventId: 'event-secret', jobId: 'job-secret', runId: 'run-secret',
  });
  Object.values(sanitized).forEach((value) => assert.match(String(value), /\*\*\*/u));
  assert.equal(sanitizeLogData({ error: { message: 'booking BOOK_SECRET failed' } }).error, '[redacted-error]');
});

test('mobile account deletion is a thin receipt API with no remote deletion authority', () => {
  const mobile = source('services/accountDeletionService.js');
  [
    /firebase\/database/u,
    /realtimeDb/u,
    /deleteUser/u,
    /deleteCurrentUser/u,
    /photoService/u,
    /notificationService/u,
    /endAppSession/u,
    /passenger_identity_security/u,
    /identity_bindings/u,
    /group_tour_photos/u,
    /private_tour_photos/u,
  ].forEach((forbidden) => assert.doesNotMatch(mobile, forbidden));
  assert.match(mobile, /expectedSessionId/u);
  assert.match(mobile, /deletionReceipt/u);
  assert.match(mobile, /requestAccountDeletion/u);
  assert.match(mobile, /getAccountDeletionStatus/u);
  assert.match(mobile, /retryAccountDeletion/u);
});

test('all passenger and driver login and issuance entry points enforce the durable deletion barrier', () => {
  const boundaries = [
    [['functions/src/domains/passenger-auth/passengerLoginFunction.js',
      'functions/src/domains/passenger-auth/passengerLoginWorkflow.js'], 1, true],
    [['functions/src/domains/driver-auth/driverLoginFunction.js'], 1, true],
    [['functions/src/domains/app-sessions/sessionIssuance.js'], 2, false],
  ];
  boundaries.forEach(([relativePaths, expectedCallCount, projectsReason]) => {
    const contents = relativePaths.map(source).join('\n');
    const label = relativePaths.join(' -> ');
    assert.match(contents, /account-deletion\/public/u, label);
    const calls = contents.match(/ensureNoActiveAccountDeletion\s*\(/gu) || [];
    assert.ok(calls.length >= expectedCallCount, `${label} must guard every issuance path`);
    if (projectsReason) assert.match(contents, /ACCOUNT_DELETION_IN_PROGRESS/u, label);
  });
});

test('durable workflow roots are server-private even to authenticated and admin clients', () => {
  const rules = JSON.parse(source('database.rules.json')).rules;
  [
    'account_deletion_jobs',
    'account_deletion_queue',
    'account_deletion_active',
    'account_deletion_completion_tombstones',
    'account_deletion_locks',
    'account_deletion_passenger_active',
    'account_deletion_passenger_locks',
    'account_deletion_uid_tombstones',
    'account_deletion_rollout',
  ].forEach((rootName) => {
    assert.equal(rules[rootName]['.read'], false, `${rootName} read authority`);
    assert.equal(rules[rootName]['.write'], false, `${rootName} write authority`);
  });
  assert.match(rules.account_deletion_rollout.v1['.validate'], /compatibility/u);
  assert.match(rules.account_deletion_rollout.v1['.validate'], /server_only/u);
  assert.match(rules.account_deletion_rollout.v1['.validate'], /hasChildren/u);
  assert.equal(rules.account_deletion_rollout.v1.$other['.validate'], false);
});

test('server workflow derives trusted scope, reserves atomically, and deletes Auth only in the terminal phase', () => {
  const functionsSource = source('functions/src/domains/account-deletion/accountDeletionFunctions.js');
  const workerSource = source('functions/src/domains/account-deletion/accountDeletionWorker.js');
  const finalizationSource = source('functions/src/domains/account-deletion/accountDeletionFinalization.js');
  const scopeSource = source('functions/src/domains/account-deletion/accountDeletionScope.js');

  assert.match(functionsSource, /deriveTrustedAccountDeletionScope/u);
  assert.match(functionsSource, /buildAppSessionCleanupUpdates/u);
  assert.match(functionsSource, /await db\.ref\(\)\.update\(\{/u);
  assert.match(functionsSource, /ACCOUNT_DELETION_JOB_ROOT/u);
  assert.match(functionsSource, /ACCOUNT_DELETION_QUEUE_ROOT/u);
  assert.match(functionsSource, /ACCOUNT_DELETION_ACTIVE_ROOT/u);
  assert.doesNotMatch(functionsSource, /privateScope:\s*input/u);
  assert.match(scopeSource, /passenger_identity_security/u);
  assert.match(scopeSource, /identity_bindings/u);
  assert.match(scopeSource, /drivers\//u);

  const authDeleteBranch = workerSource.indexOf("job.phase === 'auth_delete'");
  const authDeleteCall = workerSource.indexOf('auth.deleteUser', authDeleteBranch);
  const completionCall = workerSource.indexOf('finalizeCompletedAccountDeletion', authDeleteCall);
  assert.ok(authDeleteBranch > 0 && authDeleteCall > authDeleteBranch && completionCall > authDeleteCall);
  assert.match(finalizationSource, /removeMatchingBarrier\(db\.ref\(`\$\{ACCOUNT_DELETION_ACTIVE_ROOT\}/u);
  assert.match(finalizationSource, /ACCOUNT_DELETION_QUEUE_ROOT[^\n]*transaction/u);
});

test('worker destructive helpers are lease-fenced and media deletion remains exact-owner compare-safe', () => {
  const worker = source('functions/src/domains/account-deletion/accountDeletionWorker.js');
  const coordination = source('functions/src/domains/account-deletion/accountDeletionCoordination.js');
  const effects = source('functions/src/domains/account-deletion/accountDeletionEffects.js');
  const groupMedia = source('functions/src/domains/media/groupMediaFunctions.js');
  const privateMedia = source('functions/src/domains/media/privateMediaFunctions.js');
  assert.match(worker, /assertCurrentJobLease/u);
  assert.match(coordination, /ACCOUNT_DELETION_LEASE_LOST/u);
  assert.match(effects, /assertCanDelete:\s*\(\)\s*=>\s*assertCurrentJobLease/u);
  [groupMedia, privateMedia].forEach((contents) => {
    assert.match(contents, /assertCanDelete/u);
    assert.match(contents, /MEDIA_RECORD_CHANGED/u);
    assert.match(contents, /transaction/u);
    assert.match(contents, /storagePath/u);
    assert.match(contents, /viewerStoragePath/u);
    assert.match(contents, /thumbnailStoragePath/u);
  });
});
