'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertAllProfileParity,
  resolveProfileParity,
} = require('../../scripts/release/configParity');

test('binary and OTA contexts resolve identical Expo config for every update target', () => {
  const results = assertAllProfileParity({ baseEnvironment: {} });
  assert.deepEqual(results.map(({ targetName }) => targetName), [
    'development',
    'preview',
    'testflight',
    'production',
  ]);
  for (const result of results) {
    assert.deepEqual(result.binary, result.update, result.targetName);
    assert.equal(result.binary.version, '1.0.5');
    assert.equal(result.binary.runtimeVersion, '1.0.5');
    assert.match(result.binary.updateUrl, /^https:\/\/u\.expo\.dev\//u);
    assert.equal(result.binary.owner, 'lochlomondtravel');
    assert.ok(result.binary.projectId);
    assert.ok(result.binary.plugins.length > 0);
  }
});

test('TestFlight is eligible and production remains explicitly ineligible with store cleanup enabled', () => {
  const testflight = resolveProfileParity('testflight', { baseEnvironment: {} });
  const production = resolveProfileParity('production', { baseEnvironment: {} });
  const development = resolveProfileParity('development', { baseEnvironment: {} });

  assert.equal(testflight.binary.featureFlags.driverTourPackTestflight, true);
  assert.equal(production.binary.featureFlags.driverTourPackTestflight, false);
  assert.equal(development.binary.featureFlags.driverTourPackTestflight, false);
  assert.equal(testflight.binary.productionCleanupEnabled, true);
  assert.equal(production.binary.productionCleanupEnabled, true);
  assert.equal(development.binary.productionCleanupEnabled, false);
  assert.deepEqual(testflight.binary.autolinking, production.binary.autolinking);
  assert.deepEqual(testflight.binary.appTransportSecurity, { NSAllowsArbitraryLoads: false });
});

test('parity results do not expose unrelated process secrets', () => {
  const sentinel = 'must-not-appear-in-release-output';
  const result = resolveProfileParity('testflight', {
    baseEnvironment: { EXPO_TOKEN: sentinel, PRIVATE_SIGNING_SECRET: sentinel },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
});

test('channel drift is reported by field name without configuration values', () => {
  const eas = require('../../eas.json');
  const changed = JSON.parse(JSON.stringify(eas));
  changed.build.testflight.channel = 'wrong-channel-value';
  const result = resolveProfileParity('testflight', { baseEnvironment: {}, eas: changed });
  assert.deepEqual(result.differences, ['channel']);
  assert.doesNotMatch(result.differences.join(','), /wrong-channel-value/u);
});
