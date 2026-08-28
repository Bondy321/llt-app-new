#!/usr/bin/env node
'use strict';

const { compareRefs } = require('./nativeCompatibility');

const readArgument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const baseRef = readArgument('base') || process.env.LLT_RELEASE_BASE_SHA || 'HEAD';
const headRef = readArgument('head') || process.env.LLT_RELEASE_HEAD_SHA || 'WORKTREE';

try {
  const result = compareRefs(baseRef, headRef);
  const changed = result.changedCategories.length > 0 ? result.changedCategories.join(', ') : 'none';
  process.stdout.write(
    `Native compatibility check passed: ${baseRef} (${result.base.runtimeIdentity}) -> ${headRef} (${result.head.runtimeIdentity}); changed inputs: ${changed}.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
