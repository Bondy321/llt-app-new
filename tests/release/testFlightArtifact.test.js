'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertTestFlightBuild } = require('../../scripts/release/verifyTestFlightBuild');

const appConfig = require('../../app.config.js').expo;
const easConfig = require('../../eas.json');
const releaseSha = 'a'.repeat(40);
const buildId = '11111111-2222-4333-8444-555555555555';
const nowMs = Date.parse('2026-10-24T12:00:00Z');
const options = { releaseSha, buildId, appConfig, easConfig, nowMs };
const validBuild = () => ({
  id: buildId, gitCommitHash: releaseSha, status: 'FINISHED', platform: 'IOS',
  distribution: 'STORE', isForIosSimulator: false, buildProfile: 'testflight',
  updateChannel: { name: 'testflight' }, app: { id: appConfig.extra.eas.projectId },
  appIdentifier: appConfig.ios.bundleIdentifier, appVersion: appConfig.version,
  runtime: { version: appConfig.version }, appBuildVersion: '42',
  completedAt: '2026-10-24T11:00:00Z', expirationDate: '2026-11-24T11:00:00Z',
  artifacts: { applicationArchiveUrl: 'https://artifacts.eascdn.net/synthetic-fixture.ipa' },
});

test('completed exact TestFlight device artifact satisfies the reviewed production configuration', () => {
  assert.deepEqual(assertTestFlightBuild(validBuild(), options), {
    buildId, releaseSha, profile: 'testflight', runtime: appConfig.version,
  });
});

test('same-commit preview/development/production-channel and unfinished artifacts are rejected', () => {
  const cases = [
    ['buildProfile', 'preview'], ['buildProfile', 'development'], ['buildProfile', 'production'],
    ['status', 'IN_PROGRESS'], ['status', 'ERRORED'], ['platform', 'ANDROID'],
    ['distribution', 'INTERNAL'], ['isForIosSimulator', true],
    ['id', '99999999-2222-4333-8444-555555555555'], ['gitCommitHash', 'b'.repeat(40)],
    ['updateChannel', { name: 'production' }], ['app', { id: 'another-project' }],
    ['appIdentifier', 'other.application'], ['appVersion', '0.0.0'], ['runtime', { version: '0.0.0' }],
    ['completedAt', null], ['expirationDate', '2026-10-23T11:00:00Z'],
    ['artifacts', { applicationArchiveUrl: 'http://artifacts.eascdn.net/insecure.ipa' }],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => assertTestFlightBuild({ ...validBuild(), [field]: value }, options), /verification/u, field);
  }
});

test('missing artifact provenance cannot use guessed metadata aliases or optional fallback', () => {
  for (const field of Object.keys(validBuild()).filter((key) => key !== 'expirationDate')) {
    const build = validBuild();
    delete build[field];
    build.metadata = { gitCommitHash: releaseSha };
    build.gitCommit = { hash: releaseSha };
    assert.throws(() => assertTestFlightBuild(build, options), /verification/u, field);
  }
});

test('a reviewed profile that disables App Check or selects a nonproduction environment fails closed', () => {
  for (const mutation of [
    { environment: 'preview' }, { developmentClient: true }, { distribution: 'internal' },
    { env: { LLT_REQUIRE_PRODUCTION_APPCHECK: 'false' } },
    { env: { EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK: 'false' } },
  ]) {
    const changed = structuredClone(easConfig);
    changed.build.testflight = { ...changed.build.testflight, ...mutation };
    assert.throws(() => assertTestFlightBuild(validBuild(), { ...options, easConfig: changed }), /verification/u);
  }
});

const readWorkflow = (name) => fs.readFileSync(path.resolve(__dirname, '../../.github/workflows', name), 'utf8').replace(/\r\n/gu, '\n');
const jobSteps = (source, name) => {
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|(?![\\s\\S]))`, 'mu').exec(source);
  assert.ok(match, name);
  return match[1].split(/^      - /mu).slice(1).map((block) => {
    const condition = /^        if: (.+)$/mu.exec(block)?.[1];
    if (condition) assert.equal(condition, '${{ !inputs.eas_build_id }}');
    const run = /^        run: (.+)$/mu.exec(block)?.[1];
    const command = run === '|' ? block.slice(block.indexOf('        run: |') + '        run: |'.length).trim() : run;
    return { condition, command };
  });
};

const assertInstalledAudit = (steps, reuseBuild) => {
  const active = steps.filter((step) => !step.condition || !reuseBuild);
  const audits = active.map((step, index) => step.command === 'npm run security:audit:release' ? index : -1).filter((index) => index >= 0);
  for (const audit of audits) {
    for (const command of ['npm ci', 'npm --prefix functions ci', 'npm --prefix web-admin ci']) {
      assert.ok(active.some((step, index) => index < audit && step.command === command), `${command} must complete before the audit`);
    }
  }
  const publications = active.map((step, index) => /(?:^|\n)\s*(?:eas build |eas submit |npm run update:testflight )/u.test(step.command || '') ? index : -1).filter((index) => index >= 0);
  for (const publication of publications) assert.ok(audits.some((audit) => audit < publication), 'every publication path requires its own installed-graph audit');
  return publications.length;
};

test('every fresh build, OTA and reused-build submission audits all installed dependency graphs first', () => {
  let publications = 0;
  for (const [file, job, reuseCases] of [
    ['eas-build.yml', 'build-production', [false]],
    ['eas-update.yml', 'publish-testflight-update', [false]],
    ['eas-testflight.yml', 'build-ios', [false, true]],
    ['eas-testflight.yml', 'submit-testflight', [false, true]],
  ]) {
    const steps = jobSteps(readWorkflow(file), job);
    for (const reuse of reuseCases) publications += assertInstalledAudit(steps, reuse);
  }
  assert.equal(publications, 5, 'the reused build skips creation but still passes an independent audited submission');
  const submission = jobSteps(readWorkflow('eas-testflight.yml'), 'submit-testflight');
  assert.throws(() => assertInstalledAudit(submission.filter((step) => step.command !== 'npm --prefix functions ci'), true), /functions ci/u);
  const outOfOrder = submission.filter((step) => step.command !== 'npm run security:audit:release');
  outOfOrder.unshift({ command: 'npm run security:audit:release' });
  assert.throws(() => assertInstalledAudit(outOfOrder, true), /before the audit/u);
});

test('submission independently checks exact CI and authenticated artifact provenance before submitting', () => {
  const source = readWorkflow('eas-testflight.yml').split('  submit-testflight:')[1];
  assert.match(source, /permissions:\n      actions: read\n      contents: read/u);
  const trust = source.indexOf('run: node scripts/security/nodeRuntimeTrust.js');
  const exactCi = source.indexOf('run: node scripts/verifyCiRunForSha.js --sha=${{ github.sha }}');
  const provenance = source.indexOf('node scripts/release/verifyTestFlightBuild.js eas-selected-build.json');
  const submit = source.indexOf('eas submit "${submit_args[@]}"');
  assert.ok(trust >= 0 && exactCi > trust && provenance > exactCi && submit > provenance);
  assert.match(source, /eas build:view "\$EAS_BUILD_ID" --json > eas-selected-build\.json/u);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github.token \}\}/u);
});
