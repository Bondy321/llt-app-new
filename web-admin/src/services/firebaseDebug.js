const DEBUG_PREFIX = '[LLT Web Admin Firebase]';
const DEFAULT_MAX_KEYS = 8;
const DEFAULT_MAX_CHILD_KEYS = 8;

export const FIREBASE_DEBUG_SESSION_ID = `web-admin-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

export function isFirebaseDebugEnabled() {
  return import.meta.env.VITE_FIREBASE_DEBUG_LOGS !== 'false';
}

const redactDebugString = (value) => String(value)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  .replace(/ExponentPushToken\[[^\]]+\]/g, '[push-token]')
  .replace(/\b(?:session|diag)_\d+_[A-Za-z0-9_-]+\b/g, '[session]')
  .replace(/\b(auth(?:uid)?|authorization|booking(?:ref|reference|id)?|drivercode|password|push(?:token)?|session(?:id)?|token|uid|userid)\b\s*[:=]\s*['"]?[^,\s'"}\]]+/gi, (_match, label) => `${label}=[redacted]`)
  .replace(/\b[A-Za-z0-9_]{24,}\b/g, '[identifier]');

export function maskDebugValue(value, start = 6, end = 4) {
  if (value === null || value === undefined || value === '') return value || null;
  const text = String(value);
  if (text.length <= start + end + 3) return `${text.slice(0, 2)}...`;
  return `${text.slice(0, start)}...${text.slice(-end)}`;
}

export function maskDebugEmail(value) {
  if (!value || typeof value !== 'string' || !value.includes('@')) return value || null;
  const [localPart, domain] = value.split('@');
  const safeLocal = localPart.length <= 2
    ? `${localPart[0] || '*'}***`
    : `${localPart.slice(0, 2)}***${localPart.slice(-1)}`;
  return `${safeLocal} [at] ${domain}`;
}

export function sanitizeDebugValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactDebugString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return normalizeFirebaseError(value);
  if (depth >= 5) return '[max-depth]';

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDebugValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [redactDebugString(key), sanitizeDebugValue(item, depth + 1)]),
    );
  }

  return String(value);
}

export function normalizeFirebaseError(error) {
  if (!error) {
    return {
      message: 'Unknown Firebase error',
    };
  }

  const base = {
    name: error.name || null,
    code: error.code || null,
    message: error.message || String(error),
  };

  if (error.serverResponse) base.serverResponse = error.serverResponse;
  if (error.details) base.details = error.details;
  if (error.status) base.status = error.status;
  if (error.customData) base.customData = error.customData;
  if (error.stack) base.stackTop = String(error.stack).split('\n').slice(0, 6);

  return sanitizeDebugValue(base, 1);
}

const nowIso = () => new Date().toISOString();

export function logFirebaseDebug(event, details = {}, level = 'debug') {
  if (!isFirebaseDebugEnabled()) return;
  const method = typeof console[level] === 'function' ? level : 'debug';
  console[method](`${DEBUG_PREFIX} ${event}`, sanitizeDebugValue({
    debugSessionId: FIREBASE_DEBUG_SESSION_ID,
    loggedAt: nowIso(),
    ...details,
  }));
}

export function logFirebaseError(event, error, details = {}) {
  logFirebaseDebug(event, {
    ...details,
    error: normalizeFirebaseError(error),
  }, 'error');
}

export function startFirebaseDebugTimer(event, details = {}) {
  const startedAtMs = typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

  logFirebaseDebug(`${event}:start`, details, 'info');

  return {
    success(extraDetails = {}) {
      const finishedAtMs = typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
      logFirebaseDebug(`${event}:success`, {
        ...details,
        ...extraDetails,
        durationMs: Math.round(finishedAtMs - startedAtMs),
      }, 'info');
    },
    failure(error, extraDetails = {}) {
      const finishedAtMs = typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
      logFirebaseError(`${event}:failure`, error, {
        ...details,
        ...extraDetails,
        durationMs: Math.round(finishedAtMs - startedAtMs),
      });
    },
  };
}

const parseUrlSummary = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      origin: parsed.origin,
      pathname: parsed.pathname,
    };
  } catch {
    return {
      parseError: 'Value is not a valid URL',
      preview: maskDebugValue(value),
    };
  }
};

const summarizeEnvField = (value, options = {}) => ({
  present: Boolean(value),
  length: value ? String(value).length : 0,
  preview: options.showFull ? value : maskDebugValue(value),
  url: options.url ? parseUrlSummary(value) : undefined,
});

export function summarizeFirebaseConfig(config = {}) {
  const requiredFields = [
    'apiKey',
    'authDomain',
    'databaseURL',
    'projectId',
    'storageBucket',
    'messagingSenderId',
    'appId',
  ];

  return {
    missingRequiredFields: requiredFields.filter((field) => !config[field]),
    fields: {
      apiKey: summarizeEnvField(config.apiKey),
      authDomain: summarizeEnvField(config.authDomain, { showFull: true }),
      databaseURL: summarizeEnvField(config.databaseURL, { showFull: true, url: true }),
      projectId: summarizeEnvField(config.projectId, { showFull: true }),
      storageBucket: summarizeEnvField(config.storageBucket, { showFull: true }),
      messagingSenderId: summarizeEnvField(config.messagingSenderId),
      appId: summarizeEnvField(config.appId),
      measurementId: summarizeEnvField(config.measurementId),
    },
  };
}

export function summarizeFirebaseApp(app) {
  if (!app) return null;
  return {
    name: app.name,
    automaticDataCollectionEnabled: app.automaticDataCollectionEnabled,
    options: summarizeFirebaseConfig(app.options),
  };
}

export function summarizeDatabaseInstance(database) {
  return {
    appName: database?.app?.name || null,
    projectId: database?.app?.options?.projectId || null,
    databaseURL: database?.app?.options?.databaseURL || null,
    databaseURLSummary: parseUrlSummary(database?.app?.options?.databaseURL),
  };
}

export function summarizeAuthUser(user) {
  if (!user) {
    return {
      signedIn: false,
    };
  }

  return {
    signedIn: true,
    uid: maskDebugValue(user.uid),
    email: maskDebugEmail(user.email),
    emailVerified: user.emailVerified,
    isAnonymous: user.isAnonymous,
    tenantId: user.tenantId || null,
    providerIds: (user.providerData || []).map((provider) => provider.providerId),
    metadata: {
      creationTime: user.metadata?.creationTime || null,
      lastSignInTime: user.metadata?.lastSignInTime || null,
    },
  };
}

export function getRuntimeDebugContext() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      hasWindow: typeof window !== 'undefined',
      hasNavigator: typeof navigator !== 'undefined',
    };
  }

  return {
    location: {
      origin: window.location.origin,
      pathname: window.location.pathname,
      protocol: window.location.protocol,
      host: window.location.host,
    },
    navigator: {
      onLine: navigator.onLine,
      language: navigator.language,
      platform: navigator.platform,
      cookieEnabled: navigator.cookieEnabled,
      userAgent: navigator.userAgent,
    },
    document: {
      visibilityState: document.visibilityState,
      referrer: document.referrer || null,
    },
  };
}

const getValueType = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const summarizeChildValue = (value, options = {}) => {
  const type = getValueType(value);
  if (type === 'array') {
    return {
      type,
      length: value.length,
      populatedCount: value.filter((item) => item !== null && item !== undefined).length,
    };
  }

  if (type === 'object') {
    const keys = Object.keys(value);
    return {
      type,
      keyCount: keys.length,
      sampleKeys: keys.slice(0, options.maxChildKeys || DEFAULT_MAX_CHILD_KEYS).map((key) => redactDebugString(key)),
    };
  }

  if (type === 'string') {
    return {
      type,
      length: value.length,
      preview: redactDebugString(value.slice(0, 120)),
    };
  }

  return {
    type,
    value,
  };
};

export function summarizeDataValue(value, options = {}) {
  const type = getValueType(value);
  if (type === 'array') {
    return {
      type,
      length: value.length,
      populatedCount: value.filter((item) => item !== null && item !== undefined).length,
      firstItems: value.slice(0, options.maxKeys || DEFAULT_MAX_KEYS).map((item) => summarizeChildValue(item, options)),
    };
  }

  if (type !== 'object') {
    return summarizeChildValue(value, options);
  }

  const keys = Object.keys(value);
  const sampleKeys = keys.slice(0, options.maxKeys || DEFAULT_MAX_KEYS);

  return {
    type,
    keyCount: keys.length,
    sampleKeys: sampleKeys.map((key) => redactDebugString(key)),
    sampleChildren: Object.fromEntries(
      sampleKeys.map((key) => [redactDebugString(key), summarizeChildValue(value[key], options)]),
    ),
  };
}

export function summarizeFirebaseSnapshot(snapshot, preloadedValue) {
  let value = preloadedValue;
  if (arguments.length < 2) {
    value = snapshot?.val?.();
  }

  return {
    exists: typeof snapshot?.exists === 'function' ? snapshot.exists() : value !== null && value !== undefined,
    key: snapshot?.key || null,
    valueSummary: summarizeDataValue(value),
  };
}
