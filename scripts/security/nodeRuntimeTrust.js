#!/usr/bin/env node
'use strict';

const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

// Node's October 21, 2026 release also blocks compromised intermediate keys.
// Removing a root alone is not a substitute for the patched executable.
const MINIMUM_NODE_VERSIONS = Object.freeze({ 22: '22.23.4', 24: '24.22.1' });
const EMSIGN_G3_SHA256 = '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B';

const assertNodeVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(version));
  if (!match) throw new Error('A stable, supported Node 22 or 24 security release is required.');
  const parts = match.slice(1).map(Number);
  const minimum = MINIMUM_NODE_VERSIONS[parts[0]];
  if (!minimum) throw new Error(`Unsupported Node major ${parts[0]}; use the verified Node 22 or 24 toolchain.`);
  const floor = minimum.split('.').map(Number);
  if (parts[1] < floor[1] || (parts[1] === floor[1] && parts[2] < floor[2])) {
    throw new Error(`Node ${version} is below the certificate-security minimum ${minimum}.`);
  }
  return minimum;
};

const assertCertificateStore = (certificates, label) => {
  if (!Array.isArray(certificates) || certificates.length === 0) {
    throw new Error(`Cannot verify the ${label} CA store: no certificates available.`);
  }
  for (const pem of certificates) {
    const certificate = new X509Certificate(pem);
    const fingerprint = certificate.fingerprint256.replaceAll(':', '').toUpperCase();
    if (fingerprint === EMSIGN_G3_SHA256 || /(?:^|\n)CN=emSign ECC Root CA - G3(?:\n|$)/u.test(certificate.subject)) {
      throw new Error(`Compromised emSign ECC Root CA - G3 remains in the ${label} CA store.`);
    }
  }
  return certificates.length;
};

const assertNodeRuntimeTrust = ({
  version = process.version,
  environment = process.env,
  bundled = tls.rootCertificates,
  effective,
} = {}) => {
  const minimum = assertNodeVersion(version);
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('TLS certificate verification must remain enabled.');
  }
  const effectiveCertificates = effective === undefined ? tls.getCACertificates('default') : effective;
  return {
    node: version,
    minimum,
    bundledCertificates: assertCertificateStore(bundled, 'bundled'),
    effectiveCertificates: assertCertificateStore(effectiveCertificates, 'effective'),
  };
};

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(assertNodeRuntimeTrust())}\n`);
  } catch (error) {
    process.stderr.write(`Node runtime trust check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MINIMUM_NODE_VERSIONS, EMSIGN_G3_SHA256, assertNodeVersion, assertCertificateStore, assertNodeRuntimeTrust };
