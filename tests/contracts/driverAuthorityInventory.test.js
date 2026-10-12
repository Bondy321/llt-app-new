'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { findDriverAuthorityRulesWithoutPolicy, originalReviewedGrant } = require('../helpers/driverAuthorityRules');
const { constrainSourcePassengerRule } = require('../helpers/sourcePassengerScopeRules');
const source = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8'));
const boundaryPath = ['rules', 'chats', '$tourId', '.read'];
const driverRole = "root.child('app_sessions/' + auth.uid + '/principalType').val() === 'driver'";

test('driver authority inventory checks real grants rather than reviewed non-granting source exemptions', () => {
  assert.deepEqual(findDriverAuthorityRulesWithoutPolicy(source()), []);
});

test('removing the generation check from a real wrapped driver grant remains detectable', () => {
  const rules = source();
  const wrapped = rules.rules.chats.$tourId['.read'];
  const grant = originalReviewedGrant(wrapped, boundaryPath);
  assert.notEqual(grant, wrapped, 'this regression must mutate the original grant, not its constraint');
  const corrupted = grant.replaceAll('driver_login_policy/v1/generation', 'driver_login_policy/v1/unrelatedField');
  assert.notEqual(corrupted, grant);
  assert.ok(corrupted.includes('driver_login_policy/v1'), 'mere policy mention cannot satisfy generation proof');
  rules.rules.chats.$tourId['.read'] = constrainSourcePassengerRule(corrupted, '$tourId');
  assert.ok(findDriverAuthorityRulesWithoutPolicy(rules).includes(boundaryPath.join('/')));
});

test('an unknown permission path cannot hide a driver grant behind a familiar-looking source constraint', () => {
  const unknown = { rules: { unreviewed: { $tourId: { '.read': constrainSourcePassengerRule(driverRole, '$tourId') } } } };
  assert.deepEqual(findDriverAuthorityRulesWithoutPolicy(unknown), ['rules/unreviewed/$tourId/.read']);
});

test('changed suffixes or extra driver grants are never stripped as a reviewed wrapper', () => {
  const harmlessPassengerGrant = "auth != null && root.child('app_sessions/' + auth.uid + '/principalType').val() === 'passenger'";
  const reviewed = constrainSourcePassengerRule(harmlessPassengerGrant, '$tourId');
  assert.equal(originalReviewedGrant(reviewed, boundaryPath), harmlessPassengerGrant);
  for (const altered of [
    `${reviewed} || (${driverRole})`,
    `(auth != null) || (${driverRole})${constrainSourcePassengerRule('', '$tourId').slice(1)}`,
    reviewed.replace("=== 'driver'", "=== 'driver' || true"),
    constrainSourcePassengerRule(harmlessPassengerGrant, "data.child('tourId').val()"),
  ]) {
    assert.equal(originalReviewedGrant(altered, boundaryPath), altered);
    const rules = { rules: { chats: { $tourId: { '.read': altered } } } };
    assert.deepEqual(findDriverAuthorityRulesWithoutPolicy(rules), [boundaryPath.join('/')]);
  }
});
