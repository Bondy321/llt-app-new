'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const test = require('node:test');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
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
  let checkedJobs = 0;
  for (const name of ['ci.yml', 'eas-build.yml', 'eas-testflight.yml', 'eas-update.yml']) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    for (const job of source.split(/^  [a-z][\w-]*:\r?$/mu).slice(1)) {
      if (!job.includes('runs-on:')) continue;
      checkedJobs += 1;
      const selection = job.indexOf('uses: ./.github/actions/verified-node');
      assert.ok(selection >= 0, `${name}: every executable job selects a verified runtime`);
      const guard = job.indexOf('run: node scripts/security/nodeRuntimeTrust.js');
      assert.ok(guard > selection, name);
      assert.match(job.slice(selection, guard), /node-version: '(?:22\.23\.4|24\.22\.1)'/u);
      assert.doesNotMatch(job.slice(0, guard), /run: (?:npm |node )/u, name);
    }
  }
  assert.equal(checkedJobs, 11, 'all six CI checks and five manual/planning jobs are covered');
});

test('workflow bootstrap never invokes JavaScript actions or persists checkout credentials', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  for (const name of ['ci.yml', 'eas-build.yml', 'eas-testflight.yml', 'eas-update.yml']) {
    const source = read(`.github/workflows/${name}`);
    assert.match(source, /^env:\r?\n  TZ: Europe\/London$/mu);
    for (const entry of source.matchAll(/^\s*uses:\s*(\S+)\s*$/gmu)) {
      assert.ok(['./.github/actions/verified-node', './.github/actions/runner-java21'].includes(entry[1]), entry[1]);
    }
    for (const job of source.split(/^  [a-z][\w-]*:\r?$/mu).slice(1)) {
      if (!job.includes('runs-on:')) continue;
      assert.match(job, /runs-on: ubuntu-24\.04/u);
      assert.match(job, /LLT_CHECKOUT_TOKEN: \$\{\{ github.token \}\}/u);
      assert.match(job, /export GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/u);
      assert.match(job, /git -c credential\.helper= fetch --no-recurse-submodules origin/u);
      assert.match(job, /'\+refs\/heads\/\*:refs\/remotes\/origin\/\*' '\+refs\/tags\/\*:refs\/tags\/\*' "\$GITHUB_SHA"/u);
      assert.match(job, /git checkout --detach "\$GITHUB_SHA"/u);
      assert.match(job, /\[\[ "\$\(git rev-parse HEAD\)" == "\$GITHUB_SHA" \]\]/u);
      assert.match(job, /unset authorization LLT_CHECKOUT_TOKEN GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0/u);
      assert.doesNotMatch(job, /git config[^\n]*(?:extraheader|credential)|https:\/\/[^\s"]*@github\.com|persist-credentials:\s*true/u);
    }
  }
  for (const action of ['verified-node', 'runner-java21']) {
    const manifest = read(`.github/actions/${action}/action.yml`);
    assert.match(manifest, /using: composite/u);
    assert.match(manifest, /shell: bash/u);
    assert.doesNotMatch(manifest, /using: node|\buses:/u);
  }
  const ancestry = read('.github/actions/verified-node/verify-main.sh');
  assert.match(ancestry, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
  assert.match(ancestry, /\+refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(ancestry, /export GIT_CONFIG_VALUE_0=/u);
  assert.doesNotMatch(ancestry, /git config[^\n]*(?:extraheader|credential)/u);
});

test('shell Node bootstrap authenticates fixed archive bytes before extraction and execution', () => {
  const root = path.resolve(__dirname, '../..');
  const bootstrap = fs.readFileSync(path.join(root, '.github/actions/verified-node/bootstrap.sh'), 'utf8');
  assert.match(bootstrap, /22\.23\.4\) digest=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce/u);
  assert.match(bootstrap, /24\.22\.1\) digest=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6/u);
  assert.match(bootstrap, /Unreviewed Node version requested.*exit 1/u);
  assert.match(bootstrap, /mktemp -d "\$RUNNER_TEMP\/llt-node\./u);
  assert.match(bootstrap, /--proto '=https' --proto-redir '=https'.*--fail/u);
  const verified = bootstrap.indexOf('sha256sum --check --strict -');
  const extracted = bootstrap.indexOf('tar --extract');
  const executed = bootstrap.indexOf('"$node_bin/node" --version');
  assert.ok(verified >= 0 && extracted > verified && executed > extracted);
  assert.match(bootstrap, /printf '%s\\n' "\$node_bin" >> "\$GITHUB_PATH"/u);
  assert.doesNotMatch(bootstrap, /sudo|_externals|--insecure|NODE_TLS_REJECT_UNAUTHORIZED=0/u);
  const java = fs.readFileSync(path.join(root, '.github/actions/runner-java21/action.yml'), 'utf8');
  assert.match(java, /JAVA_HOME_21_X64/u);
  assert.match(java, /java\.specification\.version = 21/u);
});

test('real Bash bootstrap rejects corrupt downloaded bytes before extraction and rejects unsafe inputs', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert.ok(fs.existsSync(bash), 'Bash is required to exercise the actual CI bootstrap');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-bootstrap-security-'));
  const unixPath = (value) => value.replace(/\\/gu, '/').replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
  try {
    const fixtureBin = path.join(directory, 'bin');
    fs.mkdirSync(fixtureBin);
    const writeExecutable = (name, contents) => {
      fs.writeFileSync(path.join(fixtureBin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`, { mode: 0o755 });
    };
    writeExecutable('uname', 'if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi');
    writeExecutable('curl', 'printf "%s\\n" "$@" > "$LLT_CURL_ARGUMENTS"\nwhile [[ "$1" != -o ]]; do shift; done\nprintf "corrupted archive" > "$2"');
    writeExecutable('tar', 'touch "$LLT_EXTRACTED"\nexit 99');
    const script = unixPath(path.resolve(__dirname, '../../.github/actions/verified-node/bootstrap.sh'));
    const environment = {
      ...process.env,
      RUNNER_TEMP: unixPath(directory),
      GITHUB_PATH: unixPath(path.join(directory, 'github-path')),
      LLT_FIXTURE_BIN: unixPath(fixtureBin),
      LLT_CURL_ARGUMENTS: unixPath(path.join(directory, 'curl-arguments')),
      LLT_EXTRACTED: unixPath(path.join(directory, 'extracted')),
      LLT_BOOTSTRAP: script,
      LLT_NODE_VERSION: '24.22.1',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
    };
    const execute = (overrides = {}) => spawnSync(bash, ['-c', 'export PATH="$LLT_FIXTURE_BIN:$PATH"; bash "$LLT_BOOTSTRAP"'], {
      env: { ...environment, ...overrides }, encoding: 'utf8', timeout: 10_000,
    });
    const corrupt = execute();
    assert.ifError(corrupt.error);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stdout + corrupt.stderr, /FAILED|did NOT match/u);
    assert.equal(fs.existsSync(path.join(directory, 'extracted')), false);
    assert.equal(fs.existsSync(path.join(directory, 'github-path')), false);
    const curlArguments = fs.readFileSync(path.join(directory, 'curl-arguments'), 'utf8');
    assert.match(curlArguments, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-x64\.tar\.xz/u);
    assert.match(curlArguments, /--proto\n=https\n--proto-redir\n=https/u);
    fs.unlinkSync(path.join(directory, 'curl-arguments'));
    const unsupported = execute({ LLT_NODE_VERSION: '24.21.0' });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stdout + unsupported.stderr, /Unreviewed Node version/u);
    assert.equal(fs.existsSync(path.join(directory, 'curl-arguments')), false);
    const insecure = execute({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.notEqual(insecure.status, 0);
    assert.equal(fs.existsSync(path.join(directory, 'curl-arguments')), false);
    assert.equal(fs.existsSync(path.join(directory, 'extracted')), false);
    assert.equal(fs.existsSync(path.join(directory, 'github-path')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
