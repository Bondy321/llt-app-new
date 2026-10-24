'use strict';

const { admin } = require('../../bootstrap/firebaseAdmin');
const { getRuntimeEnvironment, isDeployedFunctionsRuntime } = require('../../config/runtimeConfig');

const verifyHttpAppCheck = async (req, {
  env = getRuntimeEnvironment(), appCheck = () => admin.appCheck(),
} = {}) => {
  const required = isDeployedFunctionsRuntime(env) || env.REQUIRE_APP_CHECK_FOR_HTTP === 'true';
  if (!required) return true; // Local synthetic handlers do not contact providers.
  const token = req.headers?.['x-firebase-appcheck'];
  if (typeof token !== 'string' || token.length < 1 || token.length > 16384) return false;
  try {
    await appCheck().verifyToken(token);
    return true;
  } catch {
    return false;
  }
};

module.exports = { verifyHttpAppCheck };
