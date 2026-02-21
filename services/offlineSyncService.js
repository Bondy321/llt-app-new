const { createPersistenceProvider } = require('./persistenceProvider');
let logger = console;
try {
  const loggerImport = require('./loggerService');
  logger = loggerImport.default || loggerImport;
} catch (error) {
  logger = console;
}
const storage = createPersistenceProvider({ namespace: 'LLT_OFFLINE' });

const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 5;
const WARN_FAILED_ACTIONS_COUNT = 3;
const WARN_OLDEST_PENDING_AGE_HOURS = 2;
const WARN_SKIPPED_FAILED_ACTIONS_COUNT = 5;
const QUEUE_KEY = 'queue_v1';
const PROCESSED_ACTIONS_KEY = 'processed_action_ids_v1';
const MAX_PROCESSED_IDS = 500;

const listeners = new Set();
let replayLock = false;

const RESPONSE = {
  ok: (data) => ({ success: true, data }),
  fail: (error) => ({ success: false, error: typeof error === 'string' ? error : error?.message || 'Unknown offline sync error' }),
};

const safeJsonParse = (raw, fallback) => {
  try {
    if (typeof raw !== 'string') return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const cacheKey = (tourId, role) => `tour_pack_${role}_${tourId}`;
const metaKey = (tourId, role) => `tour_pack_meta_${role}_${tourId}`;

const emitQueueState = async () => {
  const stats = await getQueueStats();
  listeners.forEach((listener) => {
    try {
      listener(stats.success ? stats.data : { pending: 0, syncing: 0, failed: 0, total: 0 });
    } catch (error) {
      logger.warn('OfflineSync', 'Queue listener failed', { error: error?.message });
    }
  });
};

const getQueueRaw = async () => {
  try {
    const raw = await storage.getItemAsync(QUEUE_KEY);
    const queue = safeJsonParse(raw, []);
    if (!Array.isArray(queue)) {
      await storage.setItemAsync(QUEUE_KEY, JSON.stringify([]));
      return [];
    }
    return queue.filter((item) => item && typeof item === 'object' && item.id && item.type);
  } catch (error) {
    logger.error('OfflineSync', 'Failed to read queue', { error: error?.message });
    await storage.setItemAsync(QUEUE_KEY, JSON.stringify([]));
    return [];
  }
};

const setQueueRaw = async (queue) => {
  try {
    await storage.setItemAsync(QUEUE_KEY, JSON.stringify(queue));
    await emitQueueState();
    return RESPONSE.ok(queue);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getProcessedActionIds = async () => {
  try {
    const raw = await storage.getItemAsync(PROCESSED_ACTIONS_KEY);
    const ids = safeJsonParse(raw, []);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
};

const setProcessedActionIds = async (ids) => {
  try {
    const bounded = ids.slice(-MAX_PROCESSED_IDS);
    await storage.setItemAsync(PROCESSED_ACTIONS_KEY, JSON.stringify(bounded));
    return RESPONSE.ok(bounded);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getStalenessBucket = (lastSyncedAt) => {
  if (!lastSyncedAt) return 'old';
  const ts = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(ts)) return 'old';
  const ageMs = Date.now() - ts;
  const ageMinutes = ageMs / (60 * 1000);
  if (ageMinutes <= 15) return 'fresh';
  if (ageMinutes <= 24 * 60) return 'stale';
  return 'old';
};

const getStalenessLabel = (lastSyncedAt) => {
  const bucket = getStalenessBucket(lastSyncedAt);
  if (!lastSyncedAt) {
    return { bucket, label: 'Not synced yet' };
  }

  const ts = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(ts)) {
    return { bucket: 'old', label: 'Not synced yet' };
  }

  const diffMinutes = Math.floor((Date.now() - ts) / (60 * 1000));
  if (diffMinutes < 1) return { bucket: 'fresh', label: 'Updated just now' };
  if (diffMinutes < 60) return { bucket: getStalenessBucket(lastSyncedAt), label: `Updated ${diffMinutes} min ago` };

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return { bucket: getStalenessBucket(lastSyncedAt), label: `Updated ${diffHours}h ago` };
  }

  return { bucket: 'old', label: 'Cached data from yesterday' };
};

const saveTourPack = async (tourId, role, payload) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const rawExistingPack = await storage.getItemAsync(cacheKey(tourId, role));
    const existingPack = safeJsonParse(rawExistingPack, {});
    const fetchedAt = payload?.fetchedAt || new Date().toISOString();
    const sourceVersion = payload?.sourceVersion || SCHEMA_VERSION;
    const nextPayload = {
      ...(existingPack && typeof existingPack === 'object' ? existingPack : {}),
      ...payload,
      fetchedAt,
      sourceVersion,
    };
    await storage.setItemAsync(cacheKey(tourId, role), JSON.stringify(nextPayload));
    return RESPONSE.ok(nextPayload);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getTourPack = async (tourId, role) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const raw = await storage.getItemAsync(cacheKey(tourId, role));
    const pack = safeJsonParse(raw, null);
    if (!pack) return RESPONSE.ok(null);
    return RESPONSE.ok(pack);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const setTourPackMeta = async (tourId, role, meta = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      lastSyncedAt: meta.lastSyncedAt || new Date().toISOString(),
      ...meta,
    };
    await storage.setItemAsync(metaKey(tourId, role), JSON.stringify(payload));
    return RESPONSE.ok(payload);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getTourPackMeta = async (tourId, role) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const raw = await storage.getItemAsync(metaKey(tourId, role));
    return RESPONSE.ok(safeJsonParse(raw, null));
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const buildAction = (action) => {
  const nowIso = new Date().toISOString();
  return {
    id: action.id || `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: action.type,
    tourId: action.tourId,
    createdAt: action.createdAt || nowIso,
    payload: action.payload || {},
    attempts: Number.isFinite(action.attempts) ? action.attempts : 0,
    status: action.status || 'queued',
    lastError: action.lastError || null,
    nextAttemptAt: action.nextAttemptAt || null,
    lastUpdatedAt: nowIso,
  };
};

const enqueueAction = async (action) => {
  try {
    if (!action?.type || !action?.tourId) {
      return RESPONSE.fail('type and tourId are required');
    }
    const queue = await getQueueRaw();
    const exists = queue.find((entry) => entry.id === action.id);
    if (exists) {
      return RESPONSE.ok(exists);
    }
    const entry = buildAction(action);
    queue.push(entry);
    queue.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    await setQueueRaw(queue);
    return RESPONSE.ok(entry);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getQueuedActions = async () => {
  try {
    const queue = await getQueueRaw();
    return RESPONSE.ok(queue.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const updateAction = async (id, patch = {}) => {
  try {
    const queue = await getQueueRaw();
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) return RESPONSE.fail('Action not found');
    queue[index] = {
      ...queue[index],
      ...patch,
      lastUpdatedAt: new Date().toISOString(),
    };
    await setQueueRaw(queue);
    return RESPONSE.ok(queue[index]);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const removeAction = async (id) => {
  try {
    const queue = await getQueueRaw();
    const nextQueue = queue.filter((entry) => entry.id !== id);
    await setQueueRaw(nextQueue);
    return RESPONSE.ok(true);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getQueueStats = async () => {
  try {
    const queue = await getQueueRaw();
    const now = Date.now();

    const stats = queue.reduce(
      (acc, action) => {
        const createdAtTs = new Date(action.createdAt).getTime();
        const actionAgeMs = Number.isFinite(createdAtTs) ? Math.max(0, now - createdAtTs) : null;
        if (actionAgeMs !== null) {
          acc.oldestActionAgeMs = acc.oldestActionAgeMs === null ? actionAgeMs : Math.max(acc.oldestActionAgeMs, actionAgeMs);
        }

        if (action.status === 'syncing') acc.syncing += 1;
        else if (action.status === 'failed') {
          acc.failed += 1;
          acc.skippedFailedActions += 1;
        } else {
          acc.pending += 1;
          if (actionAgeMs !== null) {
            acc.oldestPendingAgeMs = acc.oldestPendingAgeMs === null ? actionAgeMs : Math.max(acc.oldestPendingAgeMs, actionAgeMs);
          }
        }
        return acc;
      },
      {
        pending: 0,
        syncing: 0,
        failed: 0,
        skippedFailedActions: 0,
        oldestActionAgeMs: null,
        oldestPendingAgeMs: null,
        total: queue.length,
      }
    );

    const oldestPendingAgeHours = stats.oldestPendingAgeMs === null ? 0 : Number((stats.oldestPendingAgeMs / (60 * 60 * 1000)).toFixed(2));
    const healthWarnings = [];
    if (stats.failed > WARN_FAILED_ACTIONS_COUNT) {
      healthWarnings.push('failed_actions_threshold');
    }
    if (oldestPendingAgeHours > WARN_OLDEST_PENDING_AGE_HOURS) {
      healthWarnings.push('pending_age_threshold');
    }
    if (stats.skippedFailedActions > WARN_SKIPPED_FAILED_ACTIONS_COUNT) {
      healthWarnings.push('skipped_failed_threshold');
    }

    stats.oldestPendingAgeHours = oldestPendingAgeHours;
    stats.health = healthWarnings.length > 0 ? 'degraded' : 'healthy';
    stats.healthWarnings = healthWarnings;

    return RESPONSE.ok(stats);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const subscribeQueueState = (listener) => {
  if (typeof listener !== 'function') {
    return () => {};
  }

  listeners.add(listener);
  getQueueStats().then((stats) => {
    if (stats.success) listener(stats.data);
  });

  return () => {
    listeners.delete(listener);
  };
};

const applyReplayAction = async (action, services = {}) => {
  const { bookingService, chatService, db } = services;

  if (action.type === 'MANIFEST_UPDATE' && bookingService?.applyManifestUpdateDirect) {
    return bookingService.applyManifestUpdateDirect(action.payload, db);
  }

  if (action.type === 'CHAT_MESSAGE' && chatService?.sendMessageDirect) {
    return chatService.sendMessageDirect(action.payload, db);
  }

  if (action.type === 'INTERNAL_CHAT_MESSAGE' && chatService?.sendInternalMessageDirect) {
    return chatService.sendInternalMessageDirect(action.payload, db);
  }

  return RESPONSE.fail(`Unsupported replay action type: ${action.type}`);
};

const replayQueue = async ({ db, services = {} } = {}) => {
  if (replayLock) {
    return RESPONSE.ok({ skipped: true, reason: 'Replay already in progress' });
  }

  replayLock = true;

  try {
    const queue = await getQueueRaw();
    const oldestQueuedActionAgeMs = queue.reduce((oldest, action) => {
      const createdAtTs = new Date(action.createdAt).getTime();
      if (!Number.isFinite(createdAtTs)) return oldest;
      const ageMs = Math.max(0, Date.now() - createdAtTs);
      return Math.max(oldest, ageMs);
    }, 0);

    logger.info('OfflineSync', 'Offline replay started', {
      queueLength: queue.length,
      skippedFailedActionsCount: queue.filter((action) => action.status === 'failed').length,
      oldestQueuedActionAgeMs,
      thresholds: {
        failedActions: WARN_FAILED_ACTIONS_COUNT,
        oldestPendingAgeHours: WARN_OLDEST_PENDING_AGE_HOURS,
        skippedFailedActions: WARN_SKIPPED_FAILED_ACTIONS_COUNT,
      },
    });

    if (queue.length === 0) {
      logger.info('OfflineSync', 'Offline replay ended', {
        processed: 0,
        failed: 0,
        skippedFailedActionsCount: 0,
        oldestQueuedActionAgeMs: 0,
      });
      return RESPONSE.ok({ processed: 0, failed: 0, skippedFailedActionsCount: 0 });
    }

    const sortedQueue = [...queue].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let processedActionIds = await getProcessedActionIds();
    let processed = 0;
    let failed = 0;
    let skippedFailedActionsCount = 0;

    for (const action of sortedQueue) {
      if (processedActionIds.includes(action.id)) {
        await removeAction(action.id);
        continue;
      }

      if (action.status === 'failed') {
        skippedFailedActionsCount += 1;
        continue;
      }

      const now = Date.now();
      const nextAttemptAt = action.nextAttemptAt ? new Date(action.nextAttemptAt).getTime() : 0;
      if (nextAttemptAt && nextAttemptAt > now) {
        continue;
      }

      await updateAction(action.id, { status: 'syncing', lastError: null });
      const result = await applyReplayAction(action, { ...services, db });

      if (result?.success) {
        processed += 1;
        await removeAction(action.id);
        processedActionIds = [...processedActionIds, action.id];
        await setProcessedActionIds(processedActionIds);
      } else {
        failed += 1;
        const attempts = (action.attempts || 0) + 1;
        const shouldFail = attempts >= MAX_ATTEMPTS;
        const delayMinutes = Math.min(2 ** attempts, 60);
        await updateAction(action.id, {
          attempts,
          status: shouldFail ? 'failed' : 'queued',
          lastError: result?.error || 'Replay failed',
          nextAttemptAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        });
      }
    }

    logger[failed > WARN_FAILED_ACTIONS_COUNT ? 'warn' : 'info']('OfflineSync', 'Offline replay ended', {
      processed,
      failed,
      skippedFailedActionsCount,
      oldestQueuedActionAgeMs,
      health: failed > WARN_FAILED_ACTIONS_COUNT ? 'degraded' : 'healthy',
    });

    return RESPONSE.ok({ processed, failed, skippedFailedActionsCount });
  } catch (error) {
    return RESPONSE.fail(error);
  } finally {
    replayLock = false;
    await emitQueueState();
  }
};

module.exports = {
  SCHEMA_VERSION,
  WARN_FAILED_ACTIONS_COUNT,
  WARN_OLDEST_PENDING_AGE_HOURS,
  WARN_SKIPPED_FAILED_ACTIONS_COUNT,
  saveTourPack,
  getTourPack,
  setTourPackMeta,
  getTourPackMeta,
  enqueueAction,
  getQueuedActions,
  updateAction,
  removeAction,
  getQueueStats,
  replayQueue,
  subscribeQueueState,
  getStalenessBucket,
  getStalenessLabel,
};
