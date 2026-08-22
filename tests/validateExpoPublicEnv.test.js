const test = require('node:test');
const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateExpoPublicEnv } = require('../scripts/validateExpoPublicEnv');

const validEnv = {
  EXPO_PUBLIC_FIREBASE_API_KEY: `AIza${'a'.repeat(32)}`,
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'loch-lomond-travel.firebaseapp.com',
  EXPO_PUBLIC_FIREBASE_DATABASE_URL: 'https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'loch-lomond-travel',
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: 'loch-lomond-travel.firebasestorage.app',
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '500767842880',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:500767842880:web:b27b5630eed50e6ea4f5a5',
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: 'G-D46EKN8EDZ',
  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: `AIza${'b'.repeat(32)}`,
  EXPO_PUBLIC_SUPPORT_PHONE: '+441414876737',
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK: 'false',
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK: 'false',
};

test('validateExpoPublicEnv accepts the expected production-shaped values', () => {
  const result = validateExpoPublicEnv(validEnv, { platform: 'all' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateExpoPublicEnv allows iOS-only validation without a Google Maps key', () => {
  const env = { ...validEnv };
  delete env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

  const result = validateExpoPublicEnv(env, { platform: 'ios' });
  assert.equal(result.ok, true);
});

test('validateExpoPublicEnv rejects unresolved EAS aliases and placeholders', () => {
  const result = validateExpoPublicEnv(
    {
      ...validEnv,
      EXPO_PUBLIC_FIREBASE_API_KEY: '@firebase_api_key',
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'your_project.firebaseapp.com',
    },
    { platform: 'all' }
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('EXPO_PUBLIC_FIREBASE_API_KEY')));
  assert.ok(result.errors.some((error) => error.includes('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN')));
});

test('production validation requires both App Check client flags to be exactly true', () => {
  const rejected = validateExpoPublicEnv(validEnv, {
    platform: 'ios', requireProductionAppCheck: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors.filter((error) => error.includes('must be exactly true')).length, 2);

  const accepted = validateExpoPublicEnv({
    ...validEnv,
    EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK: 'true',
    EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK: 'true',
  }, { platform: 'ios', requireProductionAppCheck: true });
  assert.equal(accepted.ok, true);

  const profileRejected = validateExpoPublicEnv({
    ...validEnv,
    EAS_BUILD_PROFILE: 'production',
  }, { platform: 'ios' });
  assert.equal(profileRejected.ok, false);
  assert.equal(profileRejected.errors.filter((error) => error.includes('must be exactly true')).length, 2);
});

test('production and TestFlight workflows never supply false App Check fallbacks', () => {
  for (const filename of ['eas-build.yml', 'eas-update.yml', 'eas-testflight.yml']) {
    const source = readFileSync(resolve(__dirname, `../.github/workflows/${filename}`), 'utf8');
    assert.doesNotMatch(source, /VERIFY_PASSENGER_LOGIN_(?:USE|REQUIRE)_APPCHECK[^\n]*\|\|\s*'false'/);
    assert.match(source, /LLT_REQUIRE_PRODUCTION_APPCHECK:\s*'true'/);
  }
});

test('validateExpoPublicEnv rejects placeholder optional support phone numbers', () => {
  const result = validateExpoPublicEnv(
    {
      ...validEnv,
      EXPO_PUBLIC_SUPPORT_PHONE: '+441234567890',
    },
    { platform: 'all' }
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('EXPO_PUBLIC_SUPPORT_PHONE')));
});

test('validateExpoPublicEnv rejects verifier URLs pasted into the wrong login slot', () => {
  const result = validateExpoPublicEnv(
    {
      ...validEnv,
      EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL: 'https://europe-west1-demo.cloudfunctions.net/verifyDriverLogin',
      EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL: 'https://europe-west1-demo.cloudfunctions.net/verifyPassengerLogin',
    },
    { platform: 'all' }
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL')));
  assert.ok(result.errors.some((error) => error.includes('EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL')));
});

test('CLI validation loads Expo-compatible .env.local values without printing secrets', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'llt-expo-env-'));
  const secretApiKey = validEnv.EXPO_PUBLIC_FIREBASE_API_KEY;

  try {
    writeFileSync(
      join(projectRoot, '.env.local'),
      `${Object.entries(validEnv)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')}\n`,
      'utf8'
    );

    const childEnv = { ...process.env, NODE_ENV: 'development' };
    delete childEnv.__EXPO_ENV;

    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, '../scripts/validateExpoPublicEnv.js'), '--platform=all'],
      { cwd: projectRoot, encoding: 'utf8', env: childEnv }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /validation passed for platform "all"/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretApiKey));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('EAS pre-install validation works before @expo/env is installed', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'llt-eas-preinstall-'));
  const isolatedValidator = join(projectRoot, 'validateExpoPublicEnv.js');

  try {
    copyFileSync(resolve(__dirname, '../scripts/validateExpoPublicEnv.js'), isolatedValidator);
    const childEnv = { ...process.env, ...validEnv, NODE_ENV: 'production' };
    delete childEnv.NODE_PATH;
    delete childEnv.__EXPO_ENV;

    const result = spawnSync(
      process.execPath,
      [isolatedValidator, '--platform=ios'],
      { cwd: projectRoot, encoding: 'utf8', env: childEnv }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /validation passed for platform "ios"/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Cannot find module '@expo\/env'/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
