'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { checkNativeAppCheckConfig } = require('../../scripts/security/checkNativeAppCheckConfig');

test('native build configuration binds project and exact platform app identity', () => {
  const env = { EAS_BUILD_PLATFORM: 'android', EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'demo-llt' };
  const config = { project_info: { project_id: 'demo-llt' }, client: [{ client_info: { mobilesdk_app_id: '1:123:android:abc', android_client_info: { package_name: 'com.lochlomondtravel.tourapp' } } }] };
  assert.equal(checkNativeAppCheckConfig({ env, read: () => JSON.stringify(config) }).checked, true);
  config.project_info.project_id = 'wrong';
  assert.throws(() => checkNativeAppCheckConfig({ env, read: () => JSON.stringify(config) }), /does not match/);
  assert.throws(() => checkNativeAppCheckConfig({ env, read: () => { throw new Error('missing'); } }), /missing/);
});

test('native attestation never installs debug provider or bypass and precedes Firebase services', () => {
  const native = fs.readFileSync('services/appCheckProvider.native.js', 'utf8');
  assert.match(native, /appAttestWithDeviceCheckFallback/);
  assert.match(native, /playIntegrity/);
  assert.doesNotMatch(native, /debugToken|provider: ['"]debug['"]/);
  const firebase = fs.readFileSync('firebase.js', 'utf8');
  assert.ok(firebase.indexOf('initializeFirebaseAppCheck(app.') < firebase.indexOf('db = firebase.firestore()'));
});

test('token expiry parser rejects expired and malformed provider output without logging tokens', async () => {
  const source = fs.readFileSync('services/appCheckToken.js', 'utf8');
  const { tokenWithExpiry } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  assert.equal(tokenWithExpiry(jwt(100), 1000).expireTimeMillis, 100000);
  assert.throws(() => tokenWithExpiry(jwt(1), 2000), /EXPIRED/);
  assert.throws(() => tokenWithExpiry('bad', 1000), /INVALID/);
  assert.throws(() => tokenWithExpiry(jwt('100'), 1000), /EXPIRED/);
  assert.throws(() => tokenWithExpiry(jwt(Number.MAX_SAFE_INTEGER), 1000), /EXPIRED/);
});

test('native expiry decoding works without browser globals and accepts UTF-8 claims', async () => {
  const source = fs.readFileSync('services/appCheckToken.js', 'utf8');
  const vm = require('node:vm');
  const context = vm.createContext({});
  vm.runInContext(`${source.replace('export const tokenWithExpiry', 'const tokenWithExpiry')}\nthis.parse = tokenWithExpiry;`, context);
  assert.equal(vm.runInContext('typeof atob', context), 'undefined');
  assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
  assert.equal(vm.runInContext('typeof TextDecoder', context), 'undefined');
  const token = `header.${Buffer.from(JSON.stringify({ exp: 100, label: 'Loch Lomond \u2013 \u00c9cosse \ud83d\ude8c' })).toString('base64url')}.signature`;
  assert.equal(context.parse(token, 1000).expireTimeMillis, 100000);
  assert.equal(context.parse(token, 1000).token, token);
  for (const payload of ['A', '!!!!', 'eyJleHAiOjEwMH0=', Buffer.from([0xc3, 0x28]).toString('base64url')]) {
    assert.throws(() => context.parse(`header.${payload}.signature`, 1000), /APP_CHECK_TOKEN_INVALID/);
  }
  assert.throws(() => context.parse(`header.${'A'.repeat(16384)}.signature`, 1000), /APP_CHECK_TOKEN_INVALID/);
});
