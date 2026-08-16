const { createPersistenceProvider } = require('./persistenceProvider');
const logger = process.env.NODE_ENV === 'test'
  ? console
  : (() => {
      const loggerImport = require('./loggerService');
      return loggerImport.default || loggerImport || console;
    })();
const { parseTimestampMs } = require('./timeUtils');
const { normalizeTourId } = require('./tourIdentityService');
const { HEALTH_STATE, UNIFIED_SYNC_STATES } = require('../utils/unifiedSyncContract');
const storage = createPersistenceProvider({
  namespace: 'LLT_OFFLINE',
  preferredStorage: 'async-storage',
  allowMemoryFallback: false,
  migrateFrom: ['secure-store'],
});

const SCHEMA_VERSION = 1;
const SUPPORTED_QUEUE_TYPES = new Set(['MANIFEST_UPDATE', 'CHAT_MESSAGE', 'INTERNAL_CHAT_MESSAGE', 'PHOTO_UPLOAD']);
const SUPPORTED_QUEUE_STATUSES = new Set(['queued', 'uploading', 'retrying', 'failed', 'completed', 'syncing']);
const MAX_ATTEMPTS = 5;
const QUEUE_KEY = 'queue_v1';
const QUEUE_CORRUPT_BACKUP_KEY = 'queue_v1_corrupt_backup';
const PROCESSED_ACTIONS_KEY = 'processed_action_ids_v1';
const LAST_SUCCESS_AT_KEY = 'last_success_at_v1';
const MAX_PROCESSED_IDS = 500;
const MAX_QUEUE_ACTIONS = 500;
const PHOTO_UPLOAD_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const PHOTO_UPLOAD_COMPLETED_KEEP_LAST = 20;
const ACTION_SCOPE_VERSION = 1;
const SUPPORTED_SCOPE_ROLES = new Set(['passenger', 'driver']);


// Subscription records retain the scope captured at registration time. Storing
// bare callback functions caused explicitly scoped observers to start receiving
// another traveller's queue after the app changed its active session.
const listeners = new Set();
const queueListeners = new Set();
const tourPackWriteLocks = new Map();
let queueMutationTail = Promise.resolve();
let replayLock = false;
let activeSessionScope = null;
let activeSessionGeneration = 0;

const RESPONSE = {
  ok: (data) => ({ success: true, data }),
  fail: (error) => ({ success: false, error: typeof error === 'string' ? error : error?.message || 'Unknown offline sync error' }),
};

const toSortableTimestampMs = (value) => {
  const parsed = parseTimestampMs(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const maskIdentifier = (value) => {
  if (value === null || value === undefined) return value;
  const asString = String(value).trim();
  if (!asString) return asString;
  if (asString.length <= 4) return `${asString[0] || ''}***`;
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

const summarizeUriForLog = (uri) => {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { present: false };
  }

  const normalized = uri.trim();
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return {
    present: true,
    scheme: schemeMatch?.[1]?.toLowerCase() || 'unknown',
    length: normalized.length,
  };
};

const summarizeQueueActionForLog = (action = {}) => {
  const payload = action?.payload && typeof action.payload === 'object' ? action.payload : {};
  const localAssets = payload.localAssets && typeof payload.localAssets === 'object' ? payload.localAssets : {};
  const scope = deriveActionScope(action);

  return {
    id: maskIdentifier(action?.id),
    type: action?.type || null,
    status: action?.status || null,
    tourId: maskIdentifier(action?.tourId),
    attempts: Number.isFinite(action?.attempts) ? action.attempts : 0,
    nextAttemptAt: action?.nextAttemptAt || null,
    createdAt: action?.createdAt || null,
    lastUpdatedAt: action?.lastUpdatedAt || null,
    hasLastError: Boolean(action?.lastError || payload.lastError),
    lastError: action?.lastError || payload.lastError || null,
    payloadVersion: payload.payloadVersion || null,
    visibility: payload.visibility || null,
    ownerId: maskIdentifier(payload.ownerId),
    userId: maskIdentifier(payload.userId),
    scopePrincipalId: maskIdentifier(scope?.principalId),
    scopeRole: scope?.role || null,
    hasSessionScope: Boolean(scope),
    hasIdempotencyKey: Boolean(payload.idempotencyKey),
    hasLocalAssets: Boolean(payload.localAssets),
    localAssets: {
      sourceUri: summarizeUriForLog(localAssets.sourceUri || payload.uri),
      previewUri: summarizeUriForLog(localAssets.previewUri),
    },
    payloadKeys: Object.keys(payload).slice(0, 20),
  };
};

const normalizePrincipalId = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'anonymous' ? trimmed : null;
};

const normalizeSessionScope = (scope, fallbackTourId = null) => {
  if (!scope || typeof scope !== 'object') return null;
  const tourId = normalizeTourId(scope.tourId || fallbackTourId);
  const principalId = normalizePrincipalId(scope.principalId || scope.actorPrincipalId || scope.ownerId);
  const role = SUPPORTED_SCOPE_ROLES.has(scope.role) ? scope.role : null;
  const authUid = normalizePrincipalId(scope.authUid);
  const cacheOwnerId = normalizePrincipalId(scope.cacheOwnerId || scope.bookingRef || scope.principalId);
  if (!tourId || !principalId || !role) return null;
  return {
    version: ACTION_SCOPE_VERSION,
    tourId,
    principalId,
    role,
    authUid,
    cacheOwnerId,
  };
};

const deriveActionScope = (action = {}) => {
  const payload = action?.payload && typeof action.payload === 'object' ? action.payload : {};
  const sender = payload.senderInfo && typeof payload.senderInfo === 'object' ? payload.senderInfo : {};
  const explicit = normalizeSessionScope(action.scope, action.tourId);
  if (explicit) return explicit;

  const principalId = normalizePrincipalId(
    action.principalId
      || payload.actorPrincipalId
      || payload.ownerId
      || payload.ownerIdentity
      || payload.userId
      || sender.principalId
      || sender.stablePassengerId
      || sender.userId
  );
  const isDriver = action.role === 'driver'
    || payload.actorRole === 'driver'
    || sender.principalType === 'driver'
    || sender.isDriver === true
    || action.type === 'INTERNAL_CHAT_MESSAGE';
  return normalizeSessionScope({
    tourId: action.tourId || payload.tourId || payload.tourCode,
    principalId,
    role: isDriver ? 'driver' : 'passenger',
    authUid: action.authUid || payload.authUid || null,
  });
};

const actionMatchesScope = (action, scope) => {
  const normalizedScope = normalizeSessionScope(scope);
  const actionScope = deriveActionScope(action);
  if (!normalizedScope || !actionScope) return false;
  return actionScope.tourId === normalizedScope.tourId
    && actionScope.principalId === normalizedScope.principalId
    && actionScope.role === normalizedScope.role;
};

const filterActionsForScope = (actions = [], scope = activeSessionScope) => {
  const normalizedScope = normalizeSessionScope(scope);
  if (!normalizedScope) return [];
  return (Array.isArray(actions) ? actions : []).filter((action) => actionMatchesScope(action, normalizedScope));
};

const isSameSessionScope = (left, right) => {
  const normalizedLeft = normalizeSessionScope(left);
  const normalizedRight = normalizeSessionScope(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return normalizedLeft.tourId === normalizedRight.tourId
    && normalizedLeft.principalId === normalizedRight.principalId
    && normalizedLeft.role === normalizedRight.role
    && normalizedLeft.cacheOwnerId === normalizedRight.cacheOwnerId;
};

const isSameActionOwnerScope = (left, right) => {
  const normalizedLeft = normalizeSessionScope(left);
  const normalizedRight = normalizeSessionScope(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && normalizedLeft.tourId === normalizedRight.tourId
    && normalizedLeft.principalId === normalizedRight.principalId
    && normalizedLeft.role === normalizedRight.role
  );
};

const withQueueMutationLock = async (operation) => {
  const current = queueMutationTail.catch(() => {}).then(operation);
  queueMutationTail = current.catch(() => {});
  return current;
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

const sanitizePhotoUploadPayload = (payload = {}, action = {}) => {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const localAssets = safePayload.localAssets && typeof safePayload.localAssets === 'object' ? safePayload.localAssets : {};
  const metadata = safePayload.metadata && typeof safePayload.metadata === 'object' ? safePayload.metadata : {};
  const payloadCreatedAtMs = parseTimestampMs(safePayload.createdAt);
  const createdAt = Number.isFinite(payloadCreatedAtMs)
    ? new Date(payloadCreatedAtMs).toISOString()
    : (action.createdAt || new Date().toISOString());

  return {
    ...safePayload,
    payloadVersion: 2,
    jobId: safePayload.jobId || action.id,
    idempotencyKey: typeof safePayload.idempotencyKey === 'string' ? safePayload.idempotencyKey : null,
    createdAt,
    tourId: safePayload.tourId || action.tourId,
    visibility: safePayload.visibility === 'private' ? 'private' : 'group',
    ownerId: safePayload.ownerId || safePayload.ownerIdentity || safePayload.userId || null,
    userId: safePayload.userId || safePayload.ownerId || safePayload.ownerIdentity || null,
    localAssets: {
      sourceUri: localAssets.sourceUri || safePayload.uri || null,
      previewUri: localAssets.previewUri || safePayload.previewUri || localAssets.sourceUri || safePayload.uri || null,
      optimizationMetrics: localAssets.optimizationMetrics || safePayload.optimizationMetrics || null,
    },
    metadata: {
      caption: metadata.caption ?? safePayload.caption ?? '',
      ...metadata,
    },
    attemptCount: Number.isFinite(safePayload.attemptCount) ? Math.max(0, Math.trunc(safePayload.attemptCount)) : 0,
    lastError: safePayload.lastError || null,
  };
};

const pruneCompletedPhotoUploadActions = (queue = [], now = Date.now()) => {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { queue: [], removedCount: 0 };
  }

  const completedPhotoActions = queue
    .filter((action) => action?.type === 'PHOTO_UPLOAD' && action?.status === 'completed')
    .sort((a, b) => toSortableTimestampMs(a.lastUpdatedAt) - toSortableTimestampMs(b.lastUpdatedAt));

  const keepIds = new Set(completedPhotoActions
    .slice(-PHOTO_UPLOAD_COMPLETED_KEEP_LAST)
    .map((action) => action.id));
  const cutoffMs = now - PHOTO_UPLOAD_COMPLETED_TTL_MS;

  const prunedQueue = queue.filter((action) => {
    if (action?.type !== 'PHOTO_UPLOAD' || action?.status !== 'completed') return true;
    if (keepIds.has(action.id)) return true;
    const completedAtMs = toSortableTimestampMs(action.lastUpdatedAt) || toSortableTimestampMs(action.createdAt);
    return completedAtMs >= cutoffMs;
  });

  return {
    queue: prunedQueue,
    removedCount: Math.max(0, queue.length - prunedQueue.length),
  };
};

const hasQueueCapacity = (queue) => (
  Array.isArray(queue) && queue.length < MAX_QUEUE_ACTIONS
);

const sanitizeActionRecord = (action) => {
  if (!action || typeof action !== 'object') return null;

  const id = typeof action.id === 'string' && action.id.trim() ? action.id.trim() : null;
  const type = typeof action.type === 'string' ? action.type : null;
  const tourId = typeof action.tourId === 'string' && action.tourId.trim() ? action.tourId.trim() : null;

  if (!id || !type || !tourId || !SUPPORTED_QUEUE_TYPES.has(type)) {
    return null;
  }

  const createdAtMs = parseTimestampMs(action.createdAt);
  const normalizedCreatedAt = Number.isFinite(createdAtMs)
    ? new Date(createdAtMs).toISOString()
    : new Date().toISOString();
  const status = SUPPORTED_QUEUE_STATUSES.has(action.status) ? action.status : 'queued';
  const normalizedAttempts = Number.isFinite(action.attempts) ? Math.max(0, Math.trunc(action.attempts)) : 0;
  const nextAttemptAtMs = parseTimestampMs(action.nextAttemptAt);
  const normalizedNextAttemptAt = Number.isFinite(nextAttemptAtMs) ? new Date(nextAttemptAtMs).toISOString() : null;
  const normalizedLastUpdatedAtMs = parseTimestampMs(action.lastUpdatedAt);
  const normalizedLastUpdatedAt = Number.isFinite(normalizedLastUpdatedAtMs)
    ? new Date(normalizedLastUpdatedAtMs).toISOString()
    : new Date().toISOString();

  const normalizedScope = deriveActionScope(action);
  return {
    ...action,
    id,
    type,
    tourId,
    payload: type === 'PHOTO_UPLOAD'
      ? sanitizePhotoUploadPayload(action.payload, action)
      : (action.payload && typeof action.payload === 'object' ? action.payload : {}),
    createdAt: normalizedCreatedAt,
    status,
    attempts: normalizedAttempts,
    nextAttemptAt: normalizedNextAttemptAt,
    lastUpdatedAt: normalizedLastUpdatedAt,
    lastError: action.lastError || null,
    scope: normalizedScope,
  };
};

const normalizeTourPackOwnerId = (value) => {
  const normalized = normalizePrincipalId(value);
  return normalized ? encodeURIComponent(normalized.toUpperCase()) : null;
};

const resolveTourPackOwnerId = (tourId, role, options = {}) => {
  const explicitOwnerId = options?.ownerId || options?.credentialId;
  if (explicitOwnerId) return normalizeTourPackOwnerId(explicitOwnerId);
  if (
    activeSessionScope
    && normalizeTourId(activeSessionScope.tourId) === normalizeTourId(tourId)
    && activeSessionScope.role === role
  ) {
    return normalizeTourPackOwnerId(activeSessionScope.cacheOwnerId || activeSessionScope.principalId);
  }
  return null;
};

const cacheKey = (tourId, role, ownerId) => `tour_pack_v2_${role}_${tourId}_${ownerId}`;
const metaKey = (tourId, role, ownerId) => `tour_pack_meta_v2_${role}_${tourId}_${ownerId}`;

const withTourPackWriteLock = async (key, operation) => {
  const previous = tourPackWriteLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  tourPackWriteLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (tourPackWriteLocks.get(key) === current) {
      tourPackWriteLocks.delete(key);
    }
  }
};

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
        subscription.usesActiveScope ? activeSessionScope : subscription.scope,
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
        subscription.usesActiveScope ? activeSessionScope : subscription.scope,
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
  const total = Math.max(0, Number(queue.total) || pending + syncing + failed);
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

const saveTourPack = async (tourId, role, payload, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return RESPONSE.fail('tour pack payload must be an object');
    }
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.info('OfflineSync', 'Tour pack save started', {
      tourId: maskIdentifier(tourId),
      role,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
      hasFetchedAt: Boolean(payload?.fetchedAt),
    });
    const key = cacheKey(tourId, role, ownerId);
    const nextPayload = await withTourPackWriteLock(key, async () => {
      const rawExistingPack = await storage.getItemAsync(key);
      const existingPack = safeJsonParse(rawExistingPack, {});
      const fetchedAt = payload.fetchedAt || new Date().toISOString();
      const sourceVersion = payload.sourceVersion || SCHEMA_VERSION;
      const mergedPayload = {
        ...(existingPack && typeof existingPack === 'object' ? existingPack : {}),
        ...payload,
        fetchedAt,
        sourceVersion,
      };
      await storage.setItemAsync(key, JSON.stringify(mergedPayload));
      return mergedPayload;
    });
    logger.info('OfflineSync', 'Tour pack save completed', {
      tourId: maskIdentifier(tourId),
      role,
      fetchedAt: nextPayload.fetchedAt,
      sourceVersion: nextPayload.sourceVersion,
      mergedKeys: Object.keys(nextPayload).slice(0, 30),
    });
    return RESPONSE.ok(nextPayload);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack save failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const getTourPack = async (tourId, role, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack load started', {
      tourId: maskIdentifier(tourId),
      role,
    });
    const raw = await storage.getItemAsync(cacheKey(tourId, role, ownerId));
    const pack = safeJsonParse(raw, null);
    if (!pack) {
      logger.info('OfflineSync', 'Tour pack load missed cache', {
        tourId: maskIdentifier(tourId),
        role,
      });
      return RESPONSE.ok(null);
    }
    logger.info('OfflineSync', 'Tour pack load completed', {
      tourId: maskIdentifier(tourId),
      role,
      fetchedAt: pack.fetchedAt || null,
      sourceVersion: pack.sourceVersion || null,
      keys: Object.keys(pack).slice(0, 30),
    });
    return RESPONSE.ok(pack);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack load failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const setTourPackMeta = async (tourId, role, meta = {}, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack metadata save started', {
      tourId: maskIdentifier(tourId),
      role,
      metaKeys: meta && typeof meta === 'object' ? Object.keys(meta).slice(0, 20) : [],
    });
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      lastSyncedAt: meta.lastSyncedAt || new Date().toISOString(),
      ...meta,
    };
    await storage.setItemAsync(metaKey(tourId, role, ownerId), JSON.stringify(payload));
    logger.info('OfflineSync', 'Tour pack metadata save completed', {
      tourId: maskIdentifier(tourId),
      role,
      lastSyncedAt: payload.lastSyncedAt,
      schemaVersion: payload.schemaVersion,
    });
    return RESPONSE.ok(payload);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack metadata save failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const getTourPackMeta = async (tourId, role, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack metadata load started', {
      tourId: maskIdentifier(tourId),
      role,
    });
    const raw = await storage.getItemAsync(metaKey(tourId, role, ownerId));
    const meta = safeJsonParse(raw, null);
    logger.info('OfflineSync', 'Tour pack metadata load completed', {
      tourId: maskIdentifier(tourId),
      role,
      found: Boolean(meta),
      lastSyncedAt: meta?.lastSyncedAt || null,
      schemaVersion: meta?.schemaVersion || null,
    });
    return RESPONSE.ok(meta);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack metadata load failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const buildAction = (action) => {
  const nowIso = new Date().toISOString();
  const payload = action.type === 'PHOTO_UPLOAD'
    ? sanitizePhotoUploadPayload(action.payload, action)
    : (action.payload || {});
  const scope = deriveActionScope({ ...action, payload });
  return {
    id: action.id || `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: action.type,
    tourId: action.tourId,
    createdAt: action.createdAt || nowIso,
    payload,
    attempts: Number.isFinite(action.attempts) ? action.attempts : 0,
    status: action.status || 'queued',
    lastError: action.lastError || null,
    nextAttemptAt: action.nextAttemptAt || null,
    lastUpdatedAt: nowIso,
    scope,
  };
};

const enqueueAction = async (action) => withQueueMutationLock(async () => {
  try {
    logger.info('OfflineSync', 'Queue enqueue requested', {
      action: summarizeQueueActionForLog(action),
    });
    if (!action?.type || !action?.tourId) {
      logger.warn('OfflineSync', 'Queue enqueue rejected missing required fields', {
        hasType: Boolean(action?.type),
        hasTourId: Boolean(action?.tourId),
      });
      return RESPONSE.fail('type and tourId are required');
    }
    if (!SUPPORTED_QUEUE_TYPES.has(action.type)) {
      logger.warn('OfflineSync', 'Queue enqueue rejected unsupported action type', {
        type: action.type,
        tourId: maskIdentifier(action.tourId),
      });
      return RESPONSE.fail(`Unsupported action type: ${action.type}`);
    }
    const actionScope = deriveActionScope(action)
      || (normalizeTourId(activeSessionScope?.tourId) === normalizeTourId(action.tourId)
        ? activeSessionScope
        : null);
    if (!actionScope) {
      logger.warn('OfflineSync', 'Queue enqueue rejected without an owner scope', {
        type: action.type,
        tourId: maskIdentifier(action.tourId),
      });
      return RESPONSE.fail('A signed-in tour identity is required before an offline action can be queued.');
    }
    if (activeSessionScope && !isSameActionOwnerScope(activeSessionScope, actionScope)) {
      logger.warn('OfflineSync', 'Queue enqueue rejected for a non-active session scope', {
        type: action.type,
        requestedTourId: maskIdentifier(actionScope.tourId),
        requestedPrincipalId: maskIdentifier(actionScope.principalId),
        activeTourId: maskIdentifier(activeSessionScope.tourId),
        activePrincipalId: maskIdentifier(activeSessionScope.principalId),
      });
      return RESPONSE.fail('Offline actions can only be queued for the active signed-in tour session.');
    }
    const scopedAction = { ...action, scope: actionScope };
    let queue = await getQueueRaw({ persistRepairs: true });
    const exists = queue.find((entry) => entry.id === scopedAction.id);
    if (exists) {
      logger.info('OfflineSync', 'Queue enqueue skipped duplicate action', {
        action: summarizeQueueActionForLog(exists),
        queueCount: queue.length,
      });
      return RESPONSE.ok(exists);
    }

    let supersededActionCount = 0;
    if (scopedAction.type === 'MANIFEST_UPDATE' && scopedAction.payload?.bookingRef) {
      const actionTourId = normalizeTourId(scopedAction.tourId);
      const bookingRef = String(scopedAction.payload.bookingRef).trim().toUpperCase();
      const filteredQueue = queue.filter((entry) => {
        const isSupersededManifestUpdate = entry.type === 'MANIFEST_UPDATE'
          && entry.status !== 'syncing'
          && normalizeTourId(entry.tourId) === actionTourId
          && actionMatchesScope(entry, actionScope)
          && String(entry.payload?.bookingRef || '').trim().toUpperCase() === bookingRef;
        if (isSupersededManifestUpdate) supersededActionCount += 1;
        return !isSupersededManifestUpdate;
      });
      queue = filteredQueue;
    }

    if (!hasQueueCapacity(queue)) {
      logger.error('OfflineSync', 'Queue enqueue rejected at capacity', {
        queueCount: queue.length,
        maxQueueActions: MAX_QUEUE_ACTIONS,
        action: summarizeQueueActionForLog(scopedAction),
      });
      return RESPONSE.fail('Offline queue is full. Reconnect and sync pending items before trying again.');
    }

    if (scopedAction.id) {
      const processedActionIds = await getProcessedActionIds();
      if (processedActionIds.includes(scopedAction.id)) {
        const filteredProcessedIds = processedActionIds.filter((processedId) => processedId !== scopedAction.id);
        const persistResult = await setProcessedActionIds(filteredProcessedIds);
        if (!persistResult.success) {
          logger.warn('OfflineSync', 'Failed to clear previously processed action id before re-enqueue', {
            actionId: scopedAction.id,
            error: persistResult.error,
          });
        }
      }
    }

    const entry = buildAction(scopedAction);
    queue.push(entry);
    queue.sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt));
    await setQueueRaw(queue);
    logger.info('OfflineSync', 'Queue enqueue completed', {
      action: summarizeQueueActionForLog(entry),
      queueCount: queue.length,
      supersededActionCount,
    });
    return RESPONSE.ok({ ...entry, supersededActionCount });
  } catch (error) {
    logger.error('OfflineSync', 'Queue enqueue failed', {
      action: summarizeQueueActionForLog(action),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getQueuedActions = async ({ scope = activeSessionScope, includeAll = false } = {}) => {
  try {
    const queue = await getQueueRaw();
    const visibleQueue = includeAll ? queue : filterActionsForScope(queue, scope);
    return RESPONSE.ok(visibleQueue.sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt)));
  } catch (error) {
    throw error;
  }
};

const updateAction = async (id, patch = {}, options = {}) => withQueueMutationLock(async () => {
  try {
    const queue = await getQueueRaw({ persistRepairs: true });
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      logger.warn('OfflineSync', 'Queue action update missed', {
        actionId: maskIdentifier(id),
        patchKeys: Object.keys(patch || {}),
      });
      return RESPONSE.fail('Action not found');
    }
    const mutationScope = options.scope || activeSessionScope;
    if (!options.includeAll && !actionMatchesScope(queue[index], mutationScope)) {
      logger.warn('OfflineSync', 'Queue action update rejected outside active session scope', {
        actionId: maskIdentifier(id),
        action: summarizeQueueActionForLog(queue[index]),
      });
      return RESPONSE.fail('Action belongs to a different signed-in tour session.');
    }
    queue[index] = {
      ...queue[index],
      ...patch,
      scope: queue[index].scope,
      lastUpdatedAt: new Date().toISOString(),
    };
    await setQueueRaw(queue, options);
    logger.debug('OfflineSync', 'Queue action updated', {
      actionId: maskIdentifier(id),
      patchKeys: Object.keys(patch || {}),
      nextAction: summarizeQueueActionForLog(queue[index]),
      silent: Boolean(options.silent),
    });
    return RESPONSE.ok(queue[index]);
  } catch (error) {
    logger.error('OfflineSync', 'Queue action update failed', {
      actionId: maskIdentifier(id),
      patchKeys: Object.keys(patch || {}),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const removeAction = async (id, options = {}) => withQueueMutationLock(async () => {
  try {
    const queue = await getQueueRaw({ persistRepairs: true });
    const removed = queue.find((entry) => entry.id === id);
    if (removed && !options.includeAll && !actionMatchesScope(removed, options.scope || activeSessionScope)) {
      logger.warn('OfflineSync', 'Queue action removal rejected outside active session scope', {
        actionId: maskIdentifier(id),
        action: summarizeQueueActionForLog(removed),
      });
      return RESPONSE.fail('Action belongs to a different signed-in tour session.');
    }
    const nextQueue = queue.filter((entry) => entry.id !== id);
    await setQueueRaw(nextQueue, options);
    logger.info('OfflineSync', 'Queue action removed', {
      actionId: maskIdentifier(id),
      found: Boolean(removed),
      removedAction: removed ? summarizeQueueActionForLog(removed) : null,
      previousCount: queue.length,
      nextCount: nextQueue.length,
      silent: Boolean(options.silent),
    });
    return RESPONSE.ok(true);
  } catch (error) {
    logger.error('OfflineSync', 'Queue action remove failed', {
      actionId: maskIdentifier(id),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getQueueStats = async ({ scope = activeSessionScope, includeAll = false } = {}) => {
  try {
    const allActions = await getQueueRaw();
    const queue = includeAll ? allActions : filterActionsForScope(allActions, scope);
    return RESPONSE.ok(buildQueueStats(queue));
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const retryFailedActions = async ({ types, tourId, resetAttempts = false, scope = activeSessionScope, includeAll = false } = {}) => withQueueMutationLock(async () => {
  try {
    logger.info('OfflineSync', 'Retry failed queue actions requested', {
      types: Array.isArray(types) ? types : null,
      tourId: maskIdentifier(tourId),
      resetAttempts,
    });
    const queue = await getQueueRaw({ persistRepairs: true });
    const allowedTypes = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
    const normalizedTourId = tourId ? normalizeTourId(tourId) : null;
    let retriedCount = 0;

    const nextQueue = queue.map((action) => {
      const shouldRetryType = !allowedTypes || allowedTypes.has(action.type);
      const shouldRetryTour = !normalizedTourId || normalizeTourId(action.tourId) === normalizedTourId;
      const shouldRetryScope = includeAll || actionMatchesScope(action, scope);
      if (action.status !== 'failed' || !shouldRetryType || !shouldRetryTour || !shouldRetryScope) {
        return action;
      }

      retriedCount += 1;
      return {
        ...action,
        status: action.type === 'PHOTO_UPLOAD' ? 'retrying' : 'queued',
        nextAttemptAt: null,
        ...(resetAttempts ? { attempts: 0 } : null),
      };
    });

    if (retriedCount > 0) {
      await setQueueRaw(nextQueue);
    }

    logger.info('OfflineSync', 'Retry failed queue actions completed', {
      retriedCount,
      queueCount: nextQueue.length,
      sample: nextQueue.filter((action) => action.status === 'queued' || action.status === 'retrying').slice(0, 8).map(summarizeQueueActionForLog),
    });
    return RESPONSE.ok({ retriedCount });
  } catch (error) {
    logger.error('OfflineSync', 'Retry failed queue actions failed', {
      types: Array.isArray(types) ? types : null,
      resetAttempts,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getActiveSessionScope = () => (
  activeSessionScope ? { ...activeSessionScope } : null
);

const setActiveSessionScope = async (scope) => {
  const nextScope = normalizeSessionScope(scope);
  if (isSameSessionScope(activeSessionScope, nextScope)) {
    return RESPONSE.ok(getActiveSessionScope());
  }

  const previousScope = activeSessionScope;
  activeSessionScope = nextScope;
  activeSessionGeneration += 1;
  logger.info('OfflineSync', 'Active offline session scope changed', {
    previousTourId: maskIdentifier(previousScope?.tourId),
    previousPrincipalId: maskIdentifier(previousScope?.principalId),
    nextTourId: maskIdentifier(nextScope?.tourId),
    nextPrincipalId: maskIdentifier(nextScope?.principalId),
    nextRole: nextScope?.role || null,
    generation: activeSessionGeneration,
  });
  await emitQueueState();
  return RESPONSE.ok(getActiveSessionScope());
};

const getQueueIsolationSummary = async ({ scope = activeSessionScope } = {}) => {
  try {
    const allActions = await getQueueRaw();
    const ownedActions = filterActionsForScope(allActions, scope);
    const ownedIds = new Set(ownedActions.map((action) => action.id));
    const otherSessionActions = allActions.filter((action) => !ownedIds.has(action.id));
    return RESPONSE.ok({
      ownedCount: ownedActions.length,
      otherSessionCount: otherSessionActions.length,
      unownedLegacyCount: otherSessionActions.filter((action) => !deriveActionScope(action)).length,
    });
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const subscribeQueueState = (listener, { scope } = {}) => {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const subscription = {
    listener,
    scope: scope ? normalizeSessionScope(scope) : null,
    usesActiveScope: !scope,
  };
  listeners.add(subscription);
  logger.debug('OfflineSync', 'Queue state listener subscribed', {
    listenerCount: listeners.size,
  });
  getQueueStats({ scope: subscription.usesActiveScope ? activeSessionScope : subscription.scope }).then((stats) => {
    if (stats.success) listener(stats.data);
  });

  return () => {
    listeners.delete(subscription);
    logger.debug('OfflineSync', 'Queue state listener unsubscribed', {
      listenerCount: listeners.size,
    });
  };
};

const subscribeQueuedActions = (listener, { scope } = {}) => {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const subscription = {
    listener,
    scope: scope ? normalizeSessionScope(scope) : null,
    usesActiveScope: !scope,
  };
  queueListeners.add(subscription);
  logger.debug('OfflineSync', 'Queue actions listener subscribed', {
    listenerCount: queueListeners.size,
  });
  getQueueRaw().then((queue) => listener(filterActionsForScope(
    queue,
    subscription.usesActiveScope ? activeSessionScope : subscription.scope,
  )));

  return () => {
    queueListeners.delete(subscription);
    logger.debug('OfflineSync', 'Queue actions listener unsubscribed', {
      listenerCount: queueListeners.size,
    });
  };
};

const applyReplayAction = async (action, services = {}) => {
  const { bookingService, chatService, photoService, db } = services;

  if (action.type === 'MANIFEST_UPDATE' && bookingService?.applyManifestUpdateDirect) {
    return bookingService.applyManifestUpdateDirect(action.payload, db);
  }

  if (action.type === 'CHAT_MESSAGE' && chatService?.sendMessageDirect) {
    return chatService.sendMessageDirect(action.payload, db);
  }

  if (action.type === 'INTERNAL_CHAT_MESSAGE' && chatService?.sendInternalMessageDirect) {
    return chatService.sendInternalMessageDirect(action.payload, db);
  }

  if (action.type === 'PHOTO_UPLOAD' && photoService?.uploadPhotoDirect) {
    return photoService.uploadPhotoDirect(action.payload, db);
  }

  return RESPONSE.fail(`Unsupported replay action type: ${action.type}`);
};

const replayQueue = async ({ db, services = {}, scope = activeSessionScope } = {}) => {
  const replayScope = normalizeSessionScope(scope);
  if (!replayScope) {
    logger.info('OfflineSync', 'Queue replay skipped without an active signed-in tour scope');
    return RESPONSE.ok({
      skipped: true,
      reason: 'No active signed-in tour scope',
      processed: 0,
      failed: 0,
      outcomes: [],
    });
  }
  if (activeSessionScope && !isSameSessionScope(activeSessionScope, replayScope)) {
    logger.warn('OfflineSync', 'Queue replay rejected for a non-active session scope', {
      requestedTourId: maskIdentifier(replayScope.tourId),
      requestedPrincipalId: maskIdentifier(replayScope.principalId),
      activeTourId: maskIdentifier(activeSessionScope.tourId),
      activePrincipalId: maskIdentifier(activeSessionScope.principalId),
    });
    return RESPONSE.fail('Offline actions can only sync for the active signed-in tour session.');
  }
  if (replayLock) {
    logger.info('OfflineSync', 'Queue replay skipped because another replay is active');
    return RESPONSE.ok({ skipped: true, reason: 'Replay already in progress' });
  }

  replayLock = true;
  const replayGeneration = activeSessionGeneration;

  try {
    logger.info('OfflineSync', 'Queue replay started', {
      hasDbOverride: Boolean(db),
      serviceKeys: Object.keys(services || {}),
      tourId: maskIdentifier(replayScope.tourId),
      principalId: maskIdentifier(replayScope.principalId),
      role: replayScope.role,
    });
    const allActions = await getQueueRaw();
    const queue = filterActionsForScope(allActions, replayScope);
    const heldForOtherSessions = Math.max(0, allActions.length - queue.length);
    if (queue.length === 0) {
      logger.info('OfflineSync', 'Queue replay completed with no actions for active scope', {
        heldForOtherSessions,
      });
      return RESPONSE.ok({ processed: 0, failed: 0, outcomes: [], heldForOtherSessions });
    }

    const sortedQueue = [...queue].sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt));
    let processedActionIds = await getProcessedActionIds();
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    const outcomes = [];

    logger.info('OfflineSync', 'Queue replay loaded actions', {
      queueCount: sortedQueue.length,
      processedIdCount: processedActionIds.length,
      sample: sortedQueue.slice(0, 10).map(summarizeQueueActionForLog),
    });

    for (const action of sortedQueue) {
      if (
        activeSessionGeneration !== replayGeneration
        || (activeSessionScope && !isSameSessionScope(activeSessionScope, replayScope))
      ) {
        skipped += 1;
        logger.warn('OfflineSync', 'Queue replay stopped because the signed-in tour session changed', {
          action: summarizeQueueActionForLog(action),
          replayGeneration,
          activeSessionGeneration,
        });
        break;
      }
      if (processedActionIds.includes(action.id)) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay removing already processed action', {
          action: summarizeQueueActionForLog(action),
        });
        await removeAction(action.id, { silent: true, scope: replayScope });
        continue;
      }

      if (action.status === 'failed' || (action.type === 'PHOTO_UPLOAD' && action.status === 'completed')) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay skipped action by terminal status', {
          action: summarizeQueueActionForLog(action),
        });
        continue;
      }

      const now = Date.now();
      const nextAttemptAt = toSortableTimestampMs(action.nextAttemptAt);
      if (nextAttemptAt && nextAttemptAt > now) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay skipped action until backoff expires', {
          action: summarizeQueueActionForLog(action),
          waitMs: nextAttemptAt - now,
        });
        continue;
      }

      const inProgressStatus = action.type === 'PHOTO_UPLOAD' ? 'uploading' : 'syncing';
      await updateAction(action.id, { status: inProgressStatus, lastError: null }, { silent: true, scope: replayScope });
      logger.info('OfflineSync', 'Queue replay action started', {
        action: summarizeQueueActionForLog({ ...action, status: inProgressStatus, lastError: null }),
      });
      const result = await applyReplayAction(action, { ...services, db });

      if (result?.success) {
        processed += 1;
        outcomes.push({
          actionId: action.id,
          type: action.type,
          tourId: action.tourId,
          bookingRef: action.payload?.bookingRef || null,
          success: true,
          reconciled: Boolean(result.reconciled),
          conflict: result.conflict || null,
          status: result.status || null,
          passengerStatus: result.passengerStatus || null,
        });
        logger.info('OfflineSync', 'Queue replay action succeeded', {
          action: summarizeQueueActionForLog(action),
          hasResultData: Boolean(result.data),
          resultKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data).slice(0, 20) : [],
        });
        if (action.type === 'PHOTO_UPLOAD') {
          await updateAction(action.id, {
            status: 'completed',
            lastError: null,
            nextAttemptAt: null,
            result: result.data || null,
          }, { silent: true, scope: replayScope });
        } else {
          await removeAction(action.id, { silent: true, scope: replayScope });
          processedActionIds = [...processedActionIds, action.id];
          await setProcessedActionIds(processedActionIds);
        }
      } else {
        failed += 1;
        outcomes.push({
          actionId: action.id,
          type: action.type,
          tourId: action.tourId,
          bookingRef: action.payload?.bookingRef || null,
          success: false,
          error: result?.error || 'Replay failed',
        });
        const attempts = (action.attempts || 0) + 1;
        const shouldFail = attempts >= MAX_ATTEMPTS;
        const delayMinutes = Math.min(2 ** attempts, 60);
        logger.warn('OfflineSync', 'Queue replay action failed', {
          action: summarizeQueueActionForLog(action),
          attempts,
          shouldFail,
          delayMinutes,
          error: result?.error || 'Replay failed',
        });
        await updateAction(action.id, {
          attempts,
          status: shouldFail ? 'failed' : (action.type === 'PHOTO_UPLOAD' ? 'retrying' : 'queued'),
          lastError: result?.error || 'Replay failed',
          nextAttemptAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        }, { silent: true, scope: replayScope });
      }
    }

    if (processed > 0) {
      const persistedLastSuccessAt = await setLastSuccessAt();
      if (!persistedLastSuccessAt.success) {
        logger.warn('OfflineSync', 'Replay processed actions but failed to persist last success timestamp', {
          error: persistedLastSuccessAt.error,
        });
      }
    }

    logger.info('OfflineSync', 'Queue replay completed', {
      processed,
      failed,
      skipped,
      queueCount: sortedQueue.length,
      heldForOtherSessions,
    });
    return RESPONSE.ok({ processed, failed, outcomes, heldForOtherSessions });
  } catch (error) {
    logger.error('OfflineSync', 'Queue replay failed', {
      error: error?.message,
      stack: error?.stack,
    });
    return RESPONSE.fail(error);
  } finally {
    replayLock = false;
    await emitQueueState();
  }
};

const getPhotoUploadActions = async ({ tourId, visibility, ownerId } = {}) => {
  const queued = await getQueuedActions();
  if (!queued.success) return queued;

  const filtered = queued.data.filter((action) => {
    if (action.type !== 'PHOTO_UPLOAD') return false;
    if (tourId && action.tourId !== tourId) return false;
    const payload = action.payload || {};
    if (visibility && payload.visibility !== visibility) return false;
    if (ownerId && payload.ownerId !== ownerId && payload.userId !== ownerId) return false;
    return true;
  });
  logger.debug('OfflineSync', 'Photo upload queue actions filtered', {
    tourId: maskIdentifier(tourId),
    visibility: visibility || null,
    ownerId: maskIdentifier(ownerId),
    totalCount: queued.data.length,
    filteredCount: filtered.length,
    sample: filtered.slice(0, 8).map(summarizeQueueActionForLog),
  });
  return RESPONSE.ok(filtered);
};

module.exports = {
  SCHEMA_VERSION,
  buildSyncSummary,
  formatSyncOutcome,
  setLastSuccessAt,
  getLastSuccessAt,
  formatLastSyncRelative,
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
  retryFailedActions,
  replayQueue,
  setActiveSessionScope,
  getActiveSessionScope,
  getQueueIsolationSummary,
  normalizeSessionScope,
  deriveActionScope,
  actionMatchesScope,
  filterActionsForScope,
  subscribeQueueState,
  subscribeQueuedActions,
  getPhotoUploadActions,
  getStalenessBucket,
  getStalenessLabel,
  pruneCompletedPhotoUploadActions,
  hasQueueCapacity,
  MAX_QUEUE_ACTIONS,
  ACTION_SCOPE_VERSION,
};
