import { maskIdentifier } from './loggerService';

const MIGRATION_LIMIT = 300;
const MIGRATION_TIMEOUT_MS = 5000;

let hasRunThisLaunch = false;

const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timeoutId = setTimeout(() => {
    reject(new Error('CHAT_IDENTITY_MIGRATION_TIMEOUT'));
  }, timeoutMs);

  promise
    .then((result) => {
      clearTimeout(timeoutId);
      resolve(result);
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
});

const migrateRecentChatMessagesInternal = async ({ tourId, currentAuthUid, stablePassengerId, realtimeDb, logger }) => {
  const startedAt = Date.now();
  let scannedCount = 0;
  let patchedCount = 0;
  let skippedCount = 0;

  const messagesSnapshot = await realtimeDb
    .ref(`chats/${tourId}/messages`)
    .orderByChild('timestamp')
    .limitToLast(MIGRATION_LIMIT)
    .once('value');

  const messages = messagesSnapshot.val() || {};
  const updates = {};

  Object.entries(messages).forEach(([messageId, message]) => {
    scannedCount += 1;

    if (!message || typeof message !== 'object') {
      skippedCount += 1;
      return;
    }

    if (message.senderStableId) {
      skippedCount += 1;
      return;
    }

    if (message.senderId === currentAuthUid) {
      updates[`chats/${tourId}/messages/${messageId}/senderStableId`] = stablePassengerId;
      patchedCount += 1;
      return;
    }

    skippedCount += 1;
  });

  if (patchedCount > 0) {
    await realtimeDb.ref().update(updates);
  }

  const durationMs = Date.now() - startedAt;
  logger.info('ChatIdentityMigration', 'Migration metrics', {
    tourId,
    authUid: maskIdentifier(currentAuthUid),
    stablePassengerId: maskIdentifier(stablePassengerId),
    scannedCount,
    patchedCount,
    skippedCount,
    durationMs,
  });
};

export const migrateRecentChatMessagesForStableIdentity = async ({
  tourId,
  currentAuthUid,
  stablePassengerId,
  realtimeDb,
  logger,
}) => {
  if (hasRunThisLaunch) {
    return;
  }

  if (!tourId || !currentAuthUid || !stablePassengerId || !realtimeDb || !logger) {
    return;
  }

  hasRunThisLaunch = true;

  const startedAt = Date.now();

  try {
    await withTimeout(
      migrateRecentChatMessagesInternal({
        tourId,
        currentAuthUid,
        stablePassengerId,
        realtimeDb,
        logger,
      }),
      MIGRATION_TIMEOUT_MS,
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.warn('ChatIdentityMigration', 'Migration skipped due to soft failure', {
      reason: error?.message || 'UNKNOWN_ERROR',
      tourId,
      authUid: maskIdentifier(currentAuthUid),
      stablePassengerId: maskIdentifier(stablePassengerId),
      scannedCount: 0,
      patchedCount: 0,
      skippedCount: 0,
      durationMs,
    });
  }
};
