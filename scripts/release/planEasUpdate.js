#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildNativeSnapshot } = require('./nativeCompatibility');
const { createUpdatePlan } = require('./updatePlan');

const ROOT = path.resolve(__dirname, '../..');

const readArgument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const isUsableSha = (value) => /^[a-f0-9]{40}$/iu.test(value || '') && !/^0{40}$/u.test(value);

const readChangedPaths = (baseRef, headRef) => execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=ACDMRTUXB', baseRef, headRef],
  { cwd: ROOT, encoding: 'utf8' },
).split(/\r?\n/u).filter(Boolean);

const appendOutputs = (outputPath, plan) => {
  if (!outputPath) return;
  const lines = [
    `should_publish=${plan.shouldPublish}`,
    `reason=${plan.reason}`,
    `bundle_changed=${plan.bundleChanged}`,
    `native_changed=${plan.nativeChanged}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
};

const planFromGit = ({ eventName, baseRef, headRef }) => {
  if (eventName === 'workflow_dispatch') {
    return createUpdatePlan({ eventName });
  }
  if (!isUsableSha(baseRef) || !isUsableSha(headRef)) {
    return createUpdatePlan({ eventName, changeSetKnown: false });
  }
  const changedPaths = readChangedPaths(baseRef, headRef);
  const baseSnapshot = buildNativeSnapshot(baseRef);
  const headSnapshot = buildNativeSnapshot(headRef);
  return createUpdatePlan({
    eventName,
    changedPaths,
    nativeChanged: baseSnapshot.nativeDigest !== headSnapshot.nativeDigest,
  });
};

if (require.main === module) {
  try {
    const eventName = readArgument('event') || process.env.GITHUB_EVENT_NAME || '';
    const baseRef = readArgument('base') || process.env.LLT_RELEASE_BASE_SHA || '';
    const headRef = readArgument('head') || process.env.GITHUB_SHA || '';
    const outputPath = readArgument('github-output') || process.env.GITHUB_OUTPUT || '';
    const plan = planFromGit({ eventName, baseRef, headRef });
    appendOutputs(outputPath, plan);
    process.stdout.write(`EAS update plan: publish=${plan.shouldPublish}; reason=${plan.reason}.\n`);
  } catch (error) {
    process.stderr.write(`Unable to determine a safe automatic OTA plan: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { appendOutputs, isUsableSha, planFromGit, readChangedPaths };
