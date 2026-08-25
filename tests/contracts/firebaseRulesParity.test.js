'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const definitions = require('../../contracts/definitions/contracts.v1.json');

const repositoryRoot = path.resolve(__dirname, '../..');
const databaseRules = fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8');
const storageRules = fs.readFileSync(path.join(repositoryRoot, 'storage_rules.json'), 'utf8');
const functionsSource = fs.readFileSync(path.join(repositoryRoot, 'functions/index.js'), 'utf8');

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
    assert.match(functionsSource, new RegExp(`['\"]${screen}['\"]`, 'u'));
  }
  assert.match(functionsSource, /PUSH_NOTIFICATION_SCREENS\.has\(screen\)/u);
});

test('group metadata and both Storage roots retain path-only server-mediated protection', () => {
  assert.match(databaseRules, /!newData\.child\('sourceUrl'\)\.exists\(\)/u);
  assert.match(databaseRules, /!newData\.child\('viewerUrl'\)\.exists\(\)/u);
  assert.match(databaseRules, /!newData\.child\('thumbnailUrl'\)\.exists\(\)/u);
  assert.match(storageRules, /match \/private_tour_photos\/\{tourId\}\/\{ownerId\}\/\{allPaths=\*\*\}[\s\S]*?allow read, write: if false;/u);
  assert.match(storageRules, /match \/group_tour_photos\/\{tourId\}\/\{fileName\}[\s\S]*?allow read, write: if false;/u);
});
