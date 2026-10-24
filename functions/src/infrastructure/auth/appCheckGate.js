'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { getRuntimeEnvironment, isDeployedFunctionsRuntime } = require('../../config/runtimeConfig');

/**
 * Serving runtimes always require attestation. Local isolated verification may
 * explicitly disable it without introducing a production bypass.
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
  if (!isDeployedFunctionsRuntime(env) && env.REQUIRE_APP_CHECK_FOR_GROUP_MEDIA === 'false') return true;
  const required = isDeployedFunctionsRuntime(env) || env.REQUIRE_APP_CHECK_FOR_GROUP_MEDIA === 'true'
    || env.REQUIRE_APP_CHECK_FOR_LOGIN === 'true';
  if (!required) return true;
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
