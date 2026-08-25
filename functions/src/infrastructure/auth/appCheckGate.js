'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { getRuntimeEnvironment, isDeployedFunctionsRuntime } = require('../../config/runtimeConfig');

/**
 * Preserves the existing explicit group-media/session App Check gate. This is
 * an infrastructure relocation only; rollout values and policy are unchanged.
 *
 * @param {any} req
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {any} [appCheck]
 */
const enforceGroupMediaAppCheck = async (
  req,
  env = getRuntimeEnvironment(),
  appCheck = admin.appCheck(),
) => {
  if (env.REQUIRE_APP_CHECK_FOR_GROUP_MEDIA === 'false') return true;
  const required = env.REQUIRE_APP_CHECK_FOR_GROUP_MEDIA === 'true'
    || env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true';
  if (!required && !isDeployedFunctionsRuntime(env)) return true;
  if (!required && isDeployedFunctionsRuntime(env)) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('Production group media App Check enforcement is not configured')
    );
    error.code = 'GROUP_MEDIA_APP_CHECK_CONFIGURATION_REQUIRED';
    throw error;
  }
  const token = req.headers['x-firebase-appcheck'];
  if (typeof token !== 'string' || !token.trim()) return false;
  try {
    await appCheck.verifyToken(token.trim());
    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = { enforceGroupMediaAppCheck };
