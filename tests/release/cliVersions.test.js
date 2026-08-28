'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EAS_CLI_VERSION, EXPO_CLI_VERSION } = require('../../scripts/release/profiles');
const { assertCliVersions, resolveEasCliVersion } = require('../../scripts/release/checkCliVersions');

test('the installed SDK-local Expo CLI matches the reviewed pin', () => {
  assert.deepEqual(assertCliVersions(), { expoVersion: EXPO_CLI_VERSION, easVersion: null });
});

test('EAS CLI output is parsed and checked exactly', () => {
  const spawn = () => ({ status: 0, stdout: `eas-cli/${EAS_CLI_VERSION} win32-x64 node-v24`, stderr: '' });
  assert.equal(resolveEasCliVersion(spawn), EAS_CLI_VERSION);
  assert.deepEqual(assertCliVersions({ checkEas: true, spawn }), {
    expoVersion: EXPO_CLI_VERSION,
    easVersion: EAS_CLI_VERSION,
  });
});
