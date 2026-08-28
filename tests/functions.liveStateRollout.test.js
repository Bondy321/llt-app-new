'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_STATE_COMPATIBILITY_PHASE,
  LIVE_STATE_CUTOVER_PHASE,
  isLiveStateClientSupported,
  normalizeLiveStateRollout,
  transitionLiveStateRollout,
} = require('../functions/lib/liveStateRollout');
const {
  evaluateOperationalRolloutPhase,
} = require('../functions/src/domains/live-state/liveStateRolloutFunctions');

test('missing rollout state is compatibility and never an implicit cutover', () => {
  const normalized = normalizeLiveStateRollout(null);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.isDefault, true);
  assert.equal(normalized.rollout.phase, LIVE_STATE_COMPATIBILITY_PHASE);
});

test('explicit rollout state rejects unknown or partial properties', () => {
  assert.equal(normalizeLiveStateRollout({
    schemaVersion: 1,
    phase: LIVE_STATE_COMPATIBILITY_PHASE,
    projectionRevision: 1,
    updatedAtMs: 100,
    surprise: true,
  }).valid, false);
  assert.equal(normalizeLiveStateRollout({ schemaVersion: 1, phase: LIVE_STATE_COMPATIBILITY_PHASE }).valid, false);
});

test('only an explicit revision-checked operations transition enables cutover', () => {
  const compatibility = {
    schemaVersion: 1,
    phase: LIVE_STATE_COMPATIBILITY_PHASE,
    projectionRevision: 1,
    updatedAtMs: 100,
  };
  const next = transitionLiveStateRollout({
    current: compatibility,
    expectedRevision: 1,
    phase: LIVE_STATE_CUTOVER_PHASE,
    actorHash: 'b'.repeat(24),
    nowMs: 200,
  });
  assert.equal(next.phase, LIVE_STATE_CUTOVER_PHASE);
  assert.equal(next.projectionRevision, 2);
  assert.throws(() => transitionLiveStateRollout({
    current: compatibility,
    expectedRevision: 0,
    phase: LIVE_STATE_CUTOVER_PHASE,
    actorHash: 'b'.repeat(24),
    nowMs: 200,
  }), /revision/i);
});

test('cutover gives trusted clients below 1.0.5 a deterministic update-required gate', () => {
  const rollout = {
    schemaVersion: 1,
    phase: LIVE_STATE_CUTOVER_PHASE,
    projectionRevision: 2,
    updatedAtMs: 200,
  };
  assert.equal(isLiveStateClientSupported({ rollout, clientVersion: '1.0.4' }), false);
  assert.equal(isLiveStateClientSupported({ rollout, clientVersion: '1.0.5' }), true);
  assert.equal(isLiveStateClientSupported({ rollout, clientVersion: '1.1.0' }), true);
});

test('operations cannot enable cutover until legacy update signalling is a verified prerequisite', () => {
  assert.deepEqual(evaluateOperationalRolloutPhase(LIVE_STATE_CUTOVER_PHASE), {
    allowed: false,
    reason: 'LIVE_STATE_CUTOVER_PREREQUISITE_NOT_MET',
  });
  assert.deepEqual(evaluateOperationalRolloutPhase(LIVE_STATE_COMPATIBILITY_PHASE), { allowed: true, reason: null });
});
