'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLiveStateClientSupported, normalizeLiveStateRollout, transitionLiveStateRollout } = require('../functions/lib/liveStateRollout');
const { evaluateOperationalRolloutPhase } = require('../functions/src/domains/live-state/liveStateRolloutFunctions');
const current = { schemaVersion: 1, phase: 'cutover', projectionRevision: 1, updatedAtMs: 100 };
test('missing state selects the sole supported server projection contract', () => {
  assert.equal(normalizeLiveStateRollout(null).rollout.phase, 'cutover');
  assert.equal(normalizeLiveStateRollout(null).isDefault, true);
});
test('obsolete, unknown and partial live-state records fail closed', () => {
  for (const value of [{ ...current, phase: 'compatibility' }, { ...current, surprise: true }, { phase: 'cutover' }]) {
    assert.equal(normalizeLiveStateRollout(value).valid, false);
  }
});
test('operations can advance only the supported contract with an exact revision', () => {
  const next = transitionLiveStateRollout({ current, expectedRevision: 1, phase: 'cutover', nowMs: 200 });
  assert.deepEqual(next, { ...current, projectionRevision: 2, updatedAtMs: 200 });
  assert.throws(() => transitionLiveStateRollout({ current, expectedRevision: 0, phase: 'cutover', nowMs: 200 }), /revision/i);
  assert.throws(() => transitionLiveStateRollout({ current, expectedRevision: 1, phase: 'compatibility', nowMs: 200 }), /phase/i);
});
test('all unsupported or malformed native versions require a fresh supported binary', () => {
  for (const clientVersion of ['1.0.4', '1.0.5', '1.0.7', '', null, 'garbage']) {
    assert.equal(isLiveStateClientSupported({ rollout: current, clientVersion }), false);
  }
  assert.equal(isLiveStateClientSupported({ rollout: current, clientVersion: '1.1.0' }), true);
});
test('operations cannot restore obsolete ordinary-client projection writes', () => {
  assert.deepEqual(evaluateOperationalRolloutPhase('cutover'), { allowed: true, reason: null });
  assert.deepEqual(evaluateOperationalRolloutPhase('compatibility'), { allowed: false, reason: 'UNSUPPORTED_LIVE_STATE_CONTRACT' });
});
