'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildNativeSnapshot,
  buildNativeSnapshotFromFiles,
  compareNativeSnapshots,
} = require('../../scripts/release/nativeCompatibility');

const PREVIOUS_1_0_4_RELEASE_COMMIT = '31d6a7337758c66cb3fc3e761c9585e4de1abba4';

const makeFiles = ({
  version = '1.0.4',
  expoVersion = '55.0.28',
  plugin = 'module.exports = (config) => config;\n',
  screen = 'module.exports = 1;\n',
  nativeFiles = {},
  localPlugin = null,
} = {}) => ({
  'package.json': JSON.stringify({
    name: 'fixture',
    version,
    dependencies: { expo: expoVersion, 'expo-updates': '55.0.26' },
  }),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version, dependencies: { expo: expoVersion, 'expo-updates': '55.0.26' } },
      'node_modules/expo': { version: expoVersion },
      'node_modules/expo-updates': { version: '55.0.26' },
      'node_modules/test-only': { version: '1.0.0', dev: true },
    },
  }),
  'app.config.js': `module.exports={expo:{version:require('./package.json').version,plugins:['./plugins/nativePlugin'${localPlugin ? ",'./custom/nativePlugin'" : ''}],runtimeVersion:{policy:'appVersion'}}};\n`,
  'eas.json': JSON.stringify({ cli: { appVersionSource: 'remote' }, build: { production: { channel: 'production' } } }),
  'plugins/nativePlugin.js': plugin,
  'screens/Home.js': screen,
  ...(localPlugin === null ? {} : { 'custom/nativePlugin.js': localPlugin }),
  ...nativeFiles,
});

test('the previous 1.0.4 native input and current graph have distinct compatibility identities', () => {
  const previous = buildNativeSnapshotFromFiles(makeFiles());
  const current = buildNativeSnapshotFromFiles(makeFiles({ version: '1.0.5', expoVersion: '55.0.30' }));
  const comparison = compareNativeSnapshots(previous, current);

  assert.equal(comparison.nativeChanged, true);
  assert.equal(comparison.runtimeChanged, true);
  assert.equal(previous.runtimeIdentity, 'appVersion:1.0.4');
  assert.equal(current.runtimeIdentity, 'appVersion:1.0.5');
});

test('the repository 1.0.4 release graph and prepared 1.0.5 graph are actually distinct', () => {
  const previous = buildNativeSnapshot(PREVIOUS_1_0_4_RELEASE_COMMIT);
  const current = buildNativeSnapshot('WORKTREE');

  assert.equal(previous.runtimeIdentity, 'appVersion:1.0.4');
  assert.equal(current.runtimeIdentity, 'appVersion:1.0.5');
  assert.notEqual(previous.nativeDigest, current.nativeDigest);
  assert.doesNotThrow(() => compareNativeSnapshots(previous, current));
});

test('a native dependency change without a runtime identity change fails actionably', () => {
  const previous = buildNativeSnapshotFromFiles(makeFiles());
  const unsafe = buildNativeSnapshotFromFiles(makeFiles({ expoVersion: '55.0.30' }));

  assert.throws(
    () => compareNativeSnapshots(previous, unsafe),
    (error) => error.code === 'NATIVE_RUNTIME_IDENTITY_REQUIRED'
      && /packageNativeGraph/u.test(error.message)
      && /Bump package\.json version from 1\.0\.4/u.test(error.message),
  );
});

test('a JavaScript-only source change does not require a new runtime identity', () => {
  const previous = buildNativeSnapshotFromFiles(makeFiles());
  const javascriptOnly = buildNativeSnapshotFromFiles(makeFiles({ screen: 'module.exports = 2;\n' }));

  assert.deepEqual(compareNativeSnapshots(previous, javascriptOnly).changedCategories, []);
});

test('a known pure-JavaScript production dependency does not change native compatibility', () => {
  const previousFiles = makeFiles();
  const changedFiles = makeFiles();
  const previousPackage = JSON.parse(previousFiles['package.json']);
  const changedPackage = JSON.parse(changedFiles['package.json']);
  const previousLock = JSON.parse(previousFiles['package-lock.json']);
  const changedLock = JSON.parse(changedFiles['package-lock.json']);
  previousPackage.dependencies.firebase = '12.0.0';
  changedPackage.dependencies.firebase = '12.1.0';
  previousLock.packages[''].dependencies.firebase = '12.0.0';
  changedLock.packages[''].dependencies.firebase = '12.1.0';
  previousLock.packages['node_modules/firebase'] = { version: '12.0.0' };
  changedLock.packages['node_modules/firebase'] = { version: '12.1.0' };
  previousFiles['package.json'] = JSON.stringify(previousPackage);
  changedFiles['package.json'] = JSON.stringify(changedPackage);
  previousFiles['package-lock.json'] = JSON.stringify(previousLock);
  changedFiles['package-lock.json'] = JSON.stringify(changedLock);

  const previous = buildNativeSnapshotFromFiles(previousFiles);
  const changed = buildNativeSnapshotFromFiles(changedFiles);

  assert.deepEqual(compareNativeSnapshots(previous, changed).changedCategories, []);
});

test('custom config-plugin and dynamically discovered native-project changes require a new runtime', () => {
  const previous = buildNativeSnapshotFromFiles(makeFiles());
  const pluginChange = buildNativeSnapshotFromFiles(makeFiles({ plugin: 'module.exports = (config) => ({...config});\n' }));
  const androidChange = buildNativeSnapshotFromFiles(makeFiles({
    nativeFiles: { 'android/app/src/main/AndroidManifest.xml': '<manifest />' },
  }));

  assert.throws(() => compareNativeSnapshots(previous, pluginChange), /configPlugins/u);
  assert.throws(() => compareNativeSnapshots(previous, androidChange), /nativeProjects/u);
});

test('a relative config plugin outside the conventional plugins directory is covered dynamically', () => {
  const previous = buildNativeSnapshotFromFiles(makeFiles({ localPlugin: 'module.exports = (config) => config;\n' }));
  const changed = buildNativeSnapshotFromFiles(makeFiles({ localPlugin: 'module.exports = (config) => ({ ...config });\n' }));

  assert.throws(() => compareNativeSnapshots(previous, changed), /configReferencedFiles/u);
});
