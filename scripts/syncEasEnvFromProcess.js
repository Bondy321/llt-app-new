#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const {
  REQUIRED_ENV_VARS,
  ANDROID_REQUIRED_ENV_VARS,
  OPTIONAL_ENV_VARS,
  validateExpoPublicEnv,
} = require('./validateExpoPublicEnv');

const getArgValue = (name) => {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};

const environment = getArgValue('environment') || process.env.EAS_ENVIRONMENT || 'production';
const platform = getArgValue('platform') || process.env.LLT_VALIDATE_PLATFORM || 'all';
const includeAndroidVars = platform.toLowerCase() !== 'ios';

const validation = validateExpoPublicEnv(process.env, { platform });
if (!validation.ok) {
  console.error(`Cannot sync EAS ${environment} environment because local validation failed:`);
  validation.errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const namesToSync = new Set(REQUIRED_ENV_VARS);

if (includeAndroidVars) {
  ANDROID_REQUIRED_ENV_VARS.forEach((name) => namesToSync.add(name));
}

OPTIONAL_ENV_VARS.forEach((name) => {
  if (typeof process.env[name] === 'string' && process.env[name].trim().length > 0) {
    namesToSync.add(name);
  }
});

console.log(`Syncing ${namesToSync.size} Expo public environment variables to EAS "${environment}".`);

for (const name of namesToSync) {
  const result = spawnSync(
    'eas',
    [
      'env:create',
      environment,
      '--scope',
      'project',
      '--name',
      name,
      '--value',
      process.env[name],
      '--visibility',
      'sensitive',
      '--force',
      '--non-interactive',
    ],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    console.error(`Failed to sync ${name} to EAS "${environment}".`);
    process.exit(result.status || 1);
  }
}

console.log(`EAS "${environment}" environment sync complete.`);
