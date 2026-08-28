'use strict';

const EXPO_CLI_VERSION = '55.0.36';
const EAS_CLI_VERSION = '22.6.0';

const UPDATE_TARGETS = Object.freeze({
  development: Object.freeze({
    buildProfile: 'development',
    channel: 'development',
    environment: 'development',
    platform: 'all',
    driverTourPackTestflight: 'false',
  }),
  preview: Object.freeze({
    buildProfile: 'preview',
    channel: 'preview',
    environment: 'preview',
    platform: 'all',
    driverTourPackTestflight: 'false',
  }),
  testflight: Object.freeze({
    buildProfile: 'testflight',
    channel: 'testflight',
    environment: 'production',
    platform: 'ios',
    driverTourPackTestflight: 'true',
  }),
  production: Object.freeze({
    buildProfile: 'production',
    channel: 'production',
    environment: 'production',
    platform: 'all',
    driverTourPackTestflight: 'false',
  }),
});

const RESERVED_UPDATE_OPTIONS = new Set([
  '--branch',
  '--channel',
  '--environment',
  '--platform',
  '--profile',
]);

const getUpdateTarget = (name) => {
  const target = UPDATE_TARGETS[name];
  if (!target) {
    throw new Error(`Unknown EAS update target "${name || ''}". Expected one of: ${Object.keys(UPDATE_TARGETS).join(', ')}.`);
  }
  return target;
};

const createUpdateEnvironment = (targetName, baseEnvironment = process.env) => {
  const target = getUpdateTarget(targetName);
  return {
    ...baseEnvironment,
    EAS_BUILD_PROFILE: target.buildProfile,
    EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT: target.driverTourPackTestflight,
  };
};

const assertSafeForwardedArguments = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const optionName = String(argument).split('=', 1)[0];
    if (RESERVED_UPDATE_OPTIONS.has(optionName)) {
      throw new Error(`${optionName} is owned by the selected release target and cannot be overridden.`);
    }
  }
};

const buildEasUpdateArguments = (targetName, forwardedArguments = []) => {
  const target = getUpdateTarget(targetName);
  assertSafeForwardedArguments(forwardedArguments);
  return [
    'update',
    '--channel',
    target.channel,
    '--platform',
    target.platform,
    '--environment',
    target.environment,
    ...forwardedArguments,
  ];
};

module.exports = {
  EAS_CLI_VERSION,
  EXPO_CLI_VERSION,
  UPDATE_TARGETS,
  buildEasUpdateArguments,
  createUpdateEnvironment,
  getUpdateTarget,
};
