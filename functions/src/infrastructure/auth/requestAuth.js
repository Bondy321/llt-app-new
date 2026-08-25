'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../database/firebaseKey');
const { log } = require('../logging/safeLogger');

/** @param {any} req */
const getBearerToken = (req) => {
  const headerValue = req.headers?.authorization || req.headers?.Authorization;
  if (typeof headerValue !== 'string') return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1]?.trim() || null : null;
};

/** @param {any} req */
const verifyRequestAuthUid = async (req) => {
  const token = getBearerToken(req);
  if (!token) return { success: false, reason: 'AUTH_TOKEN_MISSING' };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
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
