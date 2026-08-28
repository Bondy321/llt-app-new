#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const {
  buildEasUpdateArguments,
  createUpdateEnvironment,
  getUpdateTarget,
} = require('./profiles');
const { resolveProfileParity } = require('./configParity');

const readTargetArgument = (args) => {
  const inline = args.find((value) => value.startsWith('--target='));
  if (inline) return inline.slice('--target='.length);
  const index = args.indexOf('--target');
  return index >= 0 ? args[index + 1] : '';
};

const removeTargetArguments = (args) => {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('--target=')) continue;
    if (value === '--target') {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
};

const runEasUpdate = ({
  targetName,
  forwardedArguments = [],
  baseEnvironment = process.env,
  spawn = spawnSync,
  output = process.stdout,
} = {}) => {
  const target = getUpdateTarget(targetName);
  const args = buildEasUpdateArguments(targetName, forwardedArguments);
  const env = createUpdateEnvironment(targetName, baseEnvironment);
  const parity = resolveProfileParity(targetName, { baseEnvironment });
  if (parity.differences.length > 0) {
    throw new Error(
      `${targetName} binary/update config differs at: ${parity.differences.join(', ')}. `
      + 'Resolve profile parity before publishing.',
    );
  }

  output.write(
    `Preparing EAS update for ${targetName}: profile=${target.buildProfile}, channel=${target.channel}, platform=${target.platform}, environment=${target.environment}.\n`,
  );

  const easExecutable = process.platform === 'win32' ? 'eas.cmd' : 'eas';
  const result = spawn(easExecutable, args, {
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`EAS update exited with status ${result.status ?? 'unknown'} for ${targetName}.`);
  }
  return { args, env, parity, target, command: easExecutable };
};

if (require.main === module) {
  try {
    const targetName = readTargetArgument(process.argv.slice(2));
    const forwardedArguments = removeTargetArguments(process.argv.slice(2));
    runEasUpdate({ targetName, forwardedArguments });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  readTargetArgument,
  removeTargetArguments,
  runEasUpdate,
};
