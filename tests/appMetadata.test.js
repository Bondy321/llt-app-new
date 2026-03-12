const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAppVersionMetadata } = require('../services/appMetadata');

test('resolveAppVersionMetadata prefers expoConfig version and build values', () => {
  const result = resolveAppVersionMetadata({
    constants: {
      expoConfig: {
        version: '2.5.1',
        ios: { buildNumber: '72' },
      },
      nativeAppVersion: '1.0.0',
      nativeBuildVersion: '42',
    },
    platform: { Version: '17.6' },
  });

  assert.deepEqual(result, {
    appVersion: '2.5.1',
    appBuild: '72',
    osVersion: '17.6',
  });
});

test('resolveAppVersionMetadata falls back to native metadata when expoConfig is absent', () => {
  const result = resolveAppVersionMetadata({
    constants: {
      nativeAppVersion: '3.0.0',
      nativeBuildVersion: 901,
    },
    platform: { Version: 18 },
  });

  assert.deepEqual(result, {
    appVersion: '3.0.0',
    appBuild: '901',
    osVersion: '18',
  });
});

test('resolveAppVersionMetadata returns safe unknown defaults for invalid metadata', () => {
  const result = resolveAppVersionMetadata({
    constants: {
      expoConfig: { version: '   ' },
      nativeAppVersion: null,
      nativeBuildVersion: '',
    },
    platform: { Version: undefined },
  });

  assert.deepEqual(result, {
    appVersion: 'unknown',
    appBuild: null,
    osVersion: 'unknown',
  });
});
