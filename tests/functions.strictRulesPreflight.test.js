'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMaterializedOffPolicy,
  validateStrictRulesPreflightPolicy,
} = require('../functions/scripts/strictRulesPreflight');

const valid = () => ({
  schemaVersion: 1,
  enforceSingleDevice: false,
  generation: 0,
  revision: 1,
  updatedAtMs: 100,
  transitionPhase: 'stable',
});

test('strict-rules preflight rejects every unsafe policy state', () => {
  for (const [name, value] of [
    ['missing', null],
    ['malformed', { ...valid(), schemaVersion: 2 }],
    ['implicit phase', { ...valid(), transitionPhase: undefined }],
    ['transitioning', { ...valid(), transitionPhase: 'draining', transitionId: 't1' }],
    ['on', { ...valid(), enforceSingleDevice: true }],
    ['nonzero generation', { ...valid(), generation: 1 }],
  ]) {
    const result = validateStrictRulesPreflightPolicy(value);
    assert.equal(result.ready, false, name);
    assert.ok(result.reasons.length > 0, name);
  }
});

test('strict-rules preflight accepts exact stable OFF generation zero only', () => {
  assert.deepEqual(validateStrictRulesPreflightPolicy(valid()), { ready: true, reasons: [] });
  assert.deepEqual(buildMaterializedOffPolicy({ nowMs: 123 }), {
    schemaVersion: 1,
    enforceSingleDevice: false,
    generation: 0,
    revision: 1,
    updatedAtMs: 123,
    transitionPhase: 'stable',
  });
});
