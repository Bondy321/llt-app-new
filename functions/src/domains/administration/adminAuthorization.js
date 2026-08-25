'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');

const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';

/** @param {{ authUid: string, db?: any }} input */
const verifyOperationsAdminAccess = async ({ authUid, db = admin.database() }) => {
  if (!isValidFirebaseKey(authUid)) return false;
  if (authUid === OPERATIONS_ADMIN_UID) return true;
  const snapshot = await db.ref(`admin_users/${authUid}`).once('value');
  return snapshot.val() === true;
};

module.exports = { OPERATIONS_ADMIN_UID, verifyOperationsAdminAccess };
