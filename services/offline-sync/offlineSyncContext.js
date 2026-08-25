const { createPersistenceProvider } = require('../persistenceProvider');
const logger = process.env.NODE_ENV === 'test'
  ? console
  : (() => {
      const loggerImport = require('../loggerService');
      return loggerImport.default || loggerImport || console;
    })();
const { parseTimestampMs } = require('../timeUtils');
const { normalizeTourId } = require('../tourIdentityService');
const { HEALTH_STATE, UNIFIED_SYNC_STATES } = require('../../utils/unifiedSyncContract');
const storage = createPersistenceProvider({
  namespace: 'LLT_OFFLINE',
  preferredStorage: 'async-storage',
  allowMemoryFallback: false,
  migrateFrom: ['secure-store'],
});

const SCHEMA_VERSION = 1;
const SUPPORTED_QUEUE_TYPES = new Set(['MANIFEST_UPDATE', 'CHAT_MESSAGE', 'INTERNAL_CHAT_MESSAGE', 'PHOTO_UPLOAD', 'DRIVER_TOUR_PACK_ACTION']);
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
const runtimeState = {
  queueMutationTail: Promise.resolve(),
  replayLock: false,
  activeSessionScope: null,
  activeSessionGeneration: 0,
};

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

const filterActionsForScope = (actions = [], scope = runtimeState.activeSessionScope) => {
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
  const current = runtimeState.queueMutationTail.catch(() => {}).then(operation);
  runtimeState.queueMutationTail = current.catch(() => {});
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
    runtimeState.activeSessionScope
    && normalizeTourId(runtimeState.activeSessionScope.tourId) === normalizeTourId(tourId)
    && runtimeState.activeSessionScope.role === role
  ) {
    return normalizeTourPackOwnerId(runtimeState.activeSessionScope.cacheOwnerId || runtimeState.activeSessionScope.principalId);
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
module.exports = {
  HEALTH_STATE,
  UNIFIED_SYNC_STATES,
  logger,
  normalizeTourId,
  parseTimestampMs,
  storage,
  SCHEMA_VERSION,
  SUPPORTED_QUEUE_TYPES,
  SUPPORTED_QUEUE_STATUSES,
  MAX_ATTEMPTS,
  QUEUE_KEY,
  QUEUE_CORRUPT_BACKUP_KEY,
  PROCESSED_ACTIONS_KEY,
  LAST_SUCCESS_AT_KEY,
  MAX_PROCESSED_IDS,
  MAX_QUEUE_ACTIONS,
  PHOTO_UPLOAD_COMPLETED_TTL_MS,
  PHOTO_UPLOAD_COMPLETED_KEEP_LAST,
  ACTION_SCOPE_VERSION,
  SUPPORTED_SCOPE_ROLES,
  listeners,
  queueListeners,
  tourPackWriteLocks,
  runtimeState,
  RESPONSE,
  toSortableTimestampMs,
  maskIdentifier,
  summarizeUriForLog,
  summarizeQueueActionForLog,
  normalizePrincipalId,
  normalizeSessionScope,
  deriveActionScope,
  actionMatchesScope,
  filterActionsForScope,
  isSameSessionScope,
  isSameActionOwnerScope,
  withQueueMutationLock,
  safeJsonParse,
  sanitizePhotoUploadPayload,
  pruneCompletedPhotoUploadActions,
  hasQueueCapacity,
  sanitizeActionRecord,
  normalizeTourPackOwnerId,
  resolveTourPackOwnerId,
  cacheKey,
  metaKey,
  withTourPackWriteLock,
};
