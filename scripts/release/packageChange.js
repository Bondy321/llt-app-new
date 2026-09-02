'use strict';

const PACKAGE_PATHS = new Set(['package.json', 'package-lock.json']);

const MOBILE_RUNTIME_SCRIPTS = new Set([
  'android',
  'android:dev',
  'ios',
  'ios:dev',
  'start',
  'start:dev',
  'web',
]);

const NON_BUNDLE_SCRIPT_PATTERN = /^(?:architecture|build|contracts|deploy|eas-|efficiency|lint|release|security|sync|test|typecheck|update|validate|verify)(?::|$)/u;

const PURE_JS_PRODUCTION_DEPENDENCIES = new Set([
  '@expo/vector-icons',
  'babel-preset-expo',
  'firebase',
  'react',
  'react-dom',
  'react-native-web',
]);

const NATIVE_DEPENDENCY_PATTERNS = [
  /^expo$/u,
  /^expo-/u,
  /^react-native$/u,
  /^react-native-/u,
  /^@react-native(?:-[^/]+)?\//u,
];

const normalizePath = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
};

const stableStringify = (value) => JSON.stringify(sortValue(value));
const valuesEqual = (left, right) => stableStringify(left) === stableStringify(right);

const parseJsonInput = (value, label) => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};

const changedKeys = (base = {}, head = {}) => [...new Set([
  ...Object.keys(base || {}),
  ...Object.keys(head || {}),
])].filter((key) => !valuesEqual(base?.[key], head?.[key])).sort();

const classifyProductionDependency = (name) => {
  if (PURE_JS_PRODUCTION_DEPENDENCIES.has(name) || /^@firebase\//u.test(name)) return 'pure-js';
  if (NATIVE_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(name))) return 'native';
  return 'unknown';
};

const packageNameFromLockPath = (packagePath, metadata = {}) => {
  if (typeof metadata.name === 'string' && metadata.name) return metadata.name;
  const suffix = String(packagePath).split('/node_modules/').at(-1)
    .replace(/^node_modules\//u, '');
  const segments = suffix.split('/');
  return segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

const classifyScriptChanges = (baseScripts, headScripts) => {
  const scripts = changedKeys(baseScripts, headScripts);
  if (scripts.length === 0) return { type: 'non-bundle', scripts };
  if (scripts.some((name) => !MOBILE_RUNTIME_SCRIPTS.has(name) && !NON_BUNDLE_SCRIPT_PATTERN.test(name))) {
    return { type: 'unknown', scripts };
  }
  return {
    type: scripts.some((name) => MOBILE_RUNTIME_SCRIPTS.has(name)) ? 'mobile-bundle' : 'non-bundle',
    scripts,
  };
};

const classifyDependencyChanges = (basePackage, headPackage) => {
  const names = new Set();
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of changedKeys(basePackage[field], headPackage[field])) names.add(name);
  }
  const dependencies = [...names].sort();
  const classifications = dependencies.map((name) => ({ name, type: classifyProductionDependency(name) }));
  if (classifications.some(({ type }) => type === 'unknown')) {
    return { type: 'unknown', dependencies: classifications };
  }
  if (classifications.some(({ type }) => type === 'native')) {
    return { type: 'native', dependencies: classifications };
  }
  return {
    type: classifications.length > 0 ? 'mobile-bundle' : 'non-bundle',
    dependencies: classifications,
  };
};

const projectProductionLock = (lock) => ({
  name: lock.name,
  version: lock.version,
  lockfileVersion: lock.lockfileVersion,
  requires: lock.requires,
  root: {
    name: lock.packages?.['']?.name,
    version: lock.packages?.['']?.version,
    dependencies: lock.packages?.['']?.dependencies,
    optionalDependencies: lock.packages?.['']?.optionalDependencies,
    peerDependencies: lock.packages?.['']?.peerDependencies,
    bundledDependencies: lock.packages?.['']?.bundledDependencies || lock.packages?.['']?.bundleDependencies,
    overrides: lock.packages?.['']?.overrides,
  },
  packages: Object.fromEntries(
    Object.entries(lock.packages || {})
      .filter(([packagePath, metadata]) => packagePath !== '' && metadata?.dev !== true && metadata?.devOptional !== true)
      .sort(([left], [right]) => left.localeCompare(right)),
  ),
  dependencies: lock.dependencies || undefined,
});

const classifyProductionLockChanges = (baseLock, headLock) => {
  const basePackages = projectProductionLock(baseLock).packages;
  const headPackages = projectProductionLock(headLock).packages;
  const packagePaths = changedKeys(basePackages, headPackages);
  const dependencies = packagePaths.map((packagePath) => {
    const metadata = headPackages[packagePath] || basePackages[packagePath] || {};
    const name = packageNameFromLockPath(packagePath, metadata);
    return { name, packagePath, type: classifyProductionDependency(name) };
  });
  let type = dependencies.length > 0 ? 'mobile-bundle' : 'non-bundle';
  if (dependencies.some((dependency) => dependency.type === 'native')) type = 'native';
  if (dependencies.some((dependency) => dependency.type === 'unknown')) type = 'unknown';
  return { type, dependencies };
};

const mergeTypes = (types) => {
  if (types.includes('unknown')) return 'unknown';
  if (types.includes('native')) return 'native';
  if (types.includes('mobile-bundle')) return 'mobile-bundle';
  return 'non-bundle';
};

const classifyPackageChange = ({
  changedPaths = [],
  basePackageJson,
  headPackageJson,
  basePackageLock,
  headPackageLock,
} = {}) => {
  const normalizedPaths = changedPaths.map(normalizePath);
  const packageJsonChanged = normalizedPaths.includes('package.json');
  const packageLockChanged = normalizedPaths.includes('package-lock.json');
  if (!packageJsonChanged && !packageLockChanged) {
    return { type: 'non-bundle', changedKeys: [], scripts: [], dependencies: [] };
  }

  let basePackage;
  let headPackage;
  let baseLock;
  let headLock;
  try {
    basePackage = parseJsonInput(basePackageJson, 'base package.json');
    headPackage = parseJsonInput(headPackageJson, 'head package.json');
    baseLock = parseJsonInput(basePackageLock, 'base package-lock.json');
    headLock = parseJsonInput(headPackageLock, 'head package-lock.json');
  } catch (error) {
    return {
      type: 'unknown',
      reason: 'invalid-package-json',
      detail: error.message,
      changedKeys: [],
      scripts: [],
      dependencies: [],
    };
  }

  const packageKeys = packageJsonChanged ? changedKeys(basePackage, headPackage) : [];
  const types = [];
  let scriptResult = { type: 'non-bundle', scripts: [] };
  let dependencyResult = { type: 'non-bundle', dependencies: [] };
  let lockResult = { type: 'non-bundle', dependencies: [] };

  if (packageKeys.includes('scripts')) {
    scriptResult = classifyScriptChanges(basePackage.scripts, headPackage.scripts);
    types.push(scriptResult.type);
  }
  if (packageKeys.includes('dependencies') || packageKeys.includes('optionalDependencies')) {
    dependencyResult = classifyDependencyChanges(basePackage, headPackage);
    types.push(dependencyResult.type);
  }

  const nonBundleKeys = new Set([
    'author',
    'description',
    'devDependencies',
    'keywords',
    'license',
    'name',
    'private',
    'repository',
    'scripts',
  ]);
  const mobileBundleKeys = new Set(['browser', 'main']);
  const nativeKeys = new Set(['expo', 'react-native', 'version']);
  const handledKeys = new Set(['dependencies', 'optionalDependencies']);

  for (const key of packageKeys) {
    if (handledKeys.has(key) || key === 'scripts') continue;
    if (nonBundleKeys.has(key)) types.push('non-bundle');
    else if (mobileBundleKeys.has(key)) types.push('mobile-bundle');
    else if (nativeKeys.has(key)) types.push('native');
    else types.push('unknown');
  }

  if (packageLockChanged) {
    const productionLockChanged = !valuesEqual(projectProductionLock(baseLock), projectProductionLock(headLock));
    const manifestExplainsLockChange = packageKeys.some((key) => [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'version',
    ].includes(key));
    lockResult = classifyProductionLockChanges(baseLock, headLock);
    if (lockResult.dependencies.length > 0) types.push(lockResult.type);
    else if (productionLockChanged && !manifestExplainsLockChange) types.push('unknown');
    else types.push('non-bundle');
  }

  return {
    type: mergeTypes(types),
    changedKeys: packageKeys,
    scripts: scriptResult.scripts,
    dependencies: dependencyResult.dependencies,
    lockDependencies: lockResult.dependencies,
  };
};

module.exports = {
  NATIVE_DEPENDENCY_PATTERNS,
  PACKAGE_PATHS,
  PURE_JS_PRODUCTION_DEPENDENCIES,
  classifyPackageChange,
  classifyProductionDependency,
  classifyProductionLockChanges,
};
