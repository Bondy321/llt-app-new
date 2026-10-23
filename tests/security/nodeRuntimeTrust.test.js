'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const test = require('node:test');
const { assertNodeVersion, assertCertificateStore, assertNodeRuntimeTrust } = require('../../scripts/security/nodeRuntimeTrust');

const compromisedRoot = fs.readFileSync(path.join(__dirname, 'fixtures/emsign-ecc-root-g3.pem'), 'utf8');
const safeRoot = tls.rootCertificates.find((pem) => pem.trim() !== compromisedRoot.trim());

test('only stable supported majors at or above their security floor pass', () => {
  for (const version of ['22.23.4', 'v22.24.0', '24.22.1', '24.23.0']) {
    assert.doesNotThrow(() => assertNodeVersion(version), version);
  }
  for (const version of ['22.23.3', '24.22.0', '24.19.0', '20.99.0', '26.12.1', '24.22.1-rc.1', '24', null]) {
    assert.throws(() => assertNodeVersion(version), undefined, String(version));
  }
});

test('actual compromised certificate is rejected while ordinary certificates remain usable', () => {
  assert.equal(assertCertificateStore([safeRoot], 'fixture'), 1);
  assert.throws(() => assertCertificateStore([safeRoot, compromisedRoot], 'fixture'), /emSign ECC Root CA - G3/u);
  assert.throws(() => assertCertificateStore([], 'fixture'), /no certificates/u);
  assert.throws(() => assertCertificateStore(['not a certificate'], 'fixture'));
});

test('a patched executable cannot mask an unsafe effective or bundled trust store', () => {
  const options = { version: '24.22.1', environment: {}, bundled: [safeRoot], effective: [safeRoot] };
  assert.equal(assertNodeRuntimeTrust(options).effectiveCertificates, 1);
  assert.throws(() => assertNodeRuntimeTrust({ ...options, effective: [compromisedRoot] }), /effective CA/u);
  assert.throws(() => assertNodeRuntimeTrust({ ...options, bundled: [compromisedRoot] }), /bundled CA/u);
  assert.throws(() => assertNodeRuntimeTrust({ ...options, environment: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }), /verification must remain enabled/u);
});

test('every CI/release job verifies its explicitly selected runtime before npm or application Node commands', () => {
  const root = path.resolve(__dirname, '../..');
  for (const name of ['ci.yml', 'eas-build.yml', 'eas-testflight.yml', 'eas-update.yml']) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    for (const job of source.split(/^  [a-z][\w-]*:\r?$/mu).slice(1)) {
      if (!job.includes('actions/setup-node@')) continue;
      const selection = job.indexOf('actions/setup-node@');
      const guard = job.indexOf('run: node scripts/security/nodeRuntimeTrust.js');
      assert.ok(guard > selection, name);
      assert.match(job.slice(selection, guard), /node-version: '(?:22\.23\.4|24\.22\.1)'/u);
      assert.doesNotMatch(job.slice(0, guard), /run: (?:npm |node )/u, name);
    }
  }
});

test('all EAS build profiles inherit a patched runtime and check it before installation', () => {
  const root = path.resolve(__dirname, '../..');
  const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
  for (const name of Object.keys(eas.build)) {
    let cursor = name;
    const seen = new Set();
    while (!eas.build[cursor].node) {
      assert.ok(!seen.has(cursor), 'profile inheritance must not cycle');
      seen.add(cursor);
      cursor = eas.build[cursor].extends;
      assert.ok(eas.build[cursor], `${name} must inherit an explicit runtime`);
    }
    assert.equal(eas.build[cursor].node, '24.22.1');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['eas-build-pre-install'], /^node scripts\/security\/nodeRuntimeTrust\.js && /u);
  const functions = JSON.parse(fs.readFileSync(path.join(root, 'functions/package.json'), 'utf8'));
  assert.equal(functions.engines.node, '22');
});
