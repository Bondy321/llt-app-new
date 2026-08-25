const {
  HEALTH_STATE,
  UNIFIED_SYNC_STATES,
  logger,
  parseTimestampMs,
  storage,
  QUEUE_KEY,
  QUEUE_CORRUPT_BACKUP_KEY,
  PROCESSED_ACTIONS_KEY,
  LAST_SUCCESS_AT_KEY,
  MAX_PROCESSED_IDS,
  listeners,
  queueListeners,
  runtimeState,
  RESPONSE,
  toSortableTimestampMs,
  summarizeQueueActionForLog,
  filterActionsForScope,
  safeJsonParse,
  pruneCompletedPhotoUploadActions,
  sanitizeActionRecord,
} = require('./offlineSyncContext');

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

const setLastSuccessAt = async (timestampOrNow = Date.now()) => {
  try {
    const parsed = parseTimestampMs(timestampOrNow);
    const nextValue = Number.isFinite(parsed) ? parsed : Date.now();
    await storage.setItemAsync(LAST_SUCCESS_AT_KEY, String(nextValue));
    return RESPONSE.ok(nextValue);
  } catch (error) {
    logger.error('OfflineSync', 'Failed to persist last successful sync timestamp', { error: error?.message });
    return RESPONSE.fail(error);
  }
};

const getLastSuccessAt = async () => {
  try {
    const raw = await storage.getItemAsync(LAST_SUCCESS_AT_KEY);
    const parsed = parseTimestampMs(raw);
    return RESPONSE.ok(Number.isFinite(parsed) ? parsed : null);
  } catch (error) {
    logger.error('OfflineSync', 'Failed to read last successful sync timestamp', { error: error?.message });
    return RESPONSE.ok(null);
  }
};

const formatLastSyncRelative = (lastSuccessAt, now = Date.now()) => {
  const nowMs = parseTimestampMs(now);
  const successMs = parseTimestampMs(lastSuccessAt);

  if (!Number.isFinite(nowMs) || !Number.isFinite(successMs) || successMs > nowMs) {
    return 'Never';
  }

  const diffMinutes = Math.floor((nowMs - successMs) / (60 * 1000));
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const nowDate = new Date(nowMs);
  const successDate = new Date(successMs);
  const nowDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const successDay = new Date(successDate.getFullYear(), successDate.getMonth(), successDate.getDate());
  const dayDiff = Math.floor((nowDay.getTime() - successDay.getTime()) / (24 * 60 * 60 * 1000));

  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff > 1) return `${dayDiff}d ago`;

  return 'Never';
};

const buildQueueStats = (queue) => queue.reduce(
  (acc, action) => {
    if (action.status === 'uploading' || action.status === 'syncing') acc.syncing += 1;
    else if (action.status === 'failed') acc.failed += 1;
    else if (action.status !== 'completed') acc.pending += 1;
    return acc;
  },
  { pending: 0, syncing: 0, failed: 0, total: queue.length },
);

const emitQueueState = async () => {
  const queue = await getQueueRaw();
  listeners.forEach((subscription) => {
    try {
      const visibleQueue = filterActionsForScope(
        queue,
        subscription.usesActiveScope ? runtimeState.activeSessionScope : subscription.scope,
      );
      subscription.listener(buildQueueStats(visibleQueue));
    } catch (error) {
      logger.warn('OfflineSync', 'Queue listener failed', { error: error?.message });
    }
  });

  queueListeners.forEach((subscription) => {
    try {
      subscription.listener(filterActionsForScope(
        queue,
        subscription.usesActiveScope ? runtimeState.activeSessionScope : subscription.scope,
      ));
    } catch (error) {
      logger.warn('OfflineSync', 'Queue actions listener failed', { error: error?.message });
    }
  });
};

// Reads are side-effect free by default so a background observer cannot write a
// sanitized stale snapshot over a concurrent enqueue. Callers already holding
// the mutation lock opt into durable repair.
const getQueueRaw = async ({ persistRepairs = false } = {}) => {
  try {
    const raw = await storage.getItemAsync(QUEUE_KEY);
    let queue = [];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        queue = JSON.parse(raw);
      } catch (parseError) {
        if (persistRepairs) {
          await storage.setItemAsync(QUEUE_CORRUPT_BACKUP_KEY, raw);
          await storage.setItemAsync(QUEUE_KEY, JSON.stringify([]));
        }
        logger.error('OfflineSync', 'Malformed queue backed up before recovery', {
          error: parseError?.message,
          rawLength: raw.length,
          repairPersisted: persistRepairs,
        });
        return [];
      }
    }
    if (!Array.isArray(queue)) {
      if (persistRepairs) {
        await storage.setItemAsync(QUEUE_CORRUPT_BACKUP_KEY, JSON.stringify(queue));
        await storage.setItemAsync(QUEUE_KEY, JSON.stringify([]));
      }
      return [];
    }

    const sanitizedQueue = queue
      .map((item) => sanitizeActionRecord(item))
      .filter(Boolean)
      .sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt));

    const pruneResult = pruneCompletedPhotoUploadActions(sanitizedQueue);
    const sanitizedAndPrunedQueue = pruneResult.queue;

    if (sanitizedAndPrunedQueue.length !== queue.length || JSON.stringify(sanitizedAndPrunedQueue) !== JSON.stringify(queue)) {
      logger.warn('OfflineSync', 'Queue data was sanitized to remove or repair invalid entries', {
        previousCount: queue.length,
        sanitizedCount: sanitizedQueue.length,
        prunedCompletedPhotoUploads: pruneResult.removedCount,
      });
      if (persistRepairs) {
        await storage.setItemAsync(QUEUE_KEY, JSON.stringify(sanitizedAndPrunedQueue));
      }
    }

    return sanitizedAndPrunedQueue;
  } catch (error) {
    logger.error('OfflineSync', 'Failed to read queue', { error: error?.message });
    // Never turn a transient storage failure into an empty queue. Doing so lets
    // the next enqueue overwrite pending actions that still exist on disk.
    throw error;
  }
};

const setQueueRaw = async (queue, options = {}) => {
  try {
    const pruneResult = pruneCompletedPhotoUploadActions(queue);
    await storage.setItemAsync(QUEUE_KEY, JSON.stringify(pruneResult.queue));
    logger.debug('OfflineSync', 'Queue persisted', {
      queueCount: pruneResult.queue.length,
      prunedCompletedPhotoUploads: pruneResult.removedCount,
      silent: Boolean(options.silent),
      statusCounts: pruneResult.queue.reduce((acc, action) => {
        const status = action?.status || 'unknown';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {}),
      typeCounts: pruneResult.queue.reduce((acc, action) => {
        const type = action?.type || 'unknown';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {}),
      sample: pruneResult.queue.slice(0, 8).map(summarizeQueueActionForLog),
    });
    if (!options.silent) {
      await emitQueueState();
    }
    return RESPONSE.ok(pruneResult.queue);
  } catch (error) {
    logger.error('OfflineSync', 'Failed to persist queue', {
      error: error?.message,
      inputCount: Array.isArray(queue) ? queue.length : null,
      silent: Boolean(options.silent),
    });
    throw error;
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

const getStalenessLabel = (lastSyncedAt, now = Date.now()) => {
  if (!lastSyncedAt) {
    return { bucket: 'old', label: 'Not synced yet' };
  }

  const ts = parseTimestampMs(lastSyncedAt);
  const nowMs = parseTimestampMs(now);
  if (!Number.isFinite(ts)) {
    return { bucket: 'old', label: 'Not synced yet' };
  }

  if (!Number.isFinite(nowMs)) {
    return { bucket: 'old', label: 'Not synced yet' };
  }

  const diffMs = nowMs - ts;
  const ageMinutes = diffMs / (60 * 1000);
  const bucket = ageMinutes <= 15 ? 'fresh' : ageMinutes <= 24 * 60 ? 'stale' : 'old';
  if (diffMs <= 0) {
    return { bucket: 'fresh', label: 'Updated just now' };
  }

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 1) return { bucket: 'fresh', label: 'Updated just now' };
  if (diffMinutes < 60) return { bucket, label: `Updated ${diffMinutes} min ago` };

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return { bucket, label: `Updated ${diffHours}h ago` };
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return { bucket: 'old', label: 'Cached data from yesterday' };
  }

  return { bucket: 'old', label: `Cached data from ${diffDays} days ago` };
};

const deriveUnifiedSyncStatus = ({
  network = {},
  backend = {},
  queue = {},
  lastSyncAt = null,
  syncSummary = {},
} = {}) => {
  const networkOnline = Boolean(network.isOnline);
  const backendReachable = backend.isReachable !== false;
  const backendDegraded = Boolean(backend.isDegraded);
  const backendHealthy = networkOnline && backendReachable && !backendDegraded;

  const pending = Math.max(0, Number(queue.pending) || 0);
  const syncing = Math.max(0, Number(queue.syncing) || 0);
  const failed = Math.max(0, Number(queue.failed) || 0);
  const hasBacklog = pending > 0 || syncing > 0 || failed > 0;

  let stateKey = HEALTH_STATE.ONLINE_HEALTHY;
  if (!networkOnline) {
    stateKey = HEALTH_STATE.OFFLINE_NO_NETWORK;
  } else if (!backendHealthy) {
    stateKey = HEALTH_STATE.ONLINE_BACKEND_DEGRADED;
  } else if (hasBacklog) {
    stateKey = HEALTH_STATE.ONLINE_BACKLOG_PENDING;
  }

  return {
    stateKey,
    ...UNIFIED_SYNC_STATES[stateKey],
    syncSummary: buildSyncSummary({
      pendingCount: pending,
      failedCount: failed,
      lastSuccessAt: lastSyncAt,
      ...syncSummary,
    }),
  };
};
module.exports = {
  SYNC_SUMMARY_SOURCES,
  normalizeSyncCount,
  buildSyncSummary,
  formatSyncOutcome,
  setLastSuccessAt,
  getLastSuccessAt,
  formatLastSyncRelative,
  buildQueueStats,
  emitQueueState,
  getQueueRaw,
  setQueueRaw,
  getProcessedActionIds,
  setProcessedActionIds,
  getStalenessBucket,
  getStalenessLabel,
  deriveUnifiedSyncStatus,
};
