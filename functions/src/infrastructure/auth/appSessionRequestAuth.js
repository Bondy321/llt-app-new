'use strict';

// @ts-check

const { enforceGroupMediaAppCheck } = require('./appCheckGate');
const { verifyRequestAuthUid } = require('./requestAuth');
const { log } = require('../logging/safeLogger');

/** @param {{ req: any, res: any }} input */
const authorizeAppSessionMobileRequest = async ({ req, res }) => {
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' });
    return null;
  }
  let appCheckValid = false;
  try {
    appCheckValid = await enforceGroupMediaAppCheck(req);
  } catch (error) {
    log.error('App session App Check configuration failure', error);
    res.status(503).json({ success: false, reason: 'SERVICE_UNAVAILABLE' });
    return null;
  }
  if (!appCheckValid) {
    res.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
    return null;
  }
  return requestAuth;
};

module.exports = { authorizeAppSessionMobileRequest };
