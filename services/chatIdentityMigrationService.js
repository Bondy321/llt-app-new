import { maskIdentifier } from './loggerService';

const MIGRATION_LIMIT = 300;
const MIGRATION_TIMEOUT_MS = 5000;
const activeMigrations = new Map();

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

const loadBoundAuthUids = async ({ realtimeDb, stablePassengerId }) => {
  const snapshot = await realtimeDb.ref(`identity_bindings/${stablePassengerId}`).once('value');
  const bindings = snapshot.val() || {};

  const boundAuthUids = new Set();
  Object.entries(bindings).forEach(([uid, linked]) => {
    if (linked !== true || typeof uid !== 'string') return;
    const normalizedUid = uid.trim();
    if (!normalizedUid) return;
    boundAuthUids.add(normalizedUid);
  });

  return boundAuthUids;
};

const migrateRecentChatMessagesInternal = async ({ tourId, stablePassengerId, realtimeDb, logger }) => {
  const startedAt = Date.now();
  let scannedCount = 0;
  let patchedCount = 0;
  let skippedCount = 0;

  const boundAuthUids = await loadBoundAuthUids({ realtimeDb, stablePassengerId });
  if (boundAuthUids.size === 0) {
    logger.info('ChatIdentityMigration', 'No identity bindings found for passenger principal', {
      tourId,
      stablePassengerId: maskIdentifier(stablePassengerId),
      boundUidCount: 0,
      scannedCount,
      patchedCount,
      skippedCount,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

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

    if (typeof message.senderStableId === 'string' && message.senderStableId.trim().length > 0) {
      skippedCount += 1;
      return;
    }

    const senderId = typeof message.senderId === 'string' ? message.senderId.trim() : '';
    if (!senderId || !boundAuthUids.has(senderId)) {
      skippedCount += 1;
      return;
    }

    updates[`chats/${tourId}/messages/${messageId}/senderStableId`] = stablePassengerId;
    updates[`chats/${tourId}/messages/${messageId}/senderType`] = 'passenger';
    patchedCount += 1;
  });

  if (patchedCount > 0) {
    await realtimeDb.ref().update(updates);
  }

  const durationMs = Date.now() - startedAt;
  logger.info('ChatIdentityMigration', 'Migration metrics', {
    tourId,
    stablePassengerId: maskIdentifier(stablePassengerId),
    boundUidCount: boundAuthUids.size,
    scannedCount,
    patchedCount,
    skippedCount,
    durationMs,
  });
};

export const migrateRecentChatMessagesForStableIdentity = async ({
  tourId,
  stablePassengerId,
  realtimeDb,
  logger,
}) => {
  if (!tourId || !stablePassengerId || !realtimeDb || !logger) {
    return;
  }

  const migrationKey = `${tourId}::${stablePassengerId}`;
  if (activeMigrations.has(migrationKey)) {
    return activeMigrations.get(migrationKey);
  }

  const runPromise = (async () => {
    const startedAt = Date.now();

    try {
      await withTimeout(
        migrateRecentChatMessagesInternal({
          tourId,
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
        stablePassengerId: maskIdentifier(stablePassengerId),
        scannedCount: 0,
        patchedCount: 0,
        skippedCount: 0,
        durationMs,
      });
    } finally {
      activeMigrations.delete(migrationKey);
    }
  })();

  activeMigrations.set(migrationKey, runPromise);
  return runPromise;
};

