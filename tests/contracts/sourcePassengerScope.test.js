'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sourcePassengerRuleBoundaries, sourcePassengerScopeGuard } = require('../helpers/sourcePassengerScopeRules');
const rules = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8')).rules;
const boundaryKeys = new Set(sourcePassengerRuleBoundaries.map(([name, permission]) => `${name}/${permission}`));

test('every native passenger granting boundary enforces its canonical source scope in permission rules', () => {
  for (const [name, permission, tour] of sourcePassengerRuleBoundaries) {
    const rule = name.split('/').reduce((node, key) => node[key], rules)[permission];
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
      const passengerGrant = value.includes("'passenger'") || value.includes("/participants/")
        || value.includes("/stablePassengerId") || value.includes("/privatePhotoOwnerId")
        || ((value.includes('app_sessions/') || value.includes("child('app_sessions')"))
          && !value.includes("/principalType').val() === 'driver'")
          && !value.includes("child('principalType').val() === 'driver'"));
      // Internal chat is an existing driver-only boundary, including legacy
      // actor identifiers. Its behavior is deliberately outside this change.
      if (parts[0] !== 'internal_chats' && tourScoped && passengerGrant) {
        assert.ok(boundaryKeys.has(`${scope}/${key}`), `${scope}/${key} needs reviewed source scope coverage`);
      }
    }
  };
  scan(rules);
});
