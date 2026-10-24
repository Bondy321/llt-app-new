'use strict';

const { issueStaffEnrolment, redeemStaffEnrolment } = require('../../functions/src/domains/driver-auth/staffEnrolment');
const { captureInstallationAuthority } = require('../../functions/lib/sessionPublicationAuthority');

// Test-only explicit admin approval. Exercise the real private code/redemption
// protocol rather than adding a production fallback for old fixture profiles.
const enrolSyntheticDriver = async ({ db, authUid, driverId, nowMs = Date.now() }) => {
  const code = await issueStaffEnrolment({ db, driverId, adminUid: 'synthetic-admin', nowMs });
  const capturedAuthority = await captureInstallationAuthority({ db, authUid });
  const staffAuthorization = await redeemStaffEnrolment({ db, authUid, driverId,
    secret: code.secret, capturedAuthority, nowMs });
  return { staffAuthorization, capturedAuthority };
};

module.exports = { enrolSyntheticDriver };
