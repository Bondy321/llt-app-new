#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { EAS_CLI_VERSION, EXPO_CLI_VERSION } = require('./profiles');

const ROOT = path.resolve(__dirname, '../..');

const resolveSdkLocalExpoCliVersion = () => {
  const expoPackage = require.resolve('expo/package.json', { paths: [ROOT] });
  const expoRequire = createRequire(expoPackage);
  return expoRequire('@expo/cli/package.json').version;
};

const resolveEasCliVersion = (spawn = spawnSync) => {
  const result = spawn(process.platform === 'win32' ? 'eas.cmd' : 'eas', ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to read EAS CLI version (status ${result.status ?? 'unknown'}).`);
  const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/(?:eas-cli\/)?(\d+\.\d+\.\d+)/u);
  if (!match) throw new Error('Unable to parse the installed EAS CLI version.');
  return match[1];
};

const assertCliVersions = ({ checkEas = false, spawn } = {}) => {
  const expoVersion = resolveSdkLocalExpoCliVersion();
  if (expoVersion !== EXPO_CLI_VERSION) {
    throw new Error(`SDK-local Expo CLI is ${expoVersion}; expected pinned ${EXPO_CLI_VERSION}. Run npm ci from package-lock.json.`);
  }
  let easVersion = null;
  if (checkEas) {
    easVersion = resolveEasCliVersion(spawn);
    if (easVersion !== EAS_CLI_VERSION) {
      throw new Error(`EAS CLI is ${easVersion}; expected pinned ${EAS_CLI_VERSION}.`);
    }
  }
  return { expoVersion, easVersion };
};

if (require.main === module) {
  try {
    const result = assertCliVersions({ checkEas: process.argv.includes('--check-eas') });
    process.stdout.write(`Pinned CLI check passed: Expo ${result.expoVersion}${result.easVersion ? `, EAS ${result.easVersion}` : ''}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertCliVersions, resolveEasCliVersion, resolveSdkLocalExpoCliVersion };
