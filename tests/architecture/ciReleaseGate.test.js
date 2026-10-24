'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('CI defines every required non-release verification job', () => {
  const source = read('.github/workflows/ci.yml');
  for (const requiredName of [
    'Architecture & contracts',
    'Mobile tests',
    'Functions tests (Node 22)',
    'Firebase rules',
    'Web administration',
    'Security audit',
  ]) {
    assert.match(source, new RegExp(`name: ${requiredName.replace(/[&()]/gu, '\\$&')}`));
  }
  assert.match(
    source,
    /npm run (?:test:architecture|verify:refactor)/u,
    'Architecture & contracts must run the architecture regression suite',
  );
  const architectureJob = source.slice(
    source.indexOf('  architecture-contracts:'),
    source.indexOf('  mobile-tests:'),
  );
  assert.match(
    architectureJob,
    /npm --prefix functions ci/u,
    'Architecture & contracts must install the Function modules loaded by compatibility tests',
  );
  assert.doesNotMatch(source, /eas\s+(?:update|build|submit)/u);
});

test('the normal root test path includes architecture regressions', () => {
  const packageJson = JSON.parse(read('package.json'));
  const normalTestPath = [
    packageJson.scripts.test,
    packageJson.scripts['test:all'],
    packageJson.scripts['test:all:fast'],
    packageJson.scripts['test:all:full'],
  ].join('\n');
  assert.match(normalTestPath, /test:architecture/u);
});

test('every production release workflow requires successful CI for its exact SHA', () => {
  for (const workflow of ['eas-update.yml', 'eas-build.yml', 'eas-testflight.yml']) {
    const source = read(`.github/workflows/${workflow}`);
    assert.match(source, /actions: read/u, workflow);
    assert.match(source, /node scripts\/verifyCiRunForSha\.js --sha=\$\{\{ github\.sha \}\}/u, workflow);
    assert.match(source, /npm install --global eas-cli@22\.6\.0/u, workflow);
    assert.match(source, /node scripts\/release\/checkCliVersions\.js --check-eas/u, workflow);
    assert.doesNotMatch(source, /(?:expo|eas)-version:\s*latest/u, workflow);
  }

  const gate = read('scripts/verifyCiRunForSha.js');
  assert.match(gate, /workflows\/\$\{WORKFLOW_FILE\}\/runs\?head_sha=\$\{sha\}/u);
  assert.match(gate, /run\.head_sha === sha && run\.conclusion === 'success'/u);

  const testflight = read('.github/workflows/eas-testflight.yml');
  assert.match(testflight, /node scripts\/release\/verifyTestFlightBuild\.js eas-selected-build\.json/u);
  const artifactGate = read('scripts/release/verifyTestFlightBuild.js');
  assert.match(artifactGate, /build\.gitCommitHash === releaseSha/u);
  assert.match(artifactGate, /build\.status === 'FINISHED'/u);
  assert.match(artifactGate, /build\.buildProfile === 'testflight'/u);
});

test('CI enforces native compatibility and resolved Expo profile parity against the exact change', () => {
  const source = read('.github/workflows/ci.yml');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(source, /'\+refs\/heads\/\*:refs\/remotes\/origin\/\*' '\+refs\/tags\/\*:refs\/tags\/\*' "\$GITHUB_SHA"/u);
  assert.doesNotMatch(source, /--depth[ =]|--shallow/u);
  assert.match(source, /git checkout --detach "\$GITHUB_SHA"/u);
  assert.match(source, /LLT_RELEASE_BASE_SHA/u);
  assert.match(source, /LLT_RELEASE_HEAD_SHA:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(source, /npm run release:compatibility:check/u);
  assert.match(source, /npm run release:config:check/u);
  assert.match(packageJson.scripts['release:compatibility:check'], /checkNativeCompatibility\.js/u);
  assert.match(packageJson.scripts['release:config:check'], /checkExpoConfigParity\.js/u);
});

test('native release workflows clean-install the web SDK before real rules integration tests', () => {
  for (const workflow of ['eas-build.yml', 'eas-testflight.yml']) {
    const source = read(`.github/workflows/${workflow}`);
    const buildJob = source.split(/\n  submit-testflight:/u)[0];
    const install = buildJob.indexOf('run: npm --prefix web-admin ci');
    const rulesTest = buildJob.indexOf('run: npm run test:emulators');
    assert.ok(install >= 0 && rulesTest > install, `${workflow}: install the real web SDK before rules tests`);
    assert.match(buildJob, /uses: \.\/\.github\/actions\/verified-node/u, workflow);
    assert.doesNotMatch(buildJob, /uses: actions\/|uses: \.\/\.github\/actions\/runtime-trust/u, workflow);
    if (workflow === 'eas-testflight.yml') {
      assert.match(buildJob, /name: Install web admin dependencies for integration tests\s+if: \$\{\{ !inputs\.eas_build_id \}\}\s+run: npm --prefix web-admin ci/u);
    }
  }
});

test('automatic OTA planning happens before the production environment and preserves manual dispatch', () => {
  const source = read('.github/workflows/eas-update.yml');
  const planIndex = source.indexOf('  plan-update:');
  const publishIndex = source.indexOf('  publish-testflight-update:');

  assert.match(source, /workflow_dispatch:/u);
  assert.ok(planIndex >= 0 && publishIndex > planIndex);
  assert.match(source, /needs:\s*plan-update/u);
  assert.match(source, /needs\.plan-update\.outputs\.should_publish/u);
  assert.match(source, /scripts\/release\/planEasUpdate\.js/u);
  assert.match(source, /npm run update:testflight/u);
});
