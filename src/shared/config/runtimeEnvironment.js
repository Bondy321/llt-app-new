'use strict';

// @ts-check

/** @returns {NodeJS.ProcessEnv} */
export const getRuntimeEnvironment = () => process.env;

/** @param {NodeJS.ProcessEnv} [environment] */
export const isTestRuntime = (environment = getRuntimeEnvironment()) => (
  environment.NODE_ENV === 'test'
);
