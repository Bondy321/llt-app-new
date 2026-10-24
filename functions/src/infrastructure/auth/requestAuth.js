'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../database/firebaseKey');
const { log } = require('../logging/safeLogger');
const { getBearerToken } = require('./requestBoundary');
const { verifyHttpAppCheck } = require('./httpAppCheck');

/** @param {any} req */
const verifyRequestAuthUid = async (req) => {
  const token = getBearerToken(req);
  if (!token) return { success: false, reason: 'AUTH_TOKEN_MISSING' };
  if (!(await verifyHttpAppCheck(req))) return { success: false, reason: 'APP_CHECK_REQUIRED' };
  try {
    // Signature/expiry alone do not reject an administratively disabled or
    // revoked Firebase identity. Privileged HTTP routes share this boundary.
    const decoded = await admin.auth().verifyIdToken(token, true);
    const uid = typeof decoded?.uid === 'string' ? decoded.uid.trim() : '';
    if (!uid || !isValidFirebaseKey(uid)) return { success: false, reason: 'AUTH_UID_INVALID' };
    return { success: true, uid, claims: decoded };
  } catch (error) {
    const details = /** @type {{ code?: unknown, message?: unknown }} */ (error || {});
    log.warn('Request auth token verification failed', {
      reason: details.code || 'AUTH_TOKEN_INVALID',
      error: details.message || String(error),
    });
    return { success: false, reason: 'AUTH_TOKEN_INVALID' };
  }
};

module.exports = { getBearerToken, verifyRequestAuthUid };
