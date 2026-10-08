'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { definitions } = require('./patchDefinitions');
const manifest = require('./patchManifest.json');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const packageName = location => location.split('node_modules/').at(-1);
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const assertFileConfinement = (packageRoot, file) => {
  let existing = file;
  while (!fs.existsSync(existing)) {
    // Dangling symlinks must not be mistaken for absent new helper files.
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('Patch file symlink is not permitted');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Missing patch file parent');
    existing = parent;
  }
  if (!within(fs.realpathSync(packageRoot), fs.realpathSync(existing))) throw new Error('Patch file symlink escapes package');
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Patch file symlink is not permitted');
};

function planPatches(root, policy = manifest, check = false) {
  root = fs.realpathSync(root);
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.patches) ||
    JSON.stringify(policy.patches.map(item => `${item.package}@${item.version}`).sort()) !== JSON.stringify(Object.keys(definitions).sort())) {
    throw new Error('Incomplete or unreviewed security patch manifest');
  }
  const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Unsupported or missing package lock');
  const knownNames = new Set(policy.patches.map(item => item.package));
  const changes = [];
  const verified = [];
  const expectedPaths = new Set();
  for (const [location, locked] of Object.entries(lock.packages)) {
    const name = locked.name || packageName(location);
    if (!knownNames.has(name)) continue;
    if (!location.startsWith('node_modules/') || location.split('/').some(part => !part || part === '.' || part === '..') || location.includes('\\')) {
      throw new Error('Invalid patch package path');
    }
    const packageRoot = path.resolve(root, location);
    if (!within(root, packageRoot)) throw new Error('Patch package escapes project');
    if (!fs.existsSync(packageRoot)) {
      if (locked.dev === true) continue; // npm ci --omit=dev
      throw new Error(`Missing installed patch package: ${location}`);
    }
    const resolvedRoot = fs.realpathSync(packageRoot);
    if (!within(root, resolvedRoot)) throw new Error('Patch package symlink escapes project');
    expectedPaths.add(resolvedRoot);
    const metadata = path.join(packageRoot, 'package.json');
    assertFileConfinement(packageRoot, metadata);
    const installed = JSON.parse(read(metadata));
    const policyEntry = policy.patches.find(item => item.package === name && item.version === locked.version);
    const definition = definitions[`${name}@${locked.version}`];
    if (!policyEntry || !definition || installed.name !== name || installed.version !== locked.version) {
      throw new Error(`Unreviewed security patch version: ${location}@${installed.version}`);
    }
    if (policyEntry.integrity !== locked.integrity) throw new Error(`Unreviewed upstream integrity: ${location}`);
    const definedFiles = [...Object.keys(definition.transforms), ...Object.keys(definition.added)].sort();
    if (JSON.stringify(Object.keys(policyEntry.files).sort()) !== JSON.stringify(definedFiles)) throw new Error('Patch manifest file set differs from definition');
    for (const [relative, attestation] of Object.entries(policyEntry.files)) {
      const file = path.resolve(packageRoot, relative);
      if (!within(packageRoot, file)) throw new Error('Patch file escapes package');
      assertFileConfinement(packageRoot, file);
      if (!/^[a-f0-9]{64}$/.test(attestation.after) || (attestation.before !== null && !/^[a-f0-9]{64}$/.test(attestation.before))) throw new Error('Invalid patch attestation');
      const current = fs.existsSync(file) ? read(file) : null;
      if (current !== null && hash(current) === attestation.after) continue;
      if (check) throw new Error(`Missing or changed security patch: ${location}/${relative}`);
      if (attestation.before === null ? current !== null : current === null || hash(current) !== attestation.before) {
        throw new Error(`Unknown source bytes: ${location}/${relative}`);
      }
      const patched = attestation.before === null ? definition.added[relative] : definition.transforms[relative](current);
      if (hash(patched) !== attestation.after) throw new Error('Patch output differs from reviewed attestation');
      changes.push({ file, packageRoot, source: patched });
    }
    verified.push({ location, package: name, version: locked.version, advisory: policyEntry.advisory, range: policyEntry.range, severity: policyEntry.severity });
  }
  // Walk actual installed node_modules as well: an unlocked extra/nested copy
  // cannot silently retain vulnerable code. Do not follow directory symlinks.
  const visit = modules => {
    if (!fs.existsSync(modules)) return;
    for (const dirent of fs.readdirSync(modules, { withFileTypes: true })) {
      if (dirent.name.startsWith('.')) continue;
      const directory = path.join(modules, dirent.name);
      if (dirent.isSymbolicLink()) {
        const metadata = path.join(directory, 'package.json');
        const linkedName = fs.existsSync(metadata) ? JSON.parse(read(metadata)).name : dirent.name;
        if (knownNames.has(linkedName)) throw new Error('Unreviewed linked patch package');
        continue;
      }
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('@')) { visit(directory); continue; }
      const metadata = path.join(directory, 'package.json');
      const installedName = fs.existsSync(metadata) ? JSON.parse(read(metadata)).name : dirent.name;
      if (knownNames.has(installedName) && !expectedPaths.has(fs.realpathSync(directory))) throw new Error(`Unlocked patch package: ${path.relative(root, directory)}`);
      visit(path.join(directory, 'node_modules'));
    }
  };
  visit(path.join(root, 'node_modules'));
  return { changes, verified };
}

function applyPatches(root, check = false) {
  const result = planPatches(root, manifest, check);
  // Every package/file is validated before any source is changed.
  for (const change of result.changes) {
    assertFileConfinement(change.packageRoot, change.file);
    fs.writeFileSync(change.file, change.source);
  }
  if (!check) planPatches(root, manifest, true);
  return result.verified;
}

if (require.main === module) {
  try {
    const verified = applyPatches(path.resolve(__dirname, '../..'), process.argv.includes('--check'));
    console.log(`Verified ${verified.length} installed security patch packages (${process.argv.includes('--check') ? 'check' : 'apply'}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { applyPatches, planPatches, hash };
