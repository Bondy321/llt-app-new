'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planPatches, applyPatches, hash } = require('../../scripts/security/dependencyPatches');
const { evaluateAudit, parseAudit } = require('../../scripts/security/audit');
const manifest = require('../../scripts/security/patchManifest.json');
const forgePolicy = manifest.patches.find(item => item.package === 'node-forge');
const root = path.resolve(__dirname, '../..');

function fixture(t, newline = '\n') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-security-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, 'node_modules/node-forge');
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
  let source = fs.readFileSync(path.join(root, 'node_modules/node-forge/lib/rsa.js'), 'utf8').replace(/\r\n/g, '\n');
  source = source.replace("obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {", 'obj.value.length !== 2) {');
  assert.equal(hash(source), forgePolicy.files['lib/rsa.js'].before, 'fixture is attested upstream source');
  fs.writeFileSync(path.join(packageRoot, 'lib/rsa.js'), source.replace(/\n/g, newline));
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'node-forge', version: '1.4.0' }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/node-forge': { version: '1.4.0', integrity: forgePolicy.integrity } } }));
  return { directory, packageRoot, file: path.join(packageRoot, 'lib/rsa.js') };
}

test('patch installation validates before bytes, normalizes only CRLF, and is idempotent', t => {
  const data = fixture(t, '\r\n');
  assert.throws(() => applyPatches(data.directory, true), /Missing or changed/);
  assert.equal(applyPatches(data.directory).length, 1);
  assert.equal(hash(fs.readFileSync(data.file)), forgePolicy.files['lib/rsa.js'].after);
  assert.equal(planPatches(data.directory).changes.length, 0);
  assert.equal(applyPatches(data.directory, true).length, 1);
});

test('unexpected source bytes fail before any mutation', t => {
  const data = fixture(t);
  fs.appendFileSync(data.file, '\n// unexplained change\n');
  const before = fs.readFileSync(data.file);
  assert.throws(() => applyPatches(data.directory), /Unknown source bytes/);
  assert.deepEqual(fs.readFileSync(data.file), before);
});

test('file symlinks and redirected parent directories fail without external writes', t => {
  const data = fixture(t);
  const external = path.join(data.directory, 'external');
  fs.mkdirSync(external);
  const target = path.join(external, 'rsa.js');
  fs.copyFileSync(data.file, target);
  const before = fs.readFileSync(target);
  fs.unlinkSync(data.file);
  try {
    fs.symlinkSync(target, data.file, 'file');
    assert.throws(() => applyPatches(data.directory), /symlink/);
    assert.deepEqual(fs.readFileSync(target), before);
    fs.unlinkSync(data.file);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    // Windows without Developer Mode cannot create file symlinks. The
    // junction case below still proves realpath confinement locally; Linux
    // CI exercises the direct file symlink as well.
    t.diagnostic('Windows denies creating file symlinks; exercising redirected parent junction instead');
  }
  fs.rmdirSync(path.join(data.packageRoot, 'lib'));
  fs.symlinkSync(external, path.join(data.packageRoot, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => applyPatches(data.directory), /symlink escapes/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test('tampered patched bytes, missing files, and versions cannot receive attestation', t => {
  const data = fixture(t);
  applyPatches(data.directory);
  fs.appendFileSync(data.file, '// changed');
  assert.throws(() => applyPatches(data.directory, true), /Missing or changed/);
  fs.unlinkSync(data.file);
  assert.throws(() => applyPatches(data.directory), /Unknown source bytes/);
  fs.writeFileSync(path.join(data.packageRoot, 'package.json'), JSON.stringify({ name: 'node-forge', version: '1.4.1' }));
  assert.throws(() => applyPatches(data.directory), /Unreviewed security patch version/);
});

test('incomplete manifests and changed output hashes fail closed', t => {
  const data = fixture(t);
  assert.throws(() => planPatches(data.directory, { ...manifest, patches: [] }), /manifest/);
  const policy = structuredClone(manifest);
  policy.patches.find(item => item.package === 'node-forge').files['lib/rsa.js'].after = '0'.repeat(64);
  assert.throws(() => planPatches(data.directory, policy), /output differs/);
  policy.patches.find(item => item.package === 'node-forge').files['lib/unknown.js'] = { before: null, after: '0'.repeat(64) };
  assert.throws(() => planPatches(data.directory, policy), /file set differs/);
});

test('unlocked nested installed copies and altered upstream integrity fail closed', t => {
  const data = fixture(t);
  const extra = path.join(data.directory, 'node_modules/other/node_modules/node-forge');
  fs.mkdirSync(extra, { recursive: true });
  assert.throws(() => applyPatches(data.directory), /Unlocked patch package/);
  fs.rmSync(path.join(data.directory, 'node_modules/other'), { recursive: true });
  const lock = JSON.parse(fs.readFileSync(path.join(data.directory, 'package-lock.json')));
  lock.packages['node_modules/node-forge'].integrity = 'changed';
  fs.writeFileSync(path.join(data.directory, 'package-lock.json'), JSON.stringify(lock));
  assert.throws(() => applyPatches(data.directory), /Unreviewed upstream integrity/);
});

const installed = [{ location: 'node_modules/node-forge', package: 'node-forge', version: '1.4.0', advisory: forgePolicy.advisory }];
const direct = () => ({ name: 'node-forge', severity: 'high', via: [structuredClone(forgePolicy.auditRecord)], nodes: ['node_modules/node-forge'] });
const report = vulnerabilities => {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length };
  Object.values(vulnerabilities).forEach(finding => counts[finding.severity]++);
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } };
};

test('only exact advisory records, installed paths, and a fully resolved via graph pass', () => {
  const findings = { 'node-forge': direct(), expo: { name: 'expo', severity: 'high', via: ['node-forge'], nodes: ['node_modules/expo'] } };
  const audit = parseAudit(JSON.stringify(report(findings)), 1);
  assert.equal(evaluateAudit(audit, installed).blockers.length, 0);
  assert.equal(evaluateAudit(audit, installed).mitigated.length, 2);
  for (const mutate of [finding => finding.via[0].range = '<=1.4.1', finding => finding.via[0].source++, finding => finding.via[0].cvss.score = 10, finding => finding.nodes.push('node_modules/unknown/node_modules/node-forge')]) {
    const changed = structuredClone(audit);
    mutate(changed.vulnerabilities['node-forge']);
    assert.equal(evaluateAudit(changed, installed).blockers.length, 2);
  }
});

test('additional advisories, incomplete graphs and propagation cycles never pass as patched', () => {
  const additional = direct();
  additional.via.push({ ...forgePolicy.auditRecord, url: 'https://github.com/advisories/GHSA-new-unknown' });
  assert.equal(evaluateAudit(report({ 'node-forge': additional }), installed).blockers.length, 1);
  const cyclic = report({ a: { name: 'a', severity: 'high', via: ['b'], nodes: ['node_modules/a'] }, b: { name: 'b', severity: 'high', via: ['a'], nodes: ['node_modules/b'] } });
  assert.equal(evaluateAudit(cyclic, installed).blockers.length, 2);
  cyclic.vulnerabilities.a.via = ['missing'];
  assert.equal(evaluateAudit(cyclic, installed).blockers.length, 2);
  assert.equal(evaluateAudit(report({ 'node-forge': direct() }), []).blockers.length, 1);
});

test('anchored propagation cycles pass only when every branch reaches a verified direct fix', () => {
  const findings = {
    'node-forge': direct(),
    metro: { name: 'metro', severity: 'high', via: ['metro-config', 'node-forge'], nodes: ['node_modules/metro'] },
    'metro-config': { name: 'metro-config', severity: 'high', via: ['metro'], nodes: ['node_modules/metro-config'] },
  };
  const audit = parseAudit(JSON.stringify(report(findings)), 1);
  assert.equal(evaluateAudit(audit, installed).blockers.length, 0);
  const disconnected = structuredClone(audit);
  disconnected.vulnerabilities.a = { name: 'a', severity: 'high', via: ['b'], nodes: ['node_modules/a'] };
  disconnected.vulnerabilities.b = { name: 'b', severity: 'high', via: ['a'], nodes: ['node_modules/b'] };
  disconnected.vulnerabilities.metro.via.push('a');
  assert.deepEqual(evaluateAudit(disconnected, installed).blockers.map(item => item.name).sort(), ['a', 'b', 'metro', 'metro-config']);
  const changed = structuredClone(audit);
  changed.vulnerabilities['node-forge'].via[0].source++;
  assert.equal(evaluateAudit(changed, installed).blockers.length, 3);
});

test('inherited severity reflects every remaining direct advisory without hiding lower-severity findings', () => {
  const findings = {
    'node-forge': direct(),
    telemetry: { name: 'telemetry', severity: 'moderate', via: [{ ...forgePolicy.auditRecord, source: 999999, name: 'telemetry', dependency: 'telemetry', title: 'Unpatched telemetry advisory', range: '<2.8.0', severity: 'moderate', url: 'https://github.com/advisories/GHSA-unpatched' }], nodes: ['node_modules/telemetry'] },
    tooling: { name: 'tooling', severity: 'high', via: ['node-forge', 'telemetry'], nodes: ['node_modules/tooling'] },
  };
  const result = evaluateAudit(parseAudit(JSON.stringify(report(findings)), 1), installed);
  assert.equal(result.blockers.length, 0);
  assert.deepEqual(result.unresolved, [
    { name: 'telemetry', severity: 'moderate', reportedSeverity: 'moderate' },
    { name: 'tooling', severity: 'moderate', reportedSeverity: 'high' },
  ]);
  findings.telemetry.via[0].severity = 'high';
  findings.telemetry.severity = 'high';
  assert.equal(evaluateAudit(report(findings), installed).blockers.length, 2);
  findings.telemetry.via = ['missing'];
  assert.equal(evaluateAudit(report(findings), installed).blockers.length, 2);
});

test('malformed direct advisories are rejected even below the release severity threshold', () => {
  for (const via of [null, [], '']) {
    const finding = { name: 'tooling', severity: 'moderate', via: [via], nodes: ['node_modules/tooling'] };
    assert.throws(() => parseAudit(JSON.stringify(report({ tooling: finding })), 1), /Invalid npm direct advisory/);
  }
  const malformed = direct();
  delete malformed.via[0].severity;
  assert.throws(() => parseAudit(JSON.stringify(report({ 'node-forge': malformed })), 1), /Invalid npm direct advisory/);
});

test('network failures, invalid JSON, incomplete and contradictory audit reports fail closed', () => {
  for (const input of ['', '{}', '{"error":{"code":"ECONNRESET"}}', JSON.stringify({ ...report({}), auditReportVersion: 1 })]) assert.throws(() => parseAudit(input, 1));
  assert.throws(() => parseAudit(JSON.stringify(report({})), null, new Error('network')));
  assert.throws(() => parseAudit(JSON.stringify(report({})), 2));
  assert.throws(() => parseAudit(JSON.stringify(report({})), 1), /contradicts/);
  assert.throws(() => parseAudit(JSON.stringify(report({ 'node-forge': direct() })), 0), /contradicts/);
  const inconsistent = report({ 'node-forge': direct() }); inconsistent.metadata.vulnerabilities.total = 0;
  assert.throws(() => parseAudit(JSON.stringify(inconsistent), 1), /counts/);
});
