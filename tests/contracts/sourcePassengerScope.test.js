'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sourcePassengerRuleBoundaries, sourcePassengerScopeGuard } = require('../helpers/sourcePassengerScopeRules');
const { unwrapReviewedAuthorityConstraints, unwrapReviewedServerReadGrant, assertOrdinaryRuleDenied } = require('../helpers/reviewedRuleConstraints');
const CLOSED_PASSENGER_BOUNDARIES = new Set(['chats/$tourId/typing/$id/.write', 'chats/$tourId/presence/$id/.write']);
const rules = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8')).rules;
const boundaryKeys = new Set(sourcePassengerRuleBoundaries.map(([name, permission]) => `${name}/${permission}`));

test('every native passenger granting boundary enforces its canonical source scope in permission rules', () => {
  for (const [name, permission, tour] of sourcePassengerRuleBoundaries) {
    const rule = name.split('/').reduce((node, key) => node[key], rules)[permission];
    if (CLOSED_PASSENGER_BOUNDARIES.has(`${name}/${permission}`)) {
      assertOrdinaryRuleDenied(assert, rule, `${name}/${permission}`);
      continue;
    }
    assert.equal(typeof rule, 'string', `${name}/${permission} must remain explicit`);
    assert.ok(rule.includes(sourcePassengerScopeGuard(tour)), `${name}/${permission} must guard reads/writes/deletes`);
  }
});

test('new tour-scoped passenger grant paths cannot silently escape the source scope inventory', () => {
  const scan = (node, parts = []) => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') scan(value, [...parts, key]);
      if (!['.read', '.write'].includes(key) || typeof value !== 'string') continue;
      const scope = parts.join('/');
      const tourScoped = scope.includes('$tourId') || /^chat_(presence|typing)_sessions\//.test(scope)
        || /^passenger_trip_signals\//.test(scope) || scope === 'content_reports/$reportId'
        || /^booking_access_grants\//.test(scope);
      const grant = unwrapReviewedAuthorityConstraints(unwrapReviewedServerReadGrant(value, parts));
      const passengerGrant = grant.includes("'passenger'") || grant.includes("/participants/")
        || grant.includes("/stablePassengerId") || grant.includes("/privatePhotoOwnerId")
        || ((grant.includes('app_sessions/') || grant.includes("child('app_sessions')"))
          && !grant.includes("/principalType').val() === 'driver'")
          && !grant.includes("child('principalType').val() === 'driver'"));
      // Internal chat is an existing driver-only boundary, including legacy
      // actor identifiers. Its behavior is deliberately outside this change.
      if (parts[0] !== 'internal_chats' && tourScoped && passengerGrant) {
        assert.ok(boundaryKeys.has(`${scope}/${key}`), `${scope}/${key} needs reviewed source scope coverage`);
      }
    }
  };
  scan(rules);
});

test('source inventory unwraps only exact reviewed AND constraints', () => {
  const rule = rules.tour_manifests.$tourId['.read'];
  const grant = unwrapReviewedAuthorityConstraints(rule);
  assert.notEqual(grant, rule);
  assert.equal(grant.includes("child('deviceAuthorizationVersion')"), false);
  assert.equal(grant.includes("/principalType').val() === 'driver'"), true);
  const changed = rule.replace("child('state').val() === 'committed'", "child('state').val() !== 'committed'");
  assert.equal(unwrapReviewedAuthorityConstraints(changed), changed);
  const alternative = rule.replace(' && ((auth == null', ' || ((auth == null');
  assert.equal(unwrapReviewedAuthorityConstraints(alternative), alternative);
});

test('server-only CAS read exclusion requires exact reviewed path and predicate', () => {
  const value = rules.tours.$tourId['.read'];
  const unwrapped = unwrapReviewedServerReadGrant(value, ['tours', '$tourId']);
  assert.notEqual(unwrapped, value);
  assert.equal(unwrapReviewedServerReadGrant(value, ['unknown', '$tourId']), value);
  const changed = value.replaceAll('auth.lltTourPublisher === true', 'auth.lltTourPublisher !== true');
  assert.equal(unwrapReviewedServerReadGrant(changed, ['tours', '$tourId']), changed);
  const ordinaryGrant = `${value} || auth != null`;
  assert.equal(unwrapReviewedServerReadGrant(ordinaryGrant, ['tours', '$tourId']), ordinaryGrant);
});
