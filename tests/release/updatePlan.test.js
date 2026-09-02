'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyPackageChange } = require('../../scripts/release/packageChange');
const { classifyChangedPath, createUpdatePlan } = require('../../scripts/release/updatePlan');

const basePackage = () => ({
  name: 'fixture',
  version: '1.0.0',
  main: 'index.js',
  scripts: {
    start: 'expo start',
    test: 'node --test',
  },
  dependencies: {
    expo: '55.0.0',
    firebase: '12.0.0',
  },
  devDependencies: {
    eslint: '9.0.0',
  },
});

const baseLock = () => ({
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': {
      name: 'fixture',
      version: '1.0.0',
      dependencies: { expo: '55.0.0', firebase: '12.0.0' },
      devDependencies: { eslint: '9.0.0' },
    },
    'node_modules/eslint': { version: '9.0.0', dev: true },
    'node_modules/expo': { version: '55.0.0' },
    'node_modules/firebase': { version: '12.0.0' },
  },
});

const packagePlan = ({ base = basePackage(), head, basePackageLock = baseLock(), headPackageLock = basePackageLock, changedPaths = ['package.json'] }) => {
  const packageChange = classifyPackageChange({
    changedPaths,
    basePackageJson: base,
    headPackageJson: head,
    basePackageLock,
    headPackageLock,
  });
  return createUpdatePlan({ eventName: 'push', changedPaths, packageChange });
};

test('main pushes with only known non-bundle paths are deterministic no-ops', () => {
  const plan = createUpdatePlan({
    eventName: 'push',
    changedPaths: ['docs/release.md', 'functions/src/index.js', 'web-admin/src/App.jsx', 'database.rules.json'],
  });
  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'no-mobile-bundle-change');
});

test('a JavaScript mobile bundle change is eligible for automatic TestFlight OTA', () => {
  const plan = createUpdatePlan({ eventName: 'push', changedPaths: ['screens/TourHomeScreen.js'] });
  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'mobile-bundle-change');
});

test('native and unknown changes default to a manual release boundary', () => {
  const nativePlan = createUpdatePlan({
    eventName: 'push',
    changedPaths: ['app.config.js'],
    nativeChanged: true,
  });
  const unknownPlan = createUpdatePlan({ eventName: 'push', changedPaths: ['new-runtime-input.xyz'] });

  assert.equal(nativePlan.shouldPublish, false);
  assert.equal(nativePlan.reason, 'native-change-binary-required');
  assert.equal(unknownPlan.shouldPublish, false);
  assert.equal(unknownPlan.reason, 'unknown-path-manual-required');
  assert.equal(classifyChangedPath('new-runtime-input.xyz'), 'unknown');
});

test('workflow dispatch remains explicit and available even without a diff base', () => {
  const plan = createUpdatePlan({ eventName: 'workflow_dispatch', changeSetKnown: false, nativeChanged: true });
  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'manual-dispatch');
});

test('a test-script-only package change is a deterministic no-op', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.scripts.test = 'node --test tests/**/*.test.js';

  const plan = packagePlan({ base, head });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'no-mobile-bundle-change');
});

test('a development-tool dependency and matching lock update are a deterministic no-op', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.devDependencies.eslint = '9.1.0';
  const oldLock = baseLock();
  const newLock = structuredClone(oldLock);
  newLock.packages[''].devDependencies.eslint = '9.1.0';
  newLock.packages['node_modules/eslint'].version = '9.1.0';

  const plan = packagePlan({
    base,
    head,
    basePackageLock: oldLock,
    headPackageLock: newLock,
    changedPaths: ['package.json', 'package-lock.json'],
  });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'no-mobile-bundle-change');
});

test('Functions operational script changes remain outside the mobile bundle', () => {
  const plan = createUpdatePlan({
    eventName: 'push',
    changedPaths: ['functions/package.json', 'functions/scripts/notificationRetentionRun.js'],
  });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'no-mobile-bundle-change');
});

test('a mobile runtime script change is eligible for OTA publication', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.scripts.start = 'expo start --clear';

  const plan = packagePlan({ base, head });

  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'mobile-bundle-change');
});

test('a pure-JavaScript production dependency and matching lock update are eligible for OTA', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.dependencies.firebase = '12.1.0';
  const oldLock = baseLock();
  const newLock = structuredClone(oldLock);
  newLock.packages[''].dependencies.firebase = '12.1.0';
  newLock.packages['node_modules/firebase'].version = '12.1.0';

  const plan = packagePlan({
    base,
    head,
    basePackageLock: oldLock,
    headPackageLock: newLock,
    changedPaths: ['package.json', 'package-lock.json'],
  });

  assert.equal(plan.shouldPublish, true);
  assert.equal(plan.reason, 'mobile-bundle-change');
});

test('a pure-JavaScript direct update with a native transitive lock change requires a binary', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.dependencies.firebase = '12.1.0';
  const oldLock = baseLock();
  const newLock = structuredClone(oldLock);
  newLock.packages[''].dependencies.firebase = '12.1.0';
  newLock.packages['node_modules/firebase'].version = '12.1.0';
  newLock.packages['node_modules/expo-transitive-runtime'] = { version: '1.0.0' };

  const plan = packagePlan({
    base,
    head,
    basePackageLock: oldLock,
    headPackageLock: newLock,
    changedPaths: ['package.json', 'package-lock.json'],
  });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'native-change-binary-required');
});

test('a pure-JavaScript direct update with an unknown transitive lock change fails closed', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.dependencies.firebase = '12.1.0';
  const oldLock = baseLock();
  const newLock = structuredClone(oldLock);
  newLock.packages[''].dependencies.firebase = '12.1.0';
  newLock.packages['node_modules/firebase'].version = '12.1.0';
  newLock.packages['node_modules/unclassified-transitive'] = { version: '1.0.0' };

  const plan = packagePlan({
    base,
    head,
    basePackageLock: oldLock,
    headPackageLock: newLock,
    changedPaths: ['package.json', 'package-lock.json'],
  });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'unknown-package-change-manual-required');
});

test('a native production dependency change requires a binary release', () => {
  const base = basePackage();
  const head = structuredClone(base);
  head.dependencies.expo = '55.0.1';

  const plan = packagePlan({ base, head });

  assert.equal(plan.shouldPublish, false);
  assert.equal(plan.reason, 'native-change-binary-required');
  assert.equal(plan.nativeChanged, true);
});

test('unknown package fields, scripts, dependencies, and unexplained production lock changes fail closed', async (t) => {
  const cases = [
    ['field', (head) => { head.customRuntime = true; }, ['package.json']],
    ['script', (head) => { head.scripts.prepareRuntime = 'node prepare.js'; }, ['package.json']],
    ['dependency', (head) => { head.dependencies['unclassified-runtime'] = '1.0.0'; }, ['package.json']],
    ['lock', (_head, lock) => { lock.packages['node_modules/unclassified-runtime'] = { version: '1.0.0' }; }, ['package-lock.json']],
  ];

  for (const [name, mutate, changedPaths] of cases) {
    await t.test(name, () => {
      const base = basePackage();
      const head = structuredClone(base);
      const oldLock = baseLock();
      const newLock = structuredClone(oldLock);
      mutate(head, newLock);
      const plan = packagePlan({
        base,
        head,
        basePackageLock: oldLock,
        headPackageLock: newLock,
        changedPaths,
      });

      assert.equal(plan.shouldPublish, false);
      assert.equal(plan.reason, 'unknown-package-change-manual-required');
    });
  }
});
