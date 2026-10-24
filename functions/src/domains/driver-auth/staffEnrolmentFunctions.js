'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { verifyOperationsAdminAccess } = require('../administration/public');
const { normalizeDriverId } = require('../driver-assignment/public');
const { checkDistributedRequestLimit } = require('../../infrastructure/rate-limit/distributedRequestLimiter');
const { issueStaffEnrolment, revokeStaffEnrolment } = require('./staffEnrolment');

const authorizeStaffAdministration = async ({ req, db, nowMs = Date.now() }) => {
  const auth = await verifyRequestAuthUid(req);
  if (!auth.success) return { allowed: false, status: 401, reason: 'NOT_AUTHENTICATED' };
  if (!(await verifyOperationsAdminAccess({ db, authUid: auth.uid }))) {
    return { allowed: false, status: 403, reason: 'NOT_AUTHORIZED' };
  }
  // Firebase supplies this verified MFA claim. UI flags/profile fields are
  // deliberately irrelevant. Owner must enable/enrol MFA in Identity Platform.
  if (auth.claims?.firebase?.sign_in_second_factor !== 'totp'
    || !Number.isSafeInteger(auth.claims.auth_time)
    || auth.claims.auth_time * 1000 > nowMs
    || nowMs - auth.claims.auth_time * 1000 > 10 * 60 * 1000) {
    return { allowed: false, status: 403, reason: 'RECENT_MFA_REQUIRED' };
  }
  return { allowed: true, authUid: auth.uid };
};

const staffDeviceEnrolment = onRequest({ region: 'europe-west1', maxInstances: 5,
  timeoutSeconds: 30, cors: false }, async (req, res) => {
  if (!applyAuthenticatedCors(req, res)) return res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
  const db = admin.database();
  const access = await authorizeStaffAdministration({ req, db });
  if (!access.allowed) return res.status(access.status).json({ success: false, reason: access.reason });
  const driverId = normalizeDriverId(req.body?.driverId);
  const action = req.body?.action;
  if (!driverId || !['issue', 'replace', 'revoke'].includes(action)) {
    return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
  }
  if (!(await checkDistributedRequestLimit({ req, authUid: access.authUid,
    action: 'staff_device_enrolment', maxRequests: 20, db }))) {
    return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
  }
  try {
    const result = action === 'revoke'
      ? await revokeStaffEnrolment({ db, driverId, adminUid: access.authUid })
      : await issueStaffEnrolment({ db, driverId, adminUid: access.authUid, replace: action === 'replace' });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.code === 'DRIVER_NOT_FOUND' ? 404 : 503)
      .json({ success: false, reason: error.code === 'DRIVER_NOT_FOUND' ? error.code : 'SERVICE_UNAVAILABLE' });
  }
});

module.exports = { staffDeviceEnrolment, authorizeStaffAdministration };
