'use strict';

const KNOWN_MOBILE_FILES = new Set([
  'App.js',
  'app.config.js',
  'babel.config.js',
  'eas.json',
  'firebase.js',
  'index.js',
  'metro.config.js',
  'theme.js',
]);
const PACKAGE_FILES = new Set(['package-lock.json', 'package.json']);
const KNOWN_MOBILE_PREFIXES = [
  'assets/',
  'components/',
  'hooks/',
  'plugins/',
  'screens/',
  'services/',
  'src/',
  'utils/',
];
const KNOWN_NON_BUNDLE_PREFIXES = [
  '.github/',
  'contracts/',
  'docs/',
  'functions/',
  'scripts/',
  'tests/',
  'web-admin/',
];
const KNOWN_NON_BUNDLE_FILES = new Set([
  '.dependency-cruiser.cjs',
  '.firebaserc',
  '.gitignore',
  'database.rules.json',
  'eslint.config.mjs',
  'firebase.json',
  'storage_rules.json',
  'tsconfig.architecture.json',
]);

const normalizePath = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');

const classifyChangedPath = (input) => {
  const fileName = normalizePath(input);
  if (PACKAGE_FILES.has(fileName)) return 'package-manifest';
  if (KNOWN_MOBILE_FILES.has(fileName) || KNOWN_MOBILE_PREFIXES.some((prefix) => fileName.startsWith(prefix))) {
    return 'mobile-bundle';
  }
  if (
    KNOWN_NON_BUNDLE_FILES.has(fileName)
    || KNOWN_NON_BUNDLE_PREFIXES.some((prefix) => fileName.startsWith(prefix))
    || /^[^/]+\.md$/iu.test(fileName)
  ) {
    return 'non-bundle';
  }
  return 'unknown';
};

const createUpdatePlan = ({
  eventName,
  changedPaths = [],
  nativeChanged = false,
  changeSetKnown = true,
  packageChange,
} = {}) => {
  if (eventName === 'workflow_dispatch') {
    return {
      shouldPublish: true,
      reason: 'manual-dispatch',
      bundleChanged: true,
      nativeChanged: Boolean(nativeChanged),
      unknownPaths: [],
    };
  }
  if (!changeSetKnown) {
    return {
      shouldPublish: false,
      reason: 'unknown-change-set-manual-required',
      bundleChanged: false,
      nativeChanged: Boolean(nativeChanged),
      unknownPaths: [],
    };
  }

  const classified = changedPaths.map((fileName) => ({ fileName: normalizePath(fileName), type: classifyChangedPath(fileName) }));
  const packagePaths = classified.filter(({ type }) => type === 'package-manifest').map(({ fileName }) => fileName);
  const packageType = packagePaths.length === 0 ? 'non-bundle' : packageChange?.type || 'unknown';
  const unknownPaths = classified
    .filter(({ type }) => type === 'unknown')
    .map(({ fileName }) => fileName)
    .concat(packageType === 'unknown' ? packagePaths : []);
  const bundleChanged = classified.some(({ type }) => type === 'mobile-bundle') || packageType === 'mobile-bundle';
  if (unknownPaths.length > 0) {
    return {
      shouldPublish: false,
      reason: packageType === 'unknown' && packagePaths.length > 0
        ? 'unknown-package-change-manual-required'
        : 'unknown-path-manual-required',
      bundleChanged,
      nativeChanged: Boolean(nativeChanged),
      unknownPaths,
    };
  }
  if (nativeChanged || packageType === 'native') {
    return {
      shouldPublish: false,
      reason: 'native-change-binary-required',
      bundleChanged,
      nativeChanged: true,
      unknownPaths,
    };
  }
  if (!bundleChanged) {
    return {
      shouldPublish: false,
      reason: 'no-mobile-bundle-change',
      bundleChanged: false,
      nativeChanged: false,
      unknownPaths,
    };
  }
  return {
    shouldPublish: true,
    reason: 'mobile-bundle-change',
    bundleChanged: true,
    nativeChanged: false,
    unknownPaths,
  };
};

module.exports = { classifyChangedPath, createUpdatePlan };
