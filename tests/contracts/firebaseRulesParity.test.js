'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const definitions = require('../../contracts/definitions/contracts.v1.json');
const { readFunctionsArchitectureSource } = require('../helpers/readAppArchitectureSource');

const repositoryRoot = path.resolve(__dirname, '../..');
const databaseRules = fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8');
const storageRules = fs.readFileSync(path.join(repositoryRoot, 'storage_rules.json'), 'utf8');
const functionsSource = readFunctionsArchitectureSource();
const notificationSource = fs.readFileSync(
  path.join(repositoryRoot, 'functions/src/domains/notifications/pushNavigationData.js'),
  'utf8',
);
const parsedDatabaseRules = JSON.parse(databaseRules).rules;

const ACCOUNT_DELETION_COMPATIBILITY_PREDICATE = "(!root.child('account_deletion_rollout/v1').exists() || (root.child('account_deletion_rollout/v1/schemaVersion').val() === 1 && root.child('account_deletion_rollout/v1/phase').val() === 'compatibility' && root.child('account_deletion_rollout/v1/revision').isNumber() && root.child('account_deletion_rollout/v1/revision').val() >= 1 && root.child('account_deletion_rollout/v1/updatedAtMs').isNumber() && root.child('account_deletion_rollout/v1/updatedAtMs').val() > 0))";

test('Realtime Database identity and session regexes match canonical definitions', () => {
  const passengerPattern = definitions.contracts.PassengerPrincipalId.pattern;
  const sessionPattern = definitions.contracts.AppSessionId.pattern;
  assert.equal(databaseRules.includes(passengerPattern), true);
  assert.equal(databaseRules.includes(sessionPattern), true);
  assert.match(databaseRules, /newData\.child\('schemaVersion'\)\.val\(\) === 1/u);
  assert.match(databaseRules, /newData\.child\('sessionRevision'\)\.val\(\) >= 1/u);
});

test('rules and backend preserve canonical chat, photo, and safety enum values', () => {
  for (const value of definitions.contracts.ChatMessage.enumValues.senderType) {
    assert.match(databaseRules, new RegExp(`senderType'\\)\\.val\\(\\) === '${value}'`, 'u'));
  }
  for (const value of definitions.contracts.ChatMessage.enumValues.type) {
    assert.match(databaseRules, new RegExp(`type'\\)\\.val\\(\\) === '${value}'`, 'u'));
  }
  for (const value of definitions.contracts.GroupPhotoRecord.enumValues.variantStatus) {
    assert.match(databaseRules, new RegExp(`variantStatus'\\)\\.val\\(\\) === '${value}'`, 'u'));
  }
  for (const value of definitions.contracts.SafetySubmission.enumValues.category) {
    assert.match(databaseRules, new RegExp(`category'\\)\\.val\\(\\) === '${value}'`, 'u'));
    assert.match(functionsSource, new RegExp(`['\"]${value}['\"]`, 'u'));
  }
  for (const value of definitions.contracts.SafetySubmission.enumValues.severity) {
    assert.match(databaseRules, new RegExp(`severity'\\)\\.val\\(\\) === '${value}'`, 'u'));
    assert.match(functionsSource, new RegExp(`['\"]${value}['\"]`, 'u'));
  }
});

test('notification routes match the canonical allowlist', () => {
  for (const screen of definitions.contracts.NotificationPayload.enumValues.screen) {
    assert.match(notificationSource, new RegExp(`['\"]${screen}['\"]`, 'u'));
  }
  assert.match(notificationSource, /PUSH_NOTIFICATION_SCREENS\.has\(screen\)/u);
});

test('group metadata and both Storage roots retain path-only server-mediated protection', () => {
  assert.match(databaseRules, /!newData\.child\('sourceUrl'\)\.exists\(\)/u);
  assert.match(databaseRules, /!newData\.child\('viewerUrl'\)\.exists\(\)/u);
  assert.match(databaseRules, /!newData\.child\('thumbnailUrl'\)\.exists\(\)/u);
  assert.match(storageRules, /match \/private_tour_photos\/\{tourId\}\/\{ownerId\}\/\{allPaths=\*\*\}[\s\S]*?allow read, write: if false;/u);
  assert.match(storageRules, /match \/group_tour_photos\/\{tourId\}\/\{fileName\}[\s\S]*?allow read, write: if false;/u);
});

test('account-deletion infrastructure is private and rollout validation is exact', () => {
  for (const rootName of [
    'account_deletion_jobs',
    'account_deletion_queue',
    'account_deletion_active',
    'account_deletion_completion_tombstones',
    'account_deletion_locks',
    'account_deletion_passenger_active',
    'account_deletion_passenger_locks',
    'account_deletion_uid_tombstones',
    'account_deletion_rollout',
    'media_record_locks',
  ]) {
    assert.equal(parsedDatabaseRules[rootName]['.read'], false, `${rootName} read`);
    assert.equal(parsedDatabaseRules[rootName]['.write'], false, `${rootName} write`);
  }

  const rollout = parsedDatabaseRules.account_deletion_rollout.v1;
  assert.equal(
    rollout['.validate'],
    "!newData.exists() || (newData.hasChildren(['schemaVersion', 'phase', 'revision', 'updatedAtMs']) && newData.child('schemaVersion').val() === 1 && (newData.child('phase').val() === 'compatibility' || newData.child('phase').val() === 'server_only') && newData.child('revision').isNumber() && newData.child('revision').val() >= 1 && newData.child('updatedAtMs').isNumber() && newData.child('updatedAtMs').val() > 0)",
  );
  assert.equal(rollout.$other['.validate'], false);
  assert.deepEqual(
    Object.keys(rollout).filter((key) => !key.startsWith('.')).sort(),
    ['$other', 'phase', 'revision', 'schemaVersion', 'updatedAtMs'].sort(),
  );
});

test('the complete compatibility predicate gates only the five legacy deletion permissions', () => {
  const gatedRules = [
    parsedDatabaseRules.users.$userId['.write'],
    parsedDatabaseRules.logs.$userId['.write'],
    parsedDatabaseRules.drivers.$driverId.authUid['.write'],
    parsedDatabaseRules.identity_bindings.$stablePassengerId.$uid['.write'],
    parsedDatabaseRules.passenger_identity_security.$bookingRef.authorizedAuthUid['.write'],
  ];
  for (const rule of gatedRules) {
    assert.equal(rule.includes(ACCOUNT_DELETION_COMPATIBILITY_PREDICATE), true);
  }

  const occurrences = databaseRules.split(ACCOUNT_DELETION_COMPATIBILITY_PREDICATE).length - 1;
  assert.equal(occurrences, 5);

  for (const unaffectedRule of [
    parsedDatabaseRules.chats.$tourId.messages.$messageId.reactions.$emoji.$id['.write'],
    parsedDatabaseRules.tours.$tourId.liveTracking.$userId['.write'],
    parsedDatabaseRules.group_tour_photos.$tourId.$photoId.caption['.write'],
    parsedDatabaseRules.notification_read_state.$tourId.$principalId.$noticeId['.write'],
    parsedDatabaseRules.app_sessions.$authUid['.write'],
  ]) {
    assert.equal(String(unaffectedRule).includes('account_deletion_rollout'), false);
  }
});
