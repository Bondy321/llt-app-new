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
  }

  const gate = read('scripts/verifyCiRunForSha.js');
  assert.match(gate, /workflows\/\$\{WORKFLOW_FILE\}\/runs\?head_sha=\$\{sha\}/u);
  assert.match(gate, /run\.head_sha === sha && run\.conclusion === 'success'/u);

  const testflight = read('.github/workflows/eas-testflight.yml');
  assert.match(testflight, /Selected EAS build belongs to/u);
  assert.match(testflight, /builtSha !== releaseSha/u);
});
