import { Platform } from 'react-native';
import { auth, realtimeDb } from '../firebase';
import { createPersistenceProvider } from './persistenceProvider';

const diagnosticsStorage = createPersistenceProvider({ namespace: 'LLT_CRASH_DIAGNOSTICS' });

const MAX_BREADCRUMBS = 180;
const MAX_SNAPSHOT_BREADCRUMBS = 80;
const MAX_FIELD_LENGTH = 420;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_KEYS = 36;
const LOCAL_SNAPSHOT_KEY = 'latest_snapshot_v1';
const SCHEMA_VERSION = 1;
const FLUSH_TIMEOUT_MS = 1800;

const diagnosticsSessionId = `diag_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
let breadcrumbs = [];
let context = {};
let persistTimer = null;
let installedGlobalHandler = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stableHash = (value) => {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const maskIdentifier = (value) => {
  if (value === null || value === undefined) return value;
  const asString = String(value).trim();
  if (!asString) return asString;
  if (asString.length <= 4) return `${asString[0] || ''}***`;
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

const hasSensitiveKeyFragment = (key = '') => {
  const normalized = String(key || '').toLowerCase();
  return [
    'email',
    'token',
    'secret',
    'password',
    'auth',
    'uid',
    'userid',
    'booking',
    'reference',
    'drivercode',
    'session',
  ].some((fragment) => normalized.includes(fragment));
};

const safeRealtimeKey = (value, fallback = 'unknown') => {
  const raw = String(value || fallback);
  const sanitized = raw.replace(/[.#$/\[\]]/g, '_').slice(0, 120);
  return sanitized || fallback;
};

export const summarizeUri = (uri) => {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    return { present: false };
  }

  const normalized = uri.trim();
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const scheme = schemeMatch?.[1]?.toLowerCase() || 'unknown';

  if (scheme === 'http' || scheme === 'https') {
    const withoutScheme = normalized.replace(/^https?:\/\//i, '');
    const slashIndex = withoutScheme.search(/[/?#]/);
    const host = slashIndex >= 0 ? withoutScheme.slice(0, slashIndex) : withoutScheme;
    const pathAndQuery = slashIndex >= 0 ? withoutScheme.slice(slashIndex) : '';
    const queryIndex = pathAndQuery.indexOf('?');
    const hashIndex = pathAndQuery.indexOf('#');
    const pathEndIndex = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? pathAndQuery.length;
    const pathname = pathAndQuery.slice(0, pathEndIndex);
    const query = queryIndex >= 0
      ? pathAndQuery.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined)
      : '';

    return {
      present: true,
      scheme,
      host,
      pathLength: pathname.length,
      pathHash: stableHash(pathname),
      queryKeyCount: query ? query.split('&').filter(Boolean).length : 0,
      hasToken: /(?:^|[?&])token=/.test(normalized),
      totalLength: normalized.length,
      hash: stableHash(normalized),
    };
  }

  return {
    present: true,
    scheme,
    totalLength: normalized.length,
    hash: stableHash(normalized),
    suffix: normalized.length > 14 ? normalized.slice(-14) : normalized,
  };
};

const sanitizeValue = (value, key = '', depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[MaxDepth]';

  if (typeof value === 'string') {
    const normalizedKey = String(key || '').toLowerCase();
    if (normalizedKey === 'stack') {
      return value.length > 6000 ? `${value.slice(0, 6000)}...<${value.length}>` : value;
    }
    if (normalizedKey === 'message' || normalizedKey === 'reason' || normalizedKey === 'event' || normalizedKey === 'component') {
      return value.length > MAX_FIELD_LENGTH
        ? `${value.slice(0, MAX_FIELD_LENGTH)}...<${value.length}>`
        : value;
    }
    if (/^(https?|file|content|asset|ph|data|blob|gs):/i.test(value)) {
      return summarizeUri(value);
    }
    if (hasSensitiveKeyFragment(key)) {
      return {
        masked: maskIdentifier(value),
        length: value.length,
        hash: stableHash(value),
      };
    }
    return value.length > MAX_FIELD_LENGTH
      ? `${value.slice(0, MAX_FIELD_LENGTH)}...<${value.length}>`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return '[Symbol]';

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      output.push({ truncatedItems: value.length - MAX_ARRAY_ITEMS });
    }
    return output;
  }

  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  const output = {};
  entries.forEach(([childKey, childValue]) => {
    output[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen);
  });
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    output.__truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
  }
  return output;
};

const pickLatestBreadcrumb = (snapshot) => {
  const snapshotBreadcrumbs = Array.isArray(snapshot?.breadcrumbs) ? snapshot.breadcrumbs : [];
  if (snapshotBreadcrumbs.length > 0) {
    return snapshotBreadcrumbs[snapshotBreadcrumbs.length - 1];
  }

  return breadcrumbs[breadcrumbs.length - 1] || null;
};

const getRuntimeContext = () => ({
  platform: Platform.OS,
  platformVersion: Platform.Version,
  model: Platform.constants?.Model || Platform.constants?.model || 'unknown',
  isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
});

const getRouteKeys = () => {
  const authUid = auth?.currentUser?.uid || null;
  return {
    authUid,
    userKey: safeRealtimeKey(authUid || 'anonymous', 'anonymous'),
    sessionKey: safeRealtimeKey(diagnosticsSessionId, 'session_unknown'),
  };
};

const buildSnapshot = (reason = 'snapshot', extra = {}) => {
  const { authUid } = getRouteKeys();
  return sanitizeValue({
    schemaVersion: SCHEMA_VERSION,
    reason,
    diagnosticsSessionId,
    generatedAt: new Date().toISOString(),
    runtime: getRuntimeContext(),
    auth: {
      hasCurrentUser: Boolean(authUid),
      authUid: authUid ? maskIdentifier(authUid) : null,
      authUidHash: authUid ? stableHash(authUid) : null,
    },
    context,
    breadcrumbCount: breadcrumbs.length,
    breadcrumbs: breadcrumbs.slice(-MAX_SNAPSHOT_BREADCRUMBS),
    extra,
  });
};

const persistLocalSnapshot = async (snapshot) => {
  try {
    await diagnosticsStorage.setItemAsync(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Diagnostics must never affect app behavior.
  }
};

const persistRemoteSnapshot = async (snapshot) => {
  if (!realtimeDb?.ref) return;

  const { userKey, sessionKey } = getRouteKeys();
  const basePath = `logs/${userKey}/${sessionKey}/crashDiagnostics`;
  const eventKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await realtimeDb.ref().update({
      [`${basePath}/latest`]: snapshot,
      [`${basePath}/events/${eventKey}`]: {
        at: snapshot.generatedAt,
        reason: snapshot.reason,
        breadcrumbCount: snapshot.breadcrumbCount,
        lastBreadcrumb: pickLatestBreadcrumb(snapshot),
      },
    });
  } catch {
    // RTDB may be unavailable during the crash path; local storage is still useful.
  }
};

const scheduleLocalPersist = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistLocalSnapshot(buildSnapshot('debounced_local_persist')).catch(() => {});
  }, 250);
};

export const setDiagnosticsContext = (key, value, options = {}) => {
  try {
    if (!key) return;
    context = {
      ...context,
      [key]: sanitizeValue(value, key),
    };

    if (options.flush) {
      flushDiagnostics(`context:${key}`).catch(() => {});
    } else {
      scheduleLocalPersist();
    }
  } catch {
    // Diagnostics must never affect app behavior.
  }
};

export const recordBreadcrumb = (component, event, data = {}, options = {}) => {
  try {
    const entry = sanitizeValue({
      at: new Date().toISOString(),
      component: component || 'Unknown',
      event: event || 'event',
      data,
    });

    breadcrumbs.push(entry);
    if (breadcrumbs.length > MAX_BREADCRUMBS) {
      breadcrumbs = breadcrumbs.slice(-MAX_BREADCRUMBS);
    }

    if (options.flush || options.remote) {
      flushDiagnostics(options.reason || `${component}:${event}`, { lastEvent: entry }).catch(() => {});
    } else {
      scheduleLocalPersist();
    }
  } catch {
    // Diagnostics must never affect app behavior.
  }
};

export const flushDiagnostics = async (reason = 'manual_flush', extra = {}) => {
  try {
    const snapshot = buildSnapshot(reason, extra);
    await persistLocalSnapshot(snapshot);
    await persistRemoteSnapshot(snapshot);
    return snapshot;
  } catch {
    return null;
  }
};

export const flushStoredDiagnostics = async (reason = 'previous_local_snapshot') => {
  try {
    const raw = await diagnosticsStorage.getItemAsync(LOCAL_SNAPSHOT_KEY);
    if (!raw) return null;
    const previousSnapshot = JSON.parse(raw);
    const replaySnapshot = sanitizeValue({
      ...previousSnapshot,
      reason,
      replayedAt: new Date().toISOString(),
      currentDiagnosticsSessionId: diagnosticsSessionId,
    });
    await persistRemoteSnapshot(replaySnapshot);
    return replaySnapshot;
  } catch {
    return null;
  }
};

export const captureGlobalError = async (error, contextData = {}) => {
  const errorPayload = {
    message: error?.message || String(error),
    name: error?.name || 'Error',
    stack: error?.stack || null,
    isFatal: Boolean(contextData?.isFatal),
    source: contextData?.source || 'global',
  };

  recordBreadcrumb('GlobalError', 'unhandled_exception', errorPayload);
  return flushDiagnostics('global_error', {
    ...contextData,
    error: errorPayload,
  });
};

export const installGlobalCrashDiagnostics = ({ flushTimeoutMs = FLUSH_TIMEOUT_MS } = {}) => {
  if (installedGlobalHandler || typeof ErrorUtils === 'undefined' || !ErrorUtils?.getGlobalHandler || !ErrorUtils?.setGlobalHandler) {
    return;
  }

  installedGlobalHandler = true;
  const originalHandler = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const capturePromise = captureGlobalError(error, {
      isFatal,
      source: 'ErrorUtils',
    });

    if (isFatal) {
      Promise.race([capturePromise, wait(flushTimeoutMs)])
        .finally(() => {
          if (typeof originalHandler === 'function') {
            originalHandler(error, isFatal);
          }
        });
      return;
    }

    capturePromise.finally(() => {
      if (typeof originalHandler === 'function') {
        originalHandler(error, isFatal);
      }
    });
  });

  recordBreadcrumb('CrashDiagnostics', 'global_handler_installed', {
    flushTimeoutMs,
  }, { remote: true });
  flushStoredDiagnostics('startup_previous_local_snapshot').catch(() => {});
};

export const summarizePhotoRecord = (photo = {}) => ({
  id: typeof photo?.id === 'string' ? maskIdentifier(photo.id) : null,
  idHash: photo?.id ? stableHash(photo.id) : null,
  timestamp: photo?.timestamp || null,
  userId: photo?.userId ? maskIdentifier(photo.userId) : null,
  userIdHash: photo?.userId ? stableHash(photo.userId) : null,
  privateOwnerId: photo?.privateOwnerId ? maskIdentifier(photo.privateOwnerId) : null,
  originalUserId: photo?.originalUserId ? maskIdentifier(photo.originalUserId) : null,
  variantStatus: photo?.variantStatus || null,
  variantVersion: photo?.variantVersion || null,
  hasCaption: typeof photo?.caption === 'string' && photo.caption.length > 0,
  fileType: photo?.fileType || null,
  fileSize: photo?.fileSize || null,
  storagePathLength: typeof photo?.storagePath === 'string' ? photo.storagePath.length : null,
  storagePathHash: photo?.storagePath ? stableHash(photo.storagePath) : null,
  thumbnailStoragePathLength: typeof photo?.thumbnailStoragePath === 'string' ? photo.thumbnailStoragePath.length : null,
  viewerStoragePathLength: typeof photo?.viewerStoragePath === 'string' ? photo.viewerStoragePath.length : null,
  legacyDisplayUnavailable: Boolean(photo?.legacyDisplayUnavailable),
  uriSummary: {
    url: summarizeUri(photo?.url),
    fullUrl: summarizeUri(photo?.fullUrl),
    sourceUrl: summarizeUri(photo?.sourceUrl),
    thumbnailUrl: summarizeUri(photo?.thumbnailUrl),
    viewerUrl: summarizeUri(photo?.viewerUrl),
  },
});

export const summarizeQueueAction = (action = {}) => ({
  id: typeof action?.id === 'string' ? maskIdentifier(action.id) : null,
  idHash: action?.id ? stableHash(action.id) : null,
  type: action?.type || null,
  status: action?.status || null,
  attempts: action?.attempts || 0,
  createdAt: action?.createdAt || null,
  nextAttemptAt: action?.nextAttemptAt || null,
  tourId: action?.tourId ? maskIdentifier(action.tourId) : null,
  visibility: action?.payload?.visibility || null,
  ownerId: action?.payload?.ownerId ? maskIdentifier(action.payload.ownerId) : null,
  userId: action?.payload?.userId ? maskIdentifier(action.payload.userId) : null,
  payloadVersion: action?.payload?.payloadVersion || null,
  hasIdempotencyKey: Boolean(action?.payload?.idempotencyKey),
  localAssets: {
    sourceUri: summarizeUri(action?.payload?.localAssets?.sourceUri || action?.payload?.uri),
    previewUri: summarizeUri(action?.payload?.localAssets?.previewUri),
    thumbnailUri: summarizeUri(action?.payload?.localAssets?.thumbnailUri),
    viewerUri: summarizeUri(action?.payload?.localAssets?.viewerUri),
  },
  lastError: action?.lastError || action?.payload?.lastError || null,
});

export const getDiagnosticsSessionId = () => diagnosticsSessionId;
