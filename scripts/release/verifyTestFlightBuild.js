'use strict';

const fs = require('node:fs');
const { resolveEasBuildProfile } = require('./configParity');

// These are fields returned by the pinned EAS CLI's build:view --json command:
// https://github.com/expo/eas-cli/blob/v22.6.0/packages/eas-cli/src/graphql/types/Build.ts
// No guessed metadata aliases or missing-field fallbacks establish provenance.
function assertTestFlightBuild(build, { releaseSha, buildId, appConfig, easConfig, nowMs = Date.now() }) {
  const requireValue = (condition, field) => {
    if (!condition) throw new Error(`Selected EAS build failed TestFlight verification: ${field}.`);
  };
  requireValue(/^[0-9a-f]{40}$/u.test(releaseSha || ''), 'reviewed release SHA');
  requireValue(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(buildId || ''), 'selected build ID');
  requireValue(build && typeof build === 'object' && !Array.isArray(build), 'build response');
  const profile = resolveEasBuildProfile(easConfig, 'testflight');
  requireValue(profile.environment === 'production' && profile.channel === 'testflight', 'reviewed production profile/channel');
  requireValue(profile.developmentClient !== true && (profile.distribution || 'store') === 'store', 'reviewed store distribution');
  for (const key of ['EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK', 'EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK', 'LLT_REQUIRE_PRODUCTION_APPCHECK']) {
    requireValue(profile.env?.[key] === 'true', `reviewed ${key}`);
  }
  requireValue(appConfig?.runtimeVersion?.policy === 'appVersion', 'reviewed appVersion runtime policy');
  requireValue(typeof appConfig.version === 'string' && appConfig.version.length > 0, 'reviewed application version');
  requireValue(typeof appConfig.ios?.bundleIdentifier === 'string' && appConfig.ios.bundleIdentifier.length > 0, 'reviewed application identifier');
  requireValue(typeof appConfig.extra?.eas?.projectId === 'string' && appConfig.extra.eas.projectId.length > 0, 'reviewed EAS project');
  requireValue(build.id === buildId, 'build ID');
  requireValue(build.gitCommitHash === releaseSha, 'exact release SHA');
  requireValue(build.status === 'FINISHED', 'finished status');
  requireValue(build.platform === 'IOS', 'iOS platform');
  requireValue(build.distribution === 'STORE', 'store distribution');
  requireValue(build.isForIosSimulator === false, 'physical-device artifact');
  requireValue(build.buildProfile === 'testflight', 'testflight build profile');
  requireValue(build.updateChannel?.name === profile.channel, 'update channel');
  requireValue(build.app?.id === appConfig.extra.eas.projectId, 'EAS project');
  requireValue(build.appIdentifier === appConfig.ios.bundleIdentifier, 'application identifier');
  requireValue(build.appVersion === appConfig.version, 'application version');
  requireValue(build.runtime?.version === appConfig.version, 'runtime version');
  requireValue(typeof build.appBuildVersion === 'string' && /^\d+(?:\.\d+){0,2}$/u.test(build.appBuildVersion), 'native build version');
  const completedAtMs = Date.parse(build.completedAt);
  requireValue(Number.isFinite(completedAtMs) && completedAtMs <= nowMs, 'completed timestamp');
  if (build.expirationDate !== null && build.expirationDate !== undefined) {
    const expirationMs = Date.parse(build.expirationDate);
    requireValue(Number.isFinite(expirationMs) && expirationMs > nowMs, 'unexpired artifact');
  }
  let archive;
  try { archive = new URL(build.artifacts?.applicationArchiveUrl); } catch { /* Fail closed below. */ }
  requireValue(archive?.protocol === 'https:' && !archive.username && !archive.password, 'HTTPS application archive');
  return { buildId, releaseSha, profile: 'testflight', runtime: build.runtime.version };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) throw new Error('An EAS build:view JSON file is required.');
  const result = assertTestFlightBuild(JSON.parse(fs.readFileSync(input, 'utf8')), {
    releaseSha: process.env.GITHUB_SHA,
    buildId: process.env.EAS_BUILD_ID,
    appConfig: require('../../app.config.js').expo,
    easConfig: require('../../eas.json'),
  });
  console.log(`Verified completed TestFlight device build ${result.buildId} for ${result.releaseSha}, runtime ${result.runtime}.`);
}

module.exports = { assertTestFlightBuild };
