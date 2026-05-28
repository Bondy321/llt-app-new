const OPS_ALERT_VERSION = 1;

const OPS_ALERT_LEVELS = {
  ERROR: 'ERROR',
  FATAL: 'FATAL',
};

const OPS_ALERT_SEVERITIES = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
};

const OPS_ALERT_STATUSES = {
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
};

const OPS_ALERT_SOURCES = {
  MOBILE_LOGGER: 'mobile_logger',
  CRASH_DIAGNOSTICS: 'crash_diagnostics',
};

const MAX_COMPONENT_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 600;
const MAX_CONTEXT_LENGTH = 120;
const MAX_DEVICE_LENGTH = 80;
const MAX_BREADCRUMB_SUMMARY_LENGTH = 420;

const SENSITIVE_LABEL_PATTERN = /\b(auth(?:uid)?|authorization|bearer|booking(?:ref|reference)?|drivercode|email|password|push(?:token)?|reference|session(?:id)?|token|uid|userid)\b\s*[:=]\s*['"]?[^,\s'"}\]]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EXPO_TOKEN_PATTERN = /ExponentPushToken\[[^\]]+\]/g;
const SESSION_PATTERN = /\b(?:session|diag)_\d+_[A-Za-z0-9_-]+\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const LONG_IDENTIFIER_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

const stableHash = (value) => {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const clamp = (value, maxLength) => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 18)).trim()}...<${normalized.length}>`;
};

const sanitizeOpsText = (value, maxLength = MAX_SUMMARY_LENGTH) => {
  if (value === null || value === undefined) return '';

  const withoutSensitiveText = String(value)
    .replace(EMAIL_PATTERN, '[email]')
    .replace(EXPO_TOKEN_PATTERN, '[push-token]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(SESSION_PATTERN, '[session]')
    .replace(SENSITIVE_LABEL_PATTERN, (_match, label) => `${label}=[redacted]`)
    .replace(LONG_IDENTIFIER_PATTERN, '[identifier]');

  return clamp(withoutSensitiveText, maxLength);
};

const sanitizeOpsLabelText = (value, maxLength = MAX_COMPONENT_LENGTH) => {
  if (value === null || value === undefined) return '';

  const withoutSensitiveText = String(value)
    .replace(EMAIL_PATTERN, '[email]')
    .replace(EXPO_TOKEN_PATTERN, '[push-token]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(SESSION_PATTERN, '[session]')
    .replace(SENSITIVE_LABEL_PATTERN, (_match, label) => `${label}=[redacted]`);

  return clamp(withoutSensitiveText, maxLength);
};

const maskIdentifier = (value) => {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  if (!asString) return null;
  if (asString === 'anonymous') return 'anonymous';
  if (asString.length <= 4) return `${asString[0] || ''}***`;
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

const sanitizeLabel = (value, fallback, maxLength = MAX_COMPONENT_LENGTH) => {
  const normalized = sanitizeOpsLabelText(value, maxLength);
  return normalized || fallback;
};

const sanitizeIdentifierForDisplay = (value, maxLength = MAX_CONTEXT_LENGTH) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^[A-Za-z0-9:_-]{1,120}$/.test(normalized) && !/(booking|drivercode|session|token|auth|uid)/i.test(normalized)) {
    return clamp(normalized, maxLength);
  }
  return sanitizeOpsText(maskIdentifier(normalized), maxLength);
};

const toEpochMs = (value, fallback = Date.now()) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const stripNullish = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.entries(value).reduce((output, [key, childValue]) => {
    if (childValue === null || childValue === undefined || childValue === '') return output;
    if (typeof childValue === 'object' && !Array.isArray(childValue)) {
      const compactChild = stripNullish(childValue);
      if (compactChild && Object.keys(compactChild).length > 0) {
        output[key] = compactChild;
      }
      return output;
    }
    output[key] = childValue;
    return output;
  }, {});
};

const normalizeSeverity = (level, isFatal = false) => {
  const normalizedLevel = String(level || '').toUpperCase();
  if (isFatal || normalizedLevel === OPS_ALERT_LEVELS.FATAL) return OPS_ALERT_SEVERITIES.CRITICAL;
  if (normalizedLevel === OPS_ALERT_LEVELS.ERROR) return OPS_ALERT_SEVERITIES.ERROR;
  return OPS_ALERT_SEVERITIES.WARNING;
};

const normalizeLevel = (level, isFatal = false) => {
  if (isFatal) return OPS_ALERT_LEVELS.FATAL;
  const normalized = String(level || '').toUpperCase();
  return normalized === OPS_ALERT_LEVELS.FATAL ? OPS_ALERT_LEVELS.FATAL : OPS_ALERT_LEVELS.ERROR;
};

const sanitizeDeviceInfo = (deviceInfo = {}, extra = {}) => {
  const platform = deviceInfo?.platform || deviceInfo?.platformName || deviceInfo?.os || deviceInfo?.runtime?.platform;
  const version = deviceInfo?.version || deviceInfo?.platformVersion || deviceInfo?.osVersion;
  const model = deviceInfo?.model || deviceInfo?.deviceModel || deviceInfo?.runtime?.model;

  return stripNullish({
    platform: sanitizeLabel(platform, 'unknown', MAX_DEVICE_LENGTH),
    version: sanitizeLabel(version, 'unknown', MAX_DEVICE_LENGTH),
    model: sanitizeLabel(model, 'unknown', MAX_DEVICE_LENGTH),
    appVersion: sanitizeIdentifierForDisplay(extra?.appVersion || deviceInfo?.appVersion, MAX_DEVICE_LENGTH),
    appBuild: sanitizeIdentifierForDisplay(extra?.appBuild || deviceInfo?.appBuild, MAX_DEVICE_LENGTH),
    osVersion: sanitizeLabel(extra?.osVersion || deviceInfo?.osVersion, 'unknown', MAX_DEVICE_LENGTH),
  });
};

const extractAppContext = (data = {}) => {
  if (!data || typeof data !== 'object') return {};

  return stripNullish({
    tourId: sanitizeIdentifierForDisplay(data.tourId || data.activeTourId || data.sanitizedTourId),
    role: sanitizeLabel(data.role || data.mode || data.principalType, '', 40),
    screen: sanitizeLabel(data.screen || data.routeName || data.currentScreen, '', 80),
    isFatal: typeof data.isFatal === 'boolean' ? data.isFatal : undefined,
  });
};

const summarizeLogData = (data = {}, fallbackMessage = '') => {
  if (!data || typeof data !== 'object') return sanitizeOpsText(fallbackMessage, MAX_SUMMARY_LENGTH);

  const snippets = [];
  ['error', 'reason', 'status', 'lastError', 'warning'].forEach((key) => {
    if (data[key] === null || data[key] === undefined) return;
    const value = typeof data[key] === 'object'
      ? JSON.stringify(data[key])
      : data[key];
    const sanitized = sanitizeOpsText(value, 160);
    if (sanitized) snippets.push(`${key}: ${sanitized}`);
  });

  if (typeof data.isFatal === 'boolean') {
    snippets.push(`fatal: ${data.isFatal ? 'yes' : 'no'}`);
  }

  return sanitizeOpsText(snippets.length ? snippets.join(' | ') : fallbackMessage, MAX_SUMMARY_LENGTH);
};

const summarizeBreadcrumbs = (breadcrumbs = []) => {
  const list = Array.isArray(breadcrumbs) ? breadcrumbs : [];
  const latest = list.slice(-5).map((breadcrumb) => {
    const component = sanitizeLabel(breadcrumb?.component, 'Unknown', 60);
    const event = sanitizeLabel(breadcrumb?.event || breadcrumb?.message, 'event', 80);
    return `${component}:${event}`;
  });

  return stripNullish({
    count: list.length,
    latest: sanitizeOpsText(latest.join(' | '), MAX_BREADCRUMB_SUMMARY_LENGTH),
  });
};

const buildFingerprint = ({
  source,
  level,
  component,
  message,
  userKey,
  deviceInfo,
  appContext,
  stackHash,
}) => {
  const basis = [
    source,
    level,
    component,
    message,
    userKey,
    deviceInfo?.platform,
    deviceInfo?.appVersion,
    appContext?.tourId,
    appContext?.role,
    stackHash,
  ].map((part) => String(part || '').toLowerCase()).join('|');

  return `opa_${stableHash(basis)}`;
};

const buildOpsAlertFromLog = (log = {}, options = {}) => {
  const rawLevel = String(log.level || '').toUpperCase();
  if (!Object.values(OPS_ALERT_LEVELS).includes(rawLevel) && !log?.data?.isFatal) {
    return null;
  }

  const normalizedLevel = normalizeLevel(log.level, log?.data?.isFatal);

  const createdAtMs = toEpochMs(log.timestamp);
  const createdAt = new Date(createdAtMs).toISOString();
  const component = sanitizeLabel(log.component, 'Unknown', MAX_COMPONENT_LENGTH);
  const message = sanitizeOpsText(log.message || 'Mobile app error', MAX_MESSAGE_LENGTH);
  const data = log.data || {};
  const appContext = extractAppContext(data);
  const deviceInfo = sanitizeDeviceInfo(log.deviceInfo, data);
  const userKey = maskIdentifier(log.routeUserId || log.userId || 'anonymous') || 'anonymous';
  const sessionKey = maskIdentifier(log.routeSessionId || log.sessionId || 'session_unknown') || 'session_unknown';
  const source = options.source || OPS_ALERT_SOURCES.MOBILE_LOGGER;
  const severity = normalizeSeverity(normalizedLevel, data?.isFatal);
  const stackHash = data?.stack ? stableHash(sanitizeOpsText(data.stack, 1200)) : null;
  const fingerprint = buildFingerprint({
    source,
    level: normalizedLevel,
    component,
    message,
    userKey,
    deviceInfo,
    appContext,
    stackHash,
  });

  return stripNullish({
    alertVersion: OPS_ALERT_VERSION,
    fingerprint,
    createdAt,
    createdAtMs,
    lastSeenAt: createdAt,
    lastSeenAtMs: createdAtMs,
    severity,
    level: normalizedLevel,
    source,
    component,
    message,
    status: OPS_ALERT_STATUSES.OPEN,
    userKey,
    sessionKey,
    deviceInfo,
    tourId: appContext.tourId,
    role: appContext.role,
    appContext,
    summary: summarizeLogData(data, message),
    count: 1,
  });
};

const readMaskedSnapshotSession = (snapshot = {}) => {
  const raw = snapshot?.diagnosticsSessionId;
  if (typeof raw === 'string') return maskIdentifier(raw);
  if (raw?.masked) return sanitizeOpsText(raw.masked, 80);
  if (raw?.hash) return `diag:${sanitizeOpsText(raw.hash, 32)}`;
  return 'session_unknown';
};

const buildOpsAlertFromCrashSnapshot = (snapshot = {}, options = {}) => {
  const error = snapshot?.extra?.error || snapshot?.extra?.lastEvent?.data || {};
  const isFatal = Boolean(error?.isFatal || snapshot?.extra?.isFatal);
  const level = normalizeLevel(OPS_ALERT_LEVELS.ERROR, isFatal);
  const severity = normalizeSeverity(level, isFatal);
  const createdAtMs = toEpochMs(snapshot.generatedAt);
  const createdAt = new Date(createdAtMs).toISOString();
  const breadcrumbs = Array.isArray(snapshot.breadcrumbs) ? snapshot.breadcrumbs : [];
  const latestBreadcrumb = breadcrumbs[breadcrumbs.length - 1] || {};
  const component = sanitizeLabel(latestBreadcrumb.component || 'GlobalError', 'GlobalError', MAX_COMPONENT_LENGTH);
  const errorMessage = sanitizeOpsText(error?.message || snapshot.reason || 'Unhandled mobile error', MAX_MESSAGE_LENGTH);
  const message = error?.name
    ? sanitizeOpsText(`${error.name}: ${errorMessage}`, MAX_MESSAGE_LENGTH)
    : errorMessage;
  const appContext = extractAppContext({
    ...(snapshot.context || {}),
    ...(snapshot.extra || {}),
    isFatal,
  });
  const deviceInfo = sanitizeDeviceInfo(snapshot.runtime || {}, snapshot.context?.app || {});
  const userKey = sanitizeOpsText(snapshot?.auth?.authUid || 'anonymous', 80) || 'anonymous';
  const sessionKey = readMaskedSnapshotSession(snapshot);
  const source = options.source || OPS_ALERT_SOURCES.CRASH_DIAGNOSTICS;
  const stackHash = error?.stack ? stableHash(sanitizeOpsText(error.stack, 1200)) : null;
  const fingerprint = buildFingerprint({
    source,
    level,
    component,
    message,
    userKey,
    deviceInfo,
    appContext,
    stackHash,
  });

  return stripNullish({
    alertVersion: OPS_ALERT_VERSION,
    fingerprint,
    createdAt,
    createdAtMs,
    lastSeenAt: createdAt,
    lastSeenAtMs: createdAtMs,
    severity,
    level,
    source,
    component,
    message,
    status: OPS_ALERT_STATUSES.OPEN,
    userKey,
    sessionKey,
    deviceInfo,
    tourId: appContext.tourId,
    role: appContext.role,
    appContext,
    crashBreadcrumbSummary: summarizeBreadcrumbs(breadcrumbs),
    summary: sanitizeOpsText(`${snapshot.reason || 'crash'} | breadcrumbs: ${breadcrumbs.length}`, MAX_SUMMARY_LENGTH),
    count: 1,
  });
};

const mergeOpsAlertRecord = (current, incoming) => {
  if (!incoming || typeof incoming !== 'object') return current || null;

  const previous = current && typeof current === 'object' ? current : null;
  const incomingCount = Math.max(1, Number(incoming.count) || 1);
  const previousCount = previous ? Math.max(0, Number(previous.count) || 0) : 0;
  const previousStatus = previous?.status;
  const nextStatus = previousStatus === OPS_ALERT_STATUSES.RESOLVED
    ? OPS_ALERT_STATUSES.OPEN
    : previousStatus || incoming.status || OPS_ALERT_STATUSES.OPEN;
  const lastSeenAtMs = Math.max(
    Number(previous?.lastSeenAtMs) || 0,
    Number(incoming.lastSeenAtMs) || Number(incoming.createdAtMs) || Date.now(),
  );

  return stripNullish({
    ...previous,
    ...incoming,
    createdAt: previous?.createdAt || incoming.createdAt || nowIso(incoming.createdAtMs),
    createdAtMs: previous?.createdAtMs || incoming.createdAtMs || lastSeenAtMs,
    lastSeenAt: nowIso(lastSeenAtMs),
    lastSeenAtMs,
    status: nextStatus,
    count: previousCount + incomingCount,
    acknowledgedAtMs: previous?.acknowledgedAtMs,
    resolvedAtMs: previous?.resolvedAtMs,
    statusUpdatedAt: previous?.statusUpdatedAt,
    statusUpdatedAtMs: previous?.statusUpdatedAtMs,
    statusUpdatedBy: previous?.statusUpdatedBy,
    reopenedAtMs: previousStatus === OPS_ALERT_STATUSES.RESOLVED ? lastSeenAtMs : previous?.reopenedAtMs,
  });
};

const createOrUpdateOpsAlert = async (database, alert) => {
  if (!database?.ref || !alert?.fingerprint) {
    return { success: false, error: 'OPS_ALERT_DATABASE_UNAVAILABLE' };
  }

  const alertRef = database.ref(`ops_alerts/${alert.fingerprint}`);

  try {
    if (typeof alertRef.transaction === 'function') {
      await alertRef.transaction((current) => mergeOpsAlertRecord(current, alert), undefined, false);
      return { success: true, id: alert.fingerprint };
    }

    const nextRecord = mergeOpsAlertRecord(null, alert);
    if (typeof alertRef.set === 'function') {
      await alertRef.set(nextRecord);
      return { success: true, id: alert.fingerprint };
    }

    return { success: false, error: 'OPS_ALERT_WRITE_UNSUPPORTED' };
  } catch (error) {
    return { success: false, error: error?.message || 'OPS_ALERT_WRITE_FAILED' };
  }
};

module.exports = {
  OPS_ALERT_LEVELS,
  OPS_ALERT_SEVERITIES,
  OPS_ALERT_SOURCES,
  OPS_ALERT_STATUSES,
  OPS_ALERT_VERSION,
  buildOpsAlertFromCrashSnapshot,
  buildOpsAlertFromLog,
  createOrUpdateOpsAlert,
  mergeOpsAlertRecord,
  sanitizeOpsText,
  stableHash,
  default: {
    OPS_ALERT_LEVELS,
    OPS_ALERT_SEVERITIES,
    OPS_ALERT_SOURCES,
    OPS_ALERT_STATUSES,
    OPS_ALERT_VERSION,
    buildOpsAlertFromCrashSnapshot,
    buildOpsAlertFromLog,
    createOrUpdateOpsAlert,
    mergeOpsAlertRecord,
    sanitizeOpsText,
    stableHash,
  },
};
