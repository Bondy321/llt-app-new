'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const semver = require('semver');
const root = path.resolve(__dirname, '../..');
const consumers = [
  ['Firebase CLI', require.resolve('firebase-tools/package.json'), 6],
  ['node-gyp', require.resolve('node-gyp/package.json'), 8],
  ['admin jsdom', path.join(root, 'web-admin/node_modules/jsdom/package.json'), 7],
];

test('all installed Undici copies keep their consumer major and use patched locked versions', () => {
  const minimum = { 6: '6.29.1', 7: '7.30.1', 8: '8.12.2' };
  let copies = 0;
  for (const directory of [root, path.join(root, 'functions'), path.join(root, 'web-admin')]) {
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location.endsWith('/node_modules/undici') && location !== 'node_modules/undici') continue;
      copies++;
      assert.equal(require(path.join(directory, location, 'package.json')).version, entry.version);
      const patched = minimum[semver.major(entry.version)];
      assert.ok(patched && semver.gte(entry.version, patched), `${directory}/${location} is vulnerable`);
    }
  }
  assert.ok(copies >= 3);
  for (const [label, consumer, major] of consumers) {
    assert.equal(semver.major(createRequire(consumer)('undici/package.json').version), major, label);
  }
  assert.ok(semver.satisfies(process.versions.undici, '^6.29.1 || ^7.30.1 || ^8.12.2'),
    'Node bundled fetch must also be patched; npm overrides cannot replace it');
});

for (const [label, consumer] of consumers) {
  for (const mode of ['encoding-crash', 'tls-callback', 'consumer']) {
    test(`${label}: ${mode} regression uses its actual resolved Undici`, () => {
      // No uncaughtException handler: the historical process crash must fail this child.
      const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/undiciBoundary.cjs'), consumer, mode], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      assert.equal(result.error, undefined, `${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }
}

test('admin hooks lint retains valid React code and rejects conditional hooks with patched Zod', async () => {
  const adminRequire = createRequire(path.join(root, 'web-admin/package.json'));
  const { ESLint } = adminRequire('eslint');
  const hooks = adminRequire('eslint-plugin-react-hooks');
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/config': 'error' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  }] });
  const valid = await eslint.lintText('import {useState} from "react"; export function App(){const [x]=useState(0); return x;}');
  assert.equal(valid[0].errorCount, 0);
  const invalid = await eslint.lintText('import {useState} from "react"; export function App({on}){if(on){useState(0);} return null;}');
  assert.ok(invalid[0].messages.some(message => message.ruleId === 'react-hooks/rules-of-hooks'));
});
