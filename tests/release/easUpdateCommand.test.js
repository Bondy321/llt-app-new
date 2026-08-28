'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildEasUpdateArguments } = require('../../scripts/release/profiles');
const { runEasUpdate } = require('../../scripts/release/runEasUpdate');

test('central update runner owns explicit profile, channel, platform, environment and feature context', () => {
  for (const [targetName, expected] of Object.entries({
    development: ['development', 'development', 'all', 'false'],
    preview: ['preview', 'preview', 'all', 'false'],
    testflight: ['testflight', 'production', 'ios', 'true'],
    production: ['production', 'production', 'all', 'false'],
  })) {
    let invocation;
    let log = '';
    const result = runEasUpdate({
      targetName,
      forwardedArguments: ['--non-interactive', '--message', 'safe message'],
      baseEnvironment: { EXPO_TOKEN: 'secret-sentinel' },
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0 };
      },
      output: { write: (value) => { log += value; } },
    });

    const [profile, environment, platform, featureFlag] = expected;
    assert.match(invocation.command, /^eas(?:\.cmd)?$/u);
    assert.deepEqual(invocation.args.slice(0, 7), [
      'update', '--channel', targetName === 'production' ? 'production' : targetName, '--platform', platform, '--environment', environment,
    ]);
    assert.equal(invocation.options.env.EAS_BUILD_PROFILE, profile);
    assert.equal(invocation.options.env.EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT, featureFlag);
    assert.deepEqual(result.parity.differences, []);
    assert.doesNotMatch(log, /secret-sentinel/u);
  }
});

test('callers cannot override release-owned routing options', () => {
  for (const option of ['--channel=other', '--platform', '--environment=preview', '--branch=unsafe']) {
    assert.throws(() => buildEasUpdateArguments('testflight', [option]), /owned by the selected release target/u);
  }
});

test('a failed EAS process is propagated', () => {
  assert.throws(() => runEasUpdate({
    targetName: 'testflight',
    spawn: () => ({ status: 7 }),
    output: { write: () => {} },
  }), /status 7/u);
});
