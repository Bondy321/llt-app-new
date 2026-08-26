'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const { verifyOperationsAdminAccess } = require('../administration/public');

/** @type {(...args: any[]) => Promise<boolean>} */
const verifyAdminBroadcast = async (messageData) => {
  const { senderUid } = messageData;
  if (!senderUid || typeof senderUid !== 'string') return false;
  try {
    const userRecord = await admin.auth().getUser(senderUid);
    if (!userRecord || userRecord.disabled) return false;
    return userRecord.providerData.length > 0
      && await verifyOperationsAdminAccess({ authUid: senderUid });
  } catch (error) {
    if (error?.code === 'auth/user-not-found' || error?.code === 'auth/invalid-uid') return false;
    log.error('Admin broadcast verification deferred for retry', error, { senderUid });
    throw error;
  }
};

module.exports = { verifyAdminBroadcast };
