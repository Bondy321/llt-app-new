'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');

const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';

/** @param {{ authUid: string, db?: any, claims?: any, requireSecondFactor?: boolean }} input */
const verifyOperationsAdminAccess = async ({ authUid, db = admin.database(), claims, requireSecondFactor = false }) => {
  if (!isValidFirebaseKey(authUid)) return false;
  if (requireSecondFactor && claims?.firebase?.sign_in_second_factor !== 'totp') return false;
  if (authUid === OPERATIONS_ADMIN_UID) return true;
  const snapshot = await db.ref(`admin_users/${authUid}`).once('value');
  return snapshot.val() === true;
};

module.exports = { OPERATIONS_ADMIN_UID, verifyOperationsAdminAccess };
