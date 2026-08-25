'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { getRuntimeEnvironment, isDeployedFunctionsRuntime } = require('../../config/runtimeConfig');
const { log } = require('../logging/safeLogger');

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
const shouldRequireLoginAppCheck = (env = getRuntimeEnvironment()) => {
  if (env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true') return true;
  if (env.REQUIRE_APP_CHECK_FOR_LOGIN === 'false') return false;
  if (isDeployedFunctionsRuntime(env)) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('Production login App Check enforcement is not configured')
    );
    error.code = 'LOGIN_APP_CHECK_CONFIGURATION_REQUIRED';
    throw error;
  }
  return false;
};

/** @param {{ req: any, networkDimension: string, loginType: string, appCheck?: any }} options */
const enforceLoginAppCheck = async ({
  req,
  networkDimension,
  loginType,
  appCheck = admin.appCheck(),
}) => {
  if (!shouldRequireLoginAppCheck()) return true;
  const appCheckToken = req.headers['x-firebase-appcheck'];
  if (typeof appCheckToken !== 'string' || !appCheckToken.trim()) return false;
  try {
    await appCheck.verifyToken(appCheckToken.trim());
    return true;
  } catch (error) {
    log.warn(`${loginType} login rejected: invalid App Check token`, {
      networkDimension,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

module.exports = { enforceLoginAppCheck, shouldRequireLoginAppCheck };
