'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const CORE_INPUTS = ['package.json', 'package-lock.json', 'app.config.js', 'eas.json'];
const TRACKED_NATIVE_PREFIXES = ['plugins/', 'ios/', 'android/'];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const TEXT_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:cjs|gradle|js|json|jsx|m|mm|plist|properties|swift|ts|tsx|xml|yaml|yml)|Podfile)$/iu;

const hashFileContents = (fileName, contents) => {
  if (TEXT_FILE_PATTERN.test(fileName)) {
    return sha256(contents.toString('utf8').replaceAll('\r\n', '\n'));
  }
  return sha256(contents);
};

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
};

const stableStringify = (value) => JSON.stringify(sortValue(value));
const hashValue = (value) => sha256(stableStringify(value));

const normalizeTrackedPath = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');

const parseJsonFile = (files, fileName) => {
  const source = files[fileName];
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) {
    throw new Error(`Native compatibility input ${fileName} is missing.`);
  }
  try {
    return JSON.parse(source.toString('utf8'));
  } catch (error) {
    throw new Error(`Native compatibility input ${fileName} is invalid JSON: ${error.message}`);
  }
};

const extractRuntimePolicy = (source) => {
  const match = String(source || '').match(/runtimeVersion\s*:\s*\{[\s\S]*?policy\s*:\s*['"]([^'"]+)['"]/u);
  return match?.[1] || 'manual-or-unknown';
};

const collectConfigReferences = (source, availablePaths) => {
  const references = new Set();
  const pattern = /['"](\.\.?\/[^'"\r\n]+)['"]/gu;
  for (const match of String(source || '').matchAll(pattern)) {
    const raw = normalizeTrackedPath(match[1]);
    if (!raw || raw.startsWith('../')) continue;
    const candidates = [raw, `${raw}.js`, `${raw}.cjs`, `${raw}.mjs`, `${raw}.json`];
    for (const candidate of candidates) {
      if (availablePaths.has(candidate)) references.add(candidate);
    }
    for (const candidate of availablePaths) {
      if (candidate.startsWith(`${raw}/`)) references.add(candidate);
    }
  }
  return [...references].sort();
};

const projectProductionPackageGraph = (packageJson, packageLock) => {
  const root = {
    dependencies: packageJson.dependencies || {},
    optionalDependencies: packageJson.optionalDependencies || {},
    bundledDependencies: packageJson.bundledDependencies || packageJson.bundleDependencies || [],
    overrides: packageJson.overrides || {},
    expo: packageJson.expo || {},
    reactNative: packageJson['react-native'] || {},
  };
  const packages = Object.fromEntries(
    Object.entries(packageLock.packages || {})
      .filter(([packagePath, metadata]) => packagePath !== '' && metadata?.dev !== true && metadata?.devOptional !== true)
      .map(([packagePath, metadata]) => [packagePath, metadata]),
  );
  return { root, packages };
};

const projectEasNativeBuildConfig = (eas) => ({
  appVersionSource: eas.cli?.appVersionSource || null,
  build: eas.build || {},
});

const hashSelectedFiles = (files, predicate) => Object.fromEntries(
  Object.keys(files)
    .filter(predicate)
    .sort()
    .map((fileName) => [fileName, hashFileContents(fileName, files[fileName])]),
);

const buildNativeSnapshotFromFiles = (filesInput) => {
  const files = Object.fromEntries(
    Object.entries(filesInput).map(([fileName, contents]) => [normalizeTrackedPath(fileName), contents]),
  );
  const packageJson = parseJsonFile(files, 'package.json');
  const packageLock = parseJsonFile(files, 'package-lock.json');
  const eas = parseJsonFile(files, 'eas.json');
  const appConfigSource = files['app.config.js'];
  if (typeof appConfigSource !== 'string' && !Buffer.isBuffer(appConfigSource)) {
    throw new Error('Native compatibility input app.config.js is missing.');
  }

  const availablePaths = new Set(Object.keys(files));
  const configReferences = new Set(
    collectConfigReferences(appConfigSource, availablePaths).filter((fileName) => !CORE_INPUTS.includes(fileName)),
  );
  const categories = {
    packageNativeGraph: hashValue(projectProductionPackageGraph(packageJson, packageLock)),
    appConfig: hashFileContents('app.config.js', appConfigSource),
    easNativeBuildConfig: hashValue(projectEasNativeBuildConfig(eas)),
    configPlugins: hashValue(hashSelectedFiles(files, (fileName) => fileName.startsWith('plugins/'))),
    nativeProjects: hashValue(hashSelectedFiles(
      files,
      (fileName) => fileName.startsWith('ios/') || fileName.startsWith('android/'),
    )),
    configReferencedFiles: hashValue(hashSelectedFiles(files, (fileName) => configReferences.has(fileName))),
  };
  const runtimePolicy = extractRuntimePolicy(appConfigSource.toString('utf8'));
  const version = String(packageJson.version || '');
  const runtimeIdentity = runtimePolicy === 'appVersion'
    ? `appVersion:${version}`
    : `${runtimePolicy}:${version || 'unversioned'}`;

  return {
    version,
    runtimePolicy,
    runtimeIdentity,
    nativeDigest: hashValue(categories),
    categories,
  };
};

const listGitFiles = (ref) => execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', ref],
  { cwd: ROOT, encoding: 'utf8' },
).split(/\r?\n/u).map(normalizeTrackedPath).filter(Boolean);

const readGitFile = (ref, fileName) => execFileSync(
  'git',
  ['show', `${ref}:${fileName}`],
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
);

const selectInputPaths = (allPaths, readCoreFile) => {
  const selected = new Set(CORE_INPUTS);
  for (const fileName of allPaths) {
    if (TRACKED_NATIVE_PREFIXES.some((prefix) => fileName.startsWith(prefix))) selected.add(fileName);
  }
  const appConfigSource = readCoreFile('app.config.js');
  for (const fileName of collectConfigReferences(appConfigSource, new Set(allPaths))) selected.add(fileName);
  return [...selected].sort();
};

const readFilesAtGitRef = (ref) => {
  const allPaths = listGitFiles(ref);
  const cache = new Map();
  const read = (fileName) => {
    if (!cache.has(fileName)) cache.set(fileName, readGitFile(ref, fileName));
    return cache.get(fileName);
  };
  const selected = selectInputPaths(allPaths, read);
  return Object.fromEntries(selected.map((fileName) => [fileName, read(fileName)]));
};

const listWorktreeFiles = () => execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8' },
).split(/\r?\n/u).map(normalizeTrackedPath).filter(Boolean);

const readFilesFromWorktree = () => {
  const allPaths = listWorktreeFiles();
  const read = (fileName) => fs.readFileSync(path.join(ROOT, fileName));
  const selected = selectInputPaths(allPaths, read);
  return Object.fromEntries(selected.map((fileName) => [fileName, read(fileName)]));
};

const buildNativeSnapshot = (ref) => buildNativeSnapshotFromFiles(
  ref === 'WORKTREE' ? readFilesFromWorktree() : readFilesAtGitRef(ref),
);

const changedCategoryNames = (base, head) => Object.keys(head.categories)
  .filter((name) => base.categories[name] !== head.categories[name]);

const compareNativeSnapshots = (base, head) => {
  const changedCategories = changedCategoryNames(base, head);
  const nativeChanged = base.nativeDigest !== head.nativeDigest;
  const runtimeChanged = base.runtimeIdentity !== head.runtimeIdentity;
  if (nativeChanged && !runtimeChanged) {
    const error = new Error(
      `Native-impacting inputs changed (${changedCategories.join(', ')}) without a matching runtime identity change. `
      + `Bump package.json version from ${base.version || 'unknown'} and keep app.config.js runtimeVersion aligned before merging.`,
    );
    error.code = 'NATIVE_RUNTIME_IDENTITY_REQUIRED';
    error.changedCategories = changedCategories;
    throw error;
  }
  return { nativeChanged, runtimeChanged, changedCategories, base, head };
};

const compareRefs = (baseRef, headRef) => compareNativeSnapshots(
  buildNativeSnapshot(baseRef),
  buildNativeSnapshot(headRef),
);

module.exports = {
  buildNativeSnapshot,
  buildNativeSnapshotFromFiles,
  collectConfigReferences,
  compareNativeSnapshots,
  compareRefs,
  extractRuntimePolicy,
};
