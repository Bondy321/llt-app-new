'use strict';

// @ts-check

/** @returns {NodeJS.ProcessEnv} */
const getRuntimeEnvironment = () => process.env;

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
const isDeployedFunctionsRuntime = (env = getRuntimeEnvironment()) => Boolean(env.K_SERVICE);

module.exports = { getRuntimeEnvironment, isDeployedFunctionsRuntime };
