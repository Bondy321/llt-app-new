'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyChangedPath, createUpdatePlan } = require('../../scripts/release/updatePlan');

test('main pushes with only known non-bundle paths are deterministic no-ops', () => {
  const plan = createUpdatePlan({
    eventName: 'push',
    changedPaths: ['docs/release.md', 'functions/src/index.js', 'web-admin/src/App.jsx', 'database.rules.json'],
  });
  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'no-mobile-bundle-change');
});

test('a JavaScript mobile bundle change is eligible for automatic TestFlight OTA', () => {
  const plan = createUpdatePlan({ eventName: 'push', changedPaths: ['screens/TourHomeScreen.js'] });
  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'mobile-bundle-change');
});

test('native and unknown changes default to a manual release boundary', () => {
  const nativePlan = createUpdatePlan({
    eventName: 'push',
    changedPaths: ['app.config.js'],
    nativeChanged: true,
  });
  const unknownPlan = createUpdatePlan({ eventName: 'push', changedPaths: ['new-runtime-input.xyz'] });

  assert.equal(nativePlan.shouldPublish, false);
  assert.equal(nativePlan.reason, 'native-change-binary-required');
  assert.equal(unknownPlan.shouldPublish, false);
  assert.equal(unknownPlan.reason, 'unknown-path-manual-required');
  assert.equal(classifyChangedPath('new-runtime-input.xyz'), 'unknown');
});

test('workflow dispatch remains explicit and available even without a diff base', () => {
  const plan = createUpdatePlan({ eventName: 'workflow_dispatch', changeSetKnown: false, nativeChanged: true });
  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'manual-dispatch');
});
