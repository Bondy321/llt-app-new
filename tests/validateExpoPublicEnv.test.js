const test = require('node:test');
const assert = require('node:assert/strict');

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
