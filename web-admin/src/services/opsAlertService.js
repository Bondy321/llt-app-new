import { get, limitToLast, onValue, orderByChild, query, ref, update } from 'firebase/database';
import {
  logFirebaseDebug,
  logFirebaseError,
  startFirebaseDebugTimer,
  summarizeDataValue,
  summarizeDatabaseInstance,
  summarizeFirebaseSnapshot,
} from './firebaseDebug';

export const OPS_ALERTS_ROOT = 'ops_alerts';

export const OPS_ALERT_STATUS = {
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
};

export const OPS_ALERT_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
};

export const OPS_ALERT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: OPS_ALERT_STATUS.OPEN, label: 'Open' },
  { value: OPS_ALERT_STATUS.ACKNOWLEDGED, label: 'Acknowledged' },
  { value: OPS_ALERT_STATUS.RESOLVED, label: 'Resolved' },
  { value: 'all', label: 'All statuses' },
];

export const OPS_ALERT_SEVERITY_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: OPS_ALERT_SEVERITY.CRITICAL, label: 'Critical' },
  { value: OPS_ALERT_SEVERITY.ERROR, label: 'Error' },
  { value: OPS_ALERT_SEVERITY.WARNING, label: 'Warning' },
  { value: OPS_ALERT_SEVERITY.INFO, label: 'Info' },
];

const ALLOWED_ORDER_FIELDS = new Set(['createdAtMs', 'lastSeenAtMs', 'severity', 'status']);
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

const SEVERITY_WEIGHT = {
  [OPS_ALERT_SEVERITY.CRITICAL]: 4,
  [OPS_ALERT_SEVERITY.ERROR]: 3,
  [OPS_ALERT_SEVERITY.WARNING]: 2,
  [OPS_ALERT_SEVERITY.INFO]: 1,
};

const sanitizeText = (value, fallback = '', maxLength = 240, options = {}) => {
  let normalized = String(value ?? fallback)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/ExponentPushToken\[[^\]]+\]/g, '[push-token]')
    .replace(/\b(?:session|diag)_\d+_[A-Za-z0-9_-]+\b/g, '[session]')
    .replace(/\b(auth(?:uid)?|authorization|booking(?:ref|reference)?|drivercode|password|push(?:token)?|session(?:id)?|token|uid|userid)\b\s*[:=]\s*['"]?[^,\s'"}\]]+/gi, (_match, label) => `${label}=[redacted]`)
    .trim();

  if (options.redactLongIdentifiers !== false) {
    normalized = normalized.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[identifier]');
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 18)).trim()}...<${normalized.length}>`;
};

const normalizeStatus = (status) => (
  Object.values(OPS_ALERT_STATUS).includes(status) ? status : OPS_ALERT_STATUS.OPEN
);

const normalizeSeverity = (severity) => (
  Object.values(OPS_ALERT_SEVERITY).includes(severity) ? severity : OPS_ALERT_SEVERITY.ERROR
);

const normalizeNumber = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

export function normalizeOpsAlert(id, value = {}) {
  const status = normalizeStatus(value.status);
  const severity = normalizeSeverity(value.severity);
  const lastSeenAtMs = normalizeNumber(value.lastSeenAtMs, normalizeNumber(value.createdAtMs, 0));
  const createdAtMs = normalizeNumber(value.createdAtMs, lastSeenAtMs);

  return {
    id,
    alertVersion: value.alertVersion || 1,
    fingerprint: sanitizeText(value.fingerprint || id, id, 80, { redactLongIdentifiers: false }),
    createdAt: sanitizeText(value.createdAt, '', 40),
    createdAtMs,
    lastSeenAt: sanitizeText(value.lastSeenAt, '', 40),
    lastSeenAtMs,
    severity,
    level: value.level === 'FATAL' ? 'FATAL' : 'ERROR',
    source: sanitizeText(value.source, 'mobile_logger', 40, { redactLongIdentifiers: false }),
    component: sanitizeText(value.component, 'Unknown', 80, { redactLongIdentifiers: false }),
    message: sanitizeText(value.message, 'Mobile app error', 240),
    status,
    userKey: sanitizeText(value.userKey, 'anonymous', 80),
    sessionKey: sanitizeText(value.sessionKey, 'session_unknown', 80),
    tourId: value.tourId ? sanitizeText(value.tourId, '', 120, { redactLongIdentifiers: false }) : null,
    role: value.role ? sanitizeText(value.role, '', 40, { redactLongIdentifiers: false }) : null,
    deviceInfo: {
      platform: sanitizeText(value.deviceInfo?.platform, 'unknown', 80, { redactLongIdentifiers: false }),
      version: sanitizeText(value.deviceInfo?.version, 'unknown', 80, { redactLongIdentifiers: false }),
      model: sanitizeText(value.deviceInfo?.model, 'unknown', 80, { redactLongIdentifiers: false }),
      appVersion: value.deviceInfo?.appVersion ? sanitizeText(value.deviceInfo.appVersion, '', 80, { redactLongIdentifiers: false }) : null,
      appBuild: value.deviceInfo?.appBuild ? sanitizeText(value.deviceInfo.appBuild, '', 80, { redactLongIdentifiers: false }) : null,
      osVersion: value.deviceInfo?.osVersion ? sanitizeText(value.deviceInfo.osVersion, '', 80, { redactLongIdentifiers: false }) : null,
    },
    appContext: {
      tourId: value.appContext?.tourId ? sanitizeText(value.appContext.tourId, '', 120, { redactLongIdentifiers: false }) : null,
      role: value.appContext?.role ? sanitizeText(value.appContext.role, '', 40, { redactLongIdentifiers: false }) : null,
      screen: value.appContext?.screen ? sanitizeText(value.appContext.screen, '', 80, { redactLongIdentifiers: false }) : null,
      isFatal: typeof value.appContext?.isFatal === 'boolean' ? value.appContext.isFatal : null,
    },
    crashBreadcrumbSummary: value.crashBreadcrumbSummary
      ? {
          count: normalizeNumber(value.crashBreadcrumbSummary.count, 0),
          latest: sanitizeText(value.crashBreadcrumbSummary.latest, '', 420),
        }
      : null,
    summary: sanitizeText(value.summary, '', 600),
    count: Math.max(1, normalizeNumber(value.count, 1)),
    acknowledgedAtMs: value.acknowledgedAtMs ? normalizeNumber(value.acknowledgedAtMs) : null,
    resolvedAtMs: value.resolvedAtMs ? normalizeNumber(value.resolvedAtMs) : null,
    reopenedAtMs: value.reopenedAtMs ? normalizeNumber(value.reopenedAtMs) : null,
    statusUpdatedAt: value.statusUpdatedAt ? sanitizeText(value.statusUpdatedAt, '', 40) : null,
    statusUpdatedAtMs: value.statusUpdatedAtMs ? normalizeNumber(value.statusUpdatedAtMs) : null,
    statusUpdatedBy: value.statusUpdatedBy ? sanitizeText(value.statusUpdatedBy, '', 80) : null,
  };
}

const buildOpsAlertsQuery = (database, options = {}) => {
  const orderField = ALLOWED_ORDER_FIELDS.has(options.orderBy) ? options.orderBy : 'lastSeenAtMs';
  const safeLimit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  logFirebaseDebug('ops-alerts:query:build', {
    requestedOptions: options,
    resolved: {
      root: OPS_ALERTS_ROOT,
      orderField,
      safeLimit,
    },
    database: summarizeDatabaseInstance(database),
  });
  return query(
    ref(database, OPS_ALERTS_ROOT),
    orderByChild(orderField),
    limitToLast(safeLimit),
  );
};

const NO_PRELOADED_VALUE = Symbol('NO_PRELOADED_VALUE');

const normalizeOpsAlertsSnapshot = (snapshot, preloadedValue = NO_PRELOADED_VALUE) => {
  const raw = (preloadedValue === NO_PRELOADED_VALUE ? snapshot.val() : preloadedValue) || {};
  return Object.entries(raw)
    .map(([id, value]) => normalizeOpsAlert(id, value || {}))
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
};

export async function fetchOpsAlerts(database, options = {}) {
  const timer = startFirebaseDebugTimer('ops-alerts:fetch', {
    options,
    database: summarizeDatabaseInstance(database),
  });

  try {
    const snapshot = await get(buildOpsAlertsQuery(database, options));
    const raw = snapshot.val() || {};
    const alerts = normalizeOpsAlertsSnapshot(snapshot, raw);
    timer.success({
      snapshot: summarizeFirebaseSnapshot(snapshot, raw),
      normalizedAlertCount: alerts.length,
      normalizedSummary: summarizeDataValue(Object.fromEntries(alerts.map((alert) => [alert.id, {
        severity: alert.severity,
        status: alert.status,
        component: alert.component,
        lastSeenAtMs: alert.lastSeenAtMs,
      }]))),
    });
    return alerts;
  } catch (error) {
    timer.failure(error);
    throw error;
  }
}

export function subscribeToOpsAlerts(database, options = {}, onNext, onError) {
  const alertsQuery = buildOpsAlertsQuery(database, options);
  const startedAtMs = Date.now();
  let eventCount = 0;

  logFirebaseDebug('ops-alerts:subscribe:start', {
    options,
    root: OPS_ALERTS_ROOT,
    database: summarizeDatabaseInstance(database),
  }, 'info');

  return onValue(
    alertsQuery,
    (snapshot) => {
      const raw = snapshot.val() || {};
      const alerts = normalizeOpsAlertsSnapshot(snapshot, raw);
      eventCount += 1;
      logFirebaseDebug('ops-alerts:subscribe:data', {
        eventCount,
        firstEvent: eventCount === 1,
        elapsedSinceAttachMs: Date.now() - startedAtMs,
        snapshot: summarizeFirebaseSnapshot(snapshot, raw),
        normalizedAlertCount: alerts.length,
        newestAlert: alerts[0] ? {
          id: alerts[0].id,
          severity: alerts[0].severity,
          status: alerts[0].status,
          component: alerts[0].component,
          lastSeenAtMs: alerts[0].lastSeenAtMs,
        } : null,
      }, eventCount === 1 ? 'info' : 'debug');
      onNext(alerts);
    },
    (error) => {
      logFirebaseError('ops-alerts:subscribe:error', error, {
        options,
        root: OPS_ALERTS_ROOT,
        eventCount,
        elapsedSinceAttachMs: Date.now() - startedAtMs,
        database: summarizeDatabaseInstance(database),
      });
      onError?.(error);
    },
  );
}

const buildStatusUpdate = (status) => {
  const nowMs = Date.now();
  const payload = {
    status,
    statusUpdatedAt: new Date(nowMs).toISOString(),
    statusUpdatedAtMs: nowMs,
    statusUpdatedBy: 'admin',
  };

  if (status === OPS_ALERT_STATUS.ACKNOWLEDGED) {
    payload.acknowledgedAtMs = nowMs;
  }

  if (status === OPS_ALERT_STATUS.RESOLVED) {
    payload.resolvedAtMs = nowMs;
  }

  return payload;
};

export async function acknowledgeOpsAlert(database, alertId) {
  if (!alertId) throw new Error('Missing alert id');
  const path = `${OPS_ALERTS_ROOT}/${alertId}`;
  const payload = buildStatusUpdate(OPS_ALERT_STATUS.ACKNOWLEDGED);
  const timer = startFirebaseDebugTimer('ops-alerts:acknowledge', {
    alertId,
    path,
    payload,
  });

  try {
    await update(ref(database, path), payload);
    timer.success();
  } catch (error) {
    timer.failure(error);
    throw error;
  }
}

export async function resolveOpsAlert(database, alertId) {
  if (!alertId) throw new Error('Missing alert id');
  const path = `${OPS_ALERTS_ROOT}/${alertId}`;
  const payload = buildStatusUpdate(OPS_ALERT_STATUS.RESOLVED);
  const timer = startFirebaseDebugTimer('ops-alerts:resolve', {
    alertId,
    path,
    payload,
  });

  try {
    await update(ref(database, path), payload);
    timer.success();
  } catch (error) {
    timer.failure(error);
    throw error;
  }
}

export function filterOpsAlerts(alerts = [], filters = {}) {
  const severity = filters.severity || 'all';
  const status = filters.status || 'active';

  return alerts.filter((alert) => {
    const severityMatch = severity === 'all' || alert.severity === severity;
    const statusMatch = status === 'all'
      || (status === 'active' && alert.status !== OPS_ALERT_STATUS.RESOLVED)
      || alert.status === status;

    return severityMatch && statusMatch;
  });
}

export function buildOpsAlertStats(alerts = []) {
  const activeAlerts = alerts.filter((alert) => alert.status !== OPS_ALERT_STATUS.RESOLVED);
  const openCriticalAlerts = activeAlerts.filter((alert) => (
    alert.severity === OPS_ALERT_SEVERITY.CRITICAL && alert.status === OPS_ALERT_STATUS.OPEN
  ));
  const openErrorAlerts = activeAlerts.filter((alert) => (
    [OPS_ALERT_SEVERITY.CRITICAL, OPS_ALERT_SEVERITY.ERROR].includes(alert.severity)
    && alert.status === OPS_ALERT_STATUS.OPEN
  ));

  const bySeverity = alerts.reduce((acc, alert) => ({
    ...acc,
    [alert.severity]: (acc[alert.severity] || 0) + 1,
  }), {});

  const byStatus = alerts.reduce((acc, alert) => ({
    ...acc,
    [alert.status]: (acc[alert.status] || 0) + 1,
  }), {});

  const byComponent = activeAlerts.reduce((acc, alert) => ({
    ...acc,
    [alert.component]: (acc[alert.component] || 0) + 1,
  }), {});

  const mostSevereActiveAlert = [...activeAlerts].sort((a, b) => {
    const severityDelta = (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0);
    if (severityDelta !== 0) return severityDelta;
    return b.lastSeenAtMs - a.lastSeenAtMs;
  })[0] || null;

  return {
    totalCount: alerts.length,
    activeCount: activeAlerts.length,
    openCriticalCount: openCriticalAlerts.length,
    openErrorCount: openErrorAlerts.length,
    bySeverity,
    byStatus,
    byComponent,
    mostSevereActiveAlert,
  };
}

export function formatAffectedDevice(alert) {
  const device = alert?.deviceInfo || {};
  const parts = [device.platform, device.model, device.appVersion ? `app ${device.appVersion}` : null]
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : 'unknown device';
}

export function formatAffectedSession(alert) {
  const role = alert?.role ? `${alert.role} ` : '';
  const tour = alert?.tourId ? ` / tour ${alert.tourId}` : '';
  return `${role}${alert?.userKey || 'anonymous'} / ${alert?.sessionKey || 'session_unknown'}${tour}`;
}
