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
    log.error('Admin broadcast verification failed', error, { senderUid });
    return false;
  }
};

module.exports = { verifyAdminBroadcast };
