'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const repositoryRoot = path.resolve(__dirname, '../..');
const source = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const { sanitizeLogData } = require('../../functions/src/infrastructure/logging/safeLogger');

const assertOrdinaryClientsDenied = (expression, label) => {
  const absent = { child() { return this; }, val: () => null, exists: () => false,
    hasChildren: () => false, hasChild: () => false };
  const root = { ...absent, child: value => value.startsWith('admin_users/')
    ? { ...absent, val: () => true, exists: () => true } : absent };
  const identities = [null, ...['ordinary', 'listed-admin', '9CWQ4705gVRkfW5Xki5LyvrmVp23'].map(uid => ({ uid,
    token: { admin: true, firebase: { sign_in_second_factor: 'totp' },
      lltSessionIssuer: true, lltNotificationIssuer: true, lltMediaPublisher: true, lltTourPublisher: true } }))];
  for (const auth of identities) {
    assert.equal(runInNewContext(String(expression), { auth, root, data: absent, newData: absent, now: Date.now() }),
      false, `${label}: ordinary clients cannot manufacture top-level server issuer authority`);
  }
};

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
    assertOrdinaryClientsDenied(rules[rootName]['.read'], `${rootName} read authority`);
    assertOrdinaryClientsDenied(rules[rootName]['.write'], `${rootName} write authority`);
  });
  assert.doesNotMatch(rules.account_deletion_rollout.v1['.validate'], /compatibility/u);
  assert.match(rules.account_deletion_rollout.v1['.validate'], /server_only/u);
  assert.match(rules.account_deletion_rollout.v1['.validate'], /hasChildren/u);
  assertOrdinaryClientsDenied(rules.account_deletion_rollout.v1.$other['.validate'], 'unknown rollout fields');
  assertOrdinaryClientsDenied(rules['.write'], 'ancestor root write authority');
});

test('server workflow derives trusted scope, reserves atomically, and deletes Auth only in the terminal phase', () => {
  const functionsSource = source('functions/src/domains/account-deletion/accountDeletionFunctions.js');
  const workerSource = source('functions/src/domains/account-deletion/accountDeletionWorker.js');
  const finalizationSource = source('functions/src/domains/account-deletion/accountDeletionFinalization.js');
  const scopeSource = source('functions/src/domains/account-deletion/accountDeletionScope.js');
  const authoritySource = source('functions/lib/sessionPublicationAuthority.js');

  assert.match(functionsSource, /deriveTrustedAccountDeletionScope/u);
  assert.match(functionsSource, /buildAppSessionCleanupUpdates/u);
  assert.match(functionsSource, /buildInitialAccountDeletionJob\(\{ deletionId, privateScope: scope\.privateScope/u);
  assert.match(functionsSource, /prepareDeletionPublication\(\{ db, authUid, expectedSessionId, deletionId, job,\s*updates: reservationUpdates, lockOwner: sessionLock\.owner, capturedAuthority/u);
  assert.match(functionsSource, /await commitDeletionPublication\(\{ db, authUid, authority, createIssuer \}\)/u);
  assert.doesNotMatch(functionsSource, /await db\.ref\(\)\.update\(/u);
  const deletionCommit = authoritySource.slice(authoritySource.indexOf('const commitDeletionPublication ='));
  assert.match(deletionCommit, /job\.deletionId !== authority\.deletionId \|\| job\.privateScope\?\.authUid !== authUid/u);
  assert.match(deletionCommit, /await issuer\.db\.ref\(\)\.update\(\{ \.\.\.JSON\.parse\(updatesJson\)/u);
  assert.match(deletionCommit, /current\?\.epoch !== authority\.epoch \|\| current\.state !== 'deleted'/u);
  assert.match(authoritySource, /databaseAuthVariableOverride: \{ uid: authUid, lltSessionIssuer: true/u);
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
  assert.match(finalizationSource, /transactExistingRecord\(db\.ref\(`\$\{ACCOUNT_DELETION_QUEUE_ROOT\}/u);
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
