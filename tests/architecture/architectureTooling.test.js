'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createArchitectureReport, extractCommonJsObjectExports, extractSpecifiers } = require('../../scripts/reportArchitecture');
const { resolveLimit } = require('../../scripts/checkArchitecture');
const dependencyPolicy = require('../../.dependency-cruiser.cjs');

test('architecture report excludes test/build output and reports deterministic public surfaces', () => {
  const report = createArchitectureReport();
  assert.ok(report.sourceFileCount > 100);
  assert.equal(report.byBytes.some((entry) => /(?:^|\/)(?:tests|node_modules|dist|build)\//u.test(entry.path)), false);
  assert.equal(report.functionExports.includes('verifyPassengerLogin'), true);
  assert.equal(report.mobileRoutes.includes('Chat'), true);
});

test('architecture report recognises CommonJS exports and static import forms', () => {
  assert.deepEqual(extractCommonJsObjectExports('const a = 1;\nmodule.exports = {\n a,\n b,\n};\n'), ['a', 'b']);
  assert.deepEqual(extractSpecifiers("import x from './x'; const y = require('./y'); import('./z');").sort(), ['./x', './y', './z']);
});

test('architecture limits prioritise explicit entrypoints, screens, hooks, and logic modules', () => {
  assert.equal(resolveLimit({ path: 'App.js' }), 150);
  assert.equal(resolveLimit({ path: 'screens/ChatScreen.js' }), 60);
  assert.equal(resolveLimit({ path: 'src/features/chat/ChatScreen.js' }), 500);
  assert.equal(resolveLimit({ path: 'src/features/chat/hooks/useChatController.js' }), 300);
  assert.equal(resolveLimit({ path: 'src/features/chat/domain/messageFormatting.js' }), 600);
});

test('dependency policy generates private cross-module guards for every runtime', () => {
  const ruleNames = new Set(dependencyPolicy.forbidden.map((rule) => rule.name));
  assert.equal(ruleNames.has('functions-domain-driver-auth-uses-public-entrypoints'), true);
  assert.equal(ruleNames.has('functions-domain-passenger-auth-uses-public-entrypoints'), true);
  assert.equal(ruleNames.has('mobile-feature-auth-uses-public-entrypoints'), true);
  assert.equal(ruleNames.has('admin-feature-tours-uses-public-entrypoints'), true);

  const driverRule = dependencyPolicy.forbidden.find(
    (rule) => rule.name === 'functions-domain-driver-auth-uses-public-entrypoints',
  );
  const privateTarget = new RegExp(driverRule.to.path, 'u');
  assert.equal(privateTarget.test('functions/src/domains/passenger-auth/passengerLoginWorkflow.js'), true);
  assert.equal(privateTarget.test('functions/src/domains/passenger-auth/public.js'), false);
});
