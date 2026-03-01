const { createPersistenceProvider } = require('./persistenceProvider');
let logger = console;
try {
  const loggerImport = require('./loggerService');
  logger = loggerImport.default || loggerImport;
} catch (error) {
  logger = console;
}
const { parseTimestampMs } = require('./timeUtils');
const storage = createPersistenceProvider({ namespace: 'LLT_OFFLINE' });

const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 5;
const QUEUE_KEY = 'queue_v1';
const PROCESSED_ACTIONS_KEY = 'processed_action_ids_v1';
const MAX_PROCESSED_IDS = 500;

const UNIFIED_SYNC_STATES = {
  OFFLINE_NO_NETWORK: {
    label: 'Offline',
    description: 'No network connection. Changes are saved and will sync when online.',
    severity: 'critical',
    icon: 'wifi-off',
    canRetry: false,
    showLastSync: true,
  },
  ONLINE_BACKEND_DEGRADED: {
    label: 'Service issue',
    description: 'Connected to network, but the sync service is temporarily unavailable.',
    severity: 'warning',
    icon: 'cloud-alert',
    canRetry: true,
    showLastSync: true,
  },
  ONLINE_BACKLOG_PENDING: {
    label: 'Syncing backlog',
    description: 'Connection restored. Pending updates are still being processed.',
    severity: 'info',
    icon: 'clock-sync',
    canRetry: true,
    showLastSync: true,
  },
  ONLINE_HEALTHY: {
    label: 'Up to date',
    description: 'Everything is synced and working normally.',
    severity: 'success',
    icon: 'cloud-check',
    canRetry: false,
    showLastSync: true,
  },
};

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

const SYNC_SUMMARY_SOURCES = new Set(['unknown', 'manual-refresh', 'auto-replay', 'startup']);

const normalizeSyncCount = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 0;
  return Math.max(0, Math.trunc(numericValue));
};

// Counts are normalized by truncating toward zero (e.g. 2.9 -> 2) and clamping negatives to 0.
const buildSyncSummary = (input = {}) => {
  const summary = input && typeof input === 'object' ? input : {};
  const normalizedSource = typeof summary.source === 'string' && SYNC_SUMMARY_SOURCES.has(summary.source)
    ? summary.source
    : 'unknown';

  return {
    syncedCount: normalizeSyncCount(summary.syncedCount),
    pendingCount: normalizeSyncCount(summary.pendingCount),
    failedCount: normalizeSyncCount(summary.failedCount),
    lastSuccessAt: summary.lastSuccessAt ?? null,
    source: normalizedSource,
  };
};

const formatSyncOutcome = (summaryInput) => {
  const summary = buildSyncSummary(summaryInput);
  return `${summary.syncedCount} synced / ${summary.pendingCount} pending / ${summary.failedCount} failed`;
};

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
  const ts = parseTimestampMs(lastSyncedAt);
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

  const ts = parseTimestampMs(lastSyncedAt);
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

const deriveUnifiedSyncStatus = ({ network = {}, backend = {}, queue = {}, lastSyncAt = null } = {}) => {
  const networkOnline = Boolean(network.isOnline);
  const backendReachable = backend.isReachable !== false;
  const backendDegraded = Boolean(backend.isDegraded);
  const backendHealthy = networkOnline && backendReachable && !backendDegraded;

  const pending = Math.max(0, Number(queue.pending) || 0);
  const syncing = Math.max(0, Number(queue.syncing) || 0);
  const failed = Math.max(0, Number(queue.failed) || 0);
  const total = Math.max(0, Number(queue.total) || pending + syncing + failed);
  const hasBacklog = pending > 0 || syncing > 0 || failed > 0;

  let stateKey = 'ONLINE_HEALTHY';
  if (!networkOnline) {
    stateKey = 'OFFLINE_NO_NETWORK';
  } else if (!backendHealthy) {
    stateKey = 'ONLINE_BACKEND_DEGRADED';
  } else if (hasBacklog) {
    stateKey = 'ONLINE_BACKLOG_PENDING';
  }

  return {
    stateKey,
    ...UNIFIED_SYNC_STATES[stateKey],
    syncSummary: {
      networkOnline,
      backendHealthy,
      backendReachable,
      backendDegraded,
      pending,
      syncing,
      failed,
      total,
      hasBacklog,
      lastSyncAt,
    },
  };
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
    queue.sort((a, b) => (parseTimestampMs(a.createdAt) || 0) - (parseTimestampMs(b.createdAt) || 0));
    await setQueueRaw(queue);
    return RESPONSE.ok(entry);
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const getQueuedActions = async () => {
  try {
    const queue = await getQueueRaw();
    return RESPONSE.ok(queue.sort((a, b) => (parseTimestampMs(a.createdAt) || 0) - (parseTimestampMs(b.createdAt) || 0)));
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
    const stats = queue.reduce(
      (acc, action) => {
        if (action.status === 'syncing') acc.syncing += 1;
        else if (action.status === 'failed') acc.failed += 1;
        else acc.pending += 1;
        return acc;
      },
      { pending: 0, syncing: 0, failed: 0, total: queue.length }
    );
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
    if (queue.length === 0) {
      return RESPONSE.ok({ processed: 0, failed: 0 });
    }

    const sortedQueue = [...queue].sort((a, b) => (parseTimestampMs(a.createdAt) || 0) - (parseTimestampMs(b.createdAt) || 0));
    let processedActionIds = await getProcessedActionIds();
    let processed = 0;
    let failed = 0;

    for (const action of sortedQueue) {
      if (processedActionIds.includes(action.id)) {
        await removeAction(action.id);
        continue;
      }

      if (action.status === 'failed') {
        continue;
      }

      const now = Date.now();
      const nextAttemptAt = parseTimestampMs(action.nextAttemptAt) || 0;
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

    return RESPONSE.ok({ processed, failed });
  } catch (error) {
    return RESPONSE.fail(error);
  } finally {
    replayLock = false;
    await emitQueueState();
  }
};

module.exports = {
  SCHEMA_VERSION,
  buildSyncSummary,
  formatSyncOutcome,
  UNIFIED_SYNC_STATES,
  deriveUnifiedSyncStatus,
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
