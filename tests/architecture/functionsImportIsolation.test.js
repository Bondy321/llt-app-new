'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');

const inspectFunctionImport = (modulePath) => {
  const script = `
    process.env.NODE_ENV = 'test';
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: 'demo-llt-import-isolation',
      storageBucket: 'demo-bucket.appspot.com'
    });
    const startedAt = process.hrtime.bigint();
    const loadedModule = require(${JSON.stringify(modulePath)});
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const cachedModules = Object.keys(require.cache).map((entry) => entry.replaceAll('\\\\', '/'));
    process.stdout.write(JSON.stringify({
      elapsedMilliseconds,
      exportNames: Object.keys(loadedModule).sort(),
      loadedExpo: cachedModules.some((entry) => entry.includes('/expo-server-sdk/')),
      loadedSharp: cachedModules.some((entry) => entry.includes('/sharp/'))
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

test('Functions composition import does not eagerly initialize heavyweight optional libraries', () => {
  const result = inspectFunctionImport('./functions/index.js');

  assert.equal(result.loadedExpo, false);
  assert.equal(result.loadedSharp, false);
  assert.ok(result.exportNames.includes('sendChatNotification'));
  assert.ok(result.exportNames.includes('generatePhotoVariants'));
  assert.ok(Number.isFinite(result.elapsedMilliseconds));
});

test('ordinary session infrastructure remains independent of media and notification SDKs', () => {
  const result = inspectFunctionImport('./functions/lib/appSession.js');

  assert.equal(result.loadedExpo, false);
  assert.equal(result.loadedSharp, false);
});
