'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('the native graph has the next appVersion compatibility identity from one canonical source', () => {
  const packageJson = JSON.parse(read('package.json'));
  const appConfigSource = read('app.config.js');

  assert.equal(packageJson.version, '1.0.5');
  assert.match(appConfigSource, /require\(['"]\.\/package\.json['"]\)/u);
  assert.doesNotMatch(appConfigSource, /version:\s*['"]1\.0\.\d+['"]/u);
});

test('all local update commands use the centralized profile-aware release helper', () => {
  const packageJson = JSON.parse(read('package.json'));

  for (const [scriptName, target] of [
    ['update:dev', 'development'],
    ['update:preview', 'preview'],
    ['update:testflight', 'testflight'],
    ['update:prod', 'production'],
  ]) {
    assert.match(packageJson.scripts[scriptName] || '', /node scripts\/release\/runEasUpdate\.js/u);
    assert.match(packageJson.scripts[scriptName], new RegExp(`--target=${target}`));
  }
});

test('the TestFlight OTA workflow has an explicit profile and a no-op planning gate', () => {
  const source = read('.github/workflows/eas-update.yml');

  assert.match(source, /EAS_BUILD_PROFILE:\s*testflight/u);
  assert.match(source, /plan-update:/u);
  assert.match(source, /needs\.plan-update\.outputs\.should_publish/u);
  assert.match(source, /npm run update:testflight/u);
});

test('release workflows and eas.json use one exact EAS CLI version without a floating Expo CLI', () => {
  const eas = JSON.parse(read('eas.json'));
  assert.equal(eas.cli.version, '22.6.0');

  for (const workflow of ['eas-update.yml', 'eas-build.yml', 'eas-testflight.yml']) {
    const source = read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(source, /expo-version:\s*latest/u, workflow);
    assert.doesNotMatch(source, /eas-version:\s*latest/u, workflow);
    assert.match(source, /eas-version:\s*22\.6\.0/u, workflow);
  }
});

test('normal CI runs native compatibility and Expo profile parity checks', () => {
  const source = read('.github/workflows/ci.yml');
  assert.match(source, /npm run release:compatibility:check/u);
  assert.match(source, /npm run release:config:check/u);
});
