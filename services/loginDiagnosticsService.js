let Platform = { OS: 'unknown', Version: 'unknown', constants: {} };
let Constants = {};

try {
  const reactNative = require('react-native');
  Platform = reactNative.Platform || Platform;
} catch (error) {
  // Diagnostics must be safe to import in non-native tests.
}

try {
  const constantsModule = require('expo-constants');
  Constants = constantsModule.default || constantsModule || {};
} catch (error) {
  Constants = {};
}

const { resolveAppVersionMetadata } = require('./appMetadata');

const LOGIN_DIAGNOSTICS_SCHEMA_VERSION = 1;
const MAX_STRING_LENGTH = 700;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 60;

const diagnosticsSessionId = `login_diag_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const SENSITIVE_KEY_FRAGMENTS = [
  'auth',
  'authorization',
  'bearer',
  'booking',
  'bssid',
  'drivercode',
  'email',
  'ipaddress',
  'password',
  'push',
  'reference',
  'session',
  'ssid',
  'token',
  'uid',
  'userid',
];

const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const nowIso = () => new Date().toISOString();

const stableHash = (value) => {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const safeRealtimeKey = (value, fallback = 'unknown') => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const source = raw || fallback;
  return source.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`
  ).slice(0, 120) || fallback;
};

const maskIdentifier = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return '';
  if (normalized.length <= 4) return `${normalized[0] || ''}***`;
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
};

const hasSensitiveKeyFragment = (key = '') => {
  const normalizedKey = String(key || '').toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
};

const summarizeIdentifier = (value) => {
  if (value === null || value === undefined) {
    return { present: false };
  }

  const raw = String(value);
  const trimmed = raw.trim();
  return {
    present: trimmed.length > 0,
    length: raw.length,
    trimmedLength: trimmed.length,
    masked: maskIdentifier(trimmed),
    hash: stableHash(trimmed),
    uppercaseHash: stableHash(trimmed.toUpperCase()),
    hadLeadingOrTrailingWhitespace: raw !== trimmed,
  };
};

const summarizeEmail = (value) => {
  if (value === null || value === undefined) {
    return { present: false };
  }

  const raw = String(value);
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  const atIndex = normalized.indexOf('@');
  const domain = atIndex >= 0 ? normalized.slice(atIndex + 1) : '';
  const local = atIndex >= 0 ? normalized.slice(0, atIndex) : normalized;

  return {
    present: normalized.length > 0,
    length: raw.length,
    trimmedLength: trimmed.length,
    hash: stableHash(normalized),
    domainHash: domain ? stableHash(domain) : null,
    localLength: local.length,
    hasAt: atIndex > 0,
    hasDotAfterAt: atIndex > 0 && normalized.indexOf('.', atIndex + 2) > atIndex + 1,
    hadLeadingOrTrailingWhitespace: raw !== trimmed,
    hadUppercase: raw !== raw.toLowerCase(),
  };
};

const summarizeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { present: false };

  try {
    const parsed = new URL(raw);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    return {
      present: true,
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.host,
      pathnameHash: stableHash(parsed.pathname),
      pathPartCount: pathParts.length,
      lastPathPart: pathParts[pathParts.length - 1] || null,
      hasQuery: Boolean(parsed.search),
      queryKeyCount: parsed.searchParams ? Array.from(parsed.searchParams.keys()).length : 0,
      totalLength: raw.length,
    };
  } catch (error) {
    return {
      present: true,
      parseable: false,
      length: raw.length,
      hash: stableHash(raw),
    };
  }
};

const sanitizeString = (value, key = '') => {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('email')) return summarizeEmail(value);
  if (
    normalizedKey.includes('booking')
    || normalizedKey.includes('reference')
    || normalizedKey.includes('drivercode')
    || normalizedKey.includes('auth')
    || normalizedKey.includes('uid')
    || normalizedKey.includes('userid')
    || normalizedKey.includes('token')
    || normalizedKey.includes('authorization')
    || normalizedKey.includes('session')
    || normalizedKey.includes('ssid')
    || normalizedKey.includes('bssid')
    || normalizedKey.includes('ipaddress')
  ) {
    return summarizeIdentifier(value);
  }

  if (/^https?:\/\//i.test(value)) {
    return summarizeUrl(value);
  }

  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...<${value.length}>`;
};

const sanitizeValue = (value, key = '', depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[MaxDepth]';

  if (typeof value === 'string') return sanitizeString(value, key);
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

  const output = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  entries.forEach(([childKey, childValue]) => {
    if (hasSensitiveKeyFragment(childKey) && typeof childValue !== 'object') {
      output[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen);
      return;
    }
    output[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen);
  });

  const keyCount = Object.keys(value).length;
  if (keyCount > MAX_OBJECT_KEYS) {
    output.__truncatedKeys = keyCount - MAX_OBJECT_KEYS;
  }

  return output;
};

const summarizeError = (error) => {
  if (!error) return null;
  return sanitizeValue({
    name: error.name || null,
    code: error.code || null,
    message: error.message || String(error),
    stackTop: error.stack ? String(error.stack).split('\n').slice(0, 5) : null,
  }, 'error');
};

const getFirebase = () => {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return {};
  }

  try {
    return require('../firebase');
  } catch (error) {
    return {};
  }
};

const getRuntimeContext = () => {
  const appMetadata = resolveAppVersionMetadata({ constants: Constants, platform: Platform });
  return sanitizeValue({
    platform: Platform.OS || 'unknown',
    platformVersion: Platform.Version ?? 'unknown',
    model: Platform.constants?.Model || Platform.constants?.model || 'unknown',
    isTestingLoginDiagnostics: true,
    ...appMetadata,
  }, 'runtime');
};

const getAuthContext = () => {
  const { auth } = getFirebase();
  const currentUser = auth?.currentUser || null;
  return {
    hasCurrentUser: Boolean(currentUser),
    isAnonymous: Boolean(currentUser?.isAnonymous),
    authUid: currentUser?.uid ? maskIdentifier(currentUser.uid) : null,
    authUidHash: currentUser?.uid ? stableHash(currentUser.uid) : null,
  };
};

const resolveRouteUserKey = (routeUserId) => {
  if (routeUserId) return safeRealtimeKey(routeUserId, 'anonymous');

  const { auth } = getFirebase();
  const authUid = auth?.currentUser?.uid || null;
  return safeRealtimeKey(authUid || 'anonymous', 'anonymous');
};

const buildAttemptId = () => `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeAttemptContext = (context = {}) => {
  if (typeof context === 'string') {
    return { attemptId: context };
  }

  return {
    attemptId: context?.attemptId || context?.loginDiagnosticId || buildAttemptId(),
    routeUserId: context?.routeUserId || null,
    startedAt: context?.startedAt || null,
  };
};

const writeDiagnosticEntry = async (entry, context = {}) => {
  const { realtimeDb } = getFirebase();
  if (!realtimeDb?.ref) return { success: false, error: 'REALTIME_DB_UNAVAILABLE' };

  const attemptContext = normalizeAttemptContext(context);
  const userKey = resolveRouteUserKey(attemptContext.routeUserId);
  const sessionKey = safeRealtimeKey(diagnosticsSessionId, 'login_diag_session');
  const attemptKey = safeRealtimeKey(attemptContext.attemptId, 'attempt_unknown');
  const eventKey = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const buildUpdates = (targetUserKey) => {
    const basePath = `logs/${targetUserKey}/loginDiagnostics/${sessionKey}/attempts/${attemptKey}`;
    return {
      basePath,
      updates: {
        [`${basePath}/events/${eventKey}`]: entry,
        [`${basePath}/latest`]: entry,
        [`${basePath}/updatedAt`]: entry.at,
        [`logs/${targetUserKey}/loginDiagnostics/${sessionKey}/latestAttemptId`]: attemptKey,
        [`logs/${targetUserKey}/loginDiagnostics/${sessionKey}/latestEvent`]: entry,
        [`logs/${targetUserKey}/loginDiagnostics/${sessionKey}/updatedAt`]: entry.at,
      },
    };
  };

  try {
    const primary = buildUpdates(userKey);
    await realtimeDb.ref().update(primary.updates);
    return { success: true, path: primary.basePath };
  } catch (error) {
    if (userKey !== 'anonymous') {
      try {
        const fallback = buildUpdates('anonymous');
        await realtimeDb.ref().update(fallback.updates);
        return {
          success: true,
          path: fallback.basePath,
          primaryFailed: true,
          primaryError: error?.message || String(error),
        };
      } catch (fallbackError) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[LoginDiagnostics] anonymous fallback write failed', fallbackError?.message || String(fallbackError));
        }
      }
    }

    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[LoginDiagnostics] RTDB write failed', error?.message || String(error));
    }
    return { success: false, error: error?.message || String(error) };
  }
};

const recordLoginDiagnostic = async (event, data = {}, context = {}) => {
  try {
    const attemptContext = normalizeAttemptContext(context);
    const entry = {
      schemaVersion: LOGIN_DIAGNOSTICS_SCHEMA_VERSION,
      at: nowIso(),
      event,
      attemptId: attemptContext.attemptId,
      diagnosticsSessionId,
      auth: getAuthContext(),
      runtime: getRuntimeContext(),
      data: sanitizeValue(data, event),
    };

    writeDiagnosticEntry(entry, attemptContext).catch((error) => {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[LoginDiagnostics] async write failed', error?.message || String(error));
      }
    });
    return { success: true, queued: true };
  } catch (error) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[LoginDiagnostics] record failed', error?.message || String(error));
    }
    return { success: false, error: error?.message || String(error) };
  }
};

const startLoginAttempt = (data = {}) => {
  const { auth } = getFirebase();
  const context = {
    attemptId: buildAttemptId(),
    routeUserId: auth?.currentUser?.uid || 'anonymous',
    startedAt: Date.now(),
  };

  recordLoginDiagnostic('attempt_started', data, context).catch(() => {});
  return context;
};

const summarizeNetworkState = (state = {}) => sanitizeValue({
  type: state?.type || 'unknown',
  isConnected: state?.isConnected,
  isInternetReachable: state?.isInternetReachable,
  details: {
    cellularGeneration: state?.details?.cellularGeneration || null,
    isConnectionExpensive: state?.details?.isConnectionExpensive,
    strength: state?.details?.strength ?? null,
    ssidPresent: Boolean(state?.details?.ssid),
    bssidPresent: Boolean(state?.details?.bssid),
    ipAddressPresent: Boolean(state?.details?.ipAddress),
    subnetPresent: Boolean(state?.details?.subnet),
  },
}, 'networkState');

module.exports = {
  LOGIN_DIAGNOSTICS_SCHEMA_VERSION,
  diagnosticsSessionId,
  maskIdentifier,
  recordLoginDiagnostic,
  sanitizeValue,
  stableHash,
  startLoginAttempt,
  summarizeEmail,
  summarizeError,
  summarizeIdentifier,
  summarizeNetworkState,
  summarizeUrl,
  default: {
    LOGIN_DIAGNOSTICS_SCHEMA_VERSION,
    diagnosticsSessionId,
    maskIdentifier,
    recordLoginDiagnostic,
    sanitizeValue,
    stableHash,
    startLoginAttempt,
    summarizeEmail,
    summarizeError,
    summarizeIdentifier,
    summarizeNetworkState,
    summarizeUrl,
  },
};
