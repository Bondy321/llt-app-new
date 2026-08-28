'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { UPDATE_TARGETS, createUpdateEnvironment } = require('./profiles');

const ROOT = path.resolve(__dirname, '../..');
const APP_CONFIG_PATH = path.join(ROOT, 'app.config.js');
const EAS_CONFIG_PATH = path.join(ROOT, 'eas.json');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const mergeProfile = (base, next) => {
  const result = { ...base };
  for (const [key, value] of Object.entries(next || {})) {
    if (key === 'extends') continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? mergeProfile(result[key], value)
      : value;
  }
  return result;
};

const resolveEasBuildProfile = (eas, profileName, trail = []) => {
  if (trail.includes(profileName)) throw new Error(`Circular EAS build profile inheritance: ${[...trail, profileName].join(' -> ')}`);
  const profile = eas.build?.[profileName];
  if (!profile) throw new Error(`Missing EAS build profile "${profileName}".`);
  const parent = profile.extends
    ? resolveEasBuildProfile(eas, profile.extends, [...trail, profileName])
    : {};
  return mergeProfile(parent, profile);
};

const withTemporaryEnvironment = (environment, callback) => {
  const names = new Set([
    'EAS_BUILD_PROFILE',
    'EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT',
    ...Object.keys(environment),
  ]);
  const previous = new Map([...names].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      const value = environment[name];
      if (value === undefined || value === null) delete process.env[name];
      else process.env[name] = String(value);
    }
    delete require.cache[require.resolve(APP_CONFIG_PATH)];
    return callback();
  } finally {
    delete require.cache[require.resolve(APP_CONFIG_PATH)];
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const normalizePlugins = (plugins = []) => plugins.map((plugin) => (
  Array.isArray(plugin) ? [plugin[0], plugin[1] || null] : plugin
));

const resolveRuntimeVersion = (config) => {
  const runtime = config.runtimeVersion;
  if (typeof runtime === 'string') return runtime;
  if (runtime?.policy === 'appVersion') return config.version;
  return runtime?.policy ? `policy:${runtime.policy}` : null;
};

const createConfigSnapshot = (environment) => withTemporaryEnvironment(environment, () => {
  const config = require(APP_CONFIG_PATH).expo;
  const profile = environment.EAS_BUILD_PROFILE;
  return {
    version: config.version,
    runtimeVersion: resolveRuntimeVersion(config),
    updateUrl: config.updates?.url || null,
    owner: config.owner || null,
    projectId: config.extra?.eas?.projectId || null,
    plugins: normalizePlugins(config.plugins),
    productionCleanupEnabled: profile === 'production' || profile === 'testflight',
    autolinking: config.autolinking || null,
    appTransportSecurity: config.ios?.infoPlist?.NSAppTransportSecurity || null,
    featureFlags: {
      driverTourPackTestflight: environment.EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT === 'true',
    },
    extra: config.extra || {},
  };
});

const findDifferencePaths = (left, right, prefix = '') => {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix || '<root>'];
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => findDifferencePaths(
      left[key],
      right[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return [prefix || '<root>'];
};

const resolveProfileParity = (targetName, { baseEnvironment = process.env, eas } = {}) => {
  const target = UPDATE_TARGETS[targetName];
  if (!target) throw new Error(`Unknown release target "${targetName}".`);
  const easConfig = eas || JSON.parse(fs.readFileSync(EAS_CONFIG_PATH, 'utf8'));
  const buildProfile = resolveEasBuildProfile(easConfig, target.buildProfile);
  const binaryEnvironment = {
    ...baseEnvironment,
    ...(buildProfile.env || {}),
    EAS_BUILD_PROFILE: target.buildProfile,
  };
  const updateEnvironment = createUpdateEnvironment(targetName, baseEnvironment);
  const binary = createConfigSnapshot(binaryEnvironment);
  const update = createConfigSnapshot(updateEnvironment);
  const differences = findDifferencePaths(binary, update);

  if (buildProfile.channel !== target.channel) differences.push('channel');
  if (buildProfile.environment !== target.environment) differences.push('environment');
  return { targetName, buildProfile, binary, update, differences: [...new Set(differences)].sort() };
};

const assertAllProfileParity = (options = {}) => {
  const results = Object.keys(UPDATE_TARGETS).map((targetName) => resolveProfileParity(targetName, options));
  const failures = results.filter((result) => result.differences.length > 0);
  if (failures.length > 0) {
    throw new Error(failures.map((failure) => (
      `${failure.targetName} binary/update config differs at: ${failure.differences.join(', ')}`
    )).join('\n'));
  }
  return results;
};

module.exports = {
  assertAllProfileParity,
  createConfigSnapshot,
  findDifferencePaths,
  resolveEasBuildProfile,
  resolveProfileParity,
};
