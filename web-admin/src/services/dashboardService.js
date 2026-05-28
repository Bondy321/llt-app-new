import { get, onValue, ref, update } from 'firebase/database';
import { nowAsISOString, toEpochMsStrict } from '../utils/dateUtils';
import {
  calculateDayDelta,
  getUrgencyBadge,
  isWithinTriageWindow,
  parseTriageDate,
} from '../utils/triageUtils';

export const DASHBOARD_BRANCHES = {
  drivers: 'drivers',
  tours: 'tours',
  tourManifests: 'tour_manifests',
  globalSafetyAlerts: 'globalSafetyAlerts',
  broadcasts: 'broadcasts',
};

export const SAFETY_STATUS = {
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
};

export const SAFETY_STATUS_OPTIONS = [
  { value: 'attention', label: 'Needs attention' },
  { value: SAFETY_STATUS.PENDING, label: 'Pending' },
  { value: SAFETY_STATUS.ACKNOWLEDGED, label: 'Acknowledged' },
  { value: SAFETY_STATUS.IN_PROGRESS, label: 'In progress' },
  { value: SAFETY_STATUS.ESCALATED, label: 'Escalated' },
  { value: SAFETY_STATUS.RESOLVED, label: 'Resolved' },
  { value: 'all', label: 'All statuses' },
];

const SAFETY_ATTENTION_STATUSES = new Set([
  SAFETY_STATUS.PENDING,
  SAFETY_STATUS.ACKNOWLEDGED,
  SAFETY_STATUS.IN_PROGRESS,
  SAFETY_STATUS.ESCALATED,
]);

const SAFETY_SEVERITY_WEIGHT = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const OPS_SEVERITY_WEIGHT = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
};

const DEFAULT_WINDOW = {
  maxFutureDays: 14,
  maxOverdueDays: 7,
};

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const asRecord = (value) => (isPlainObject(value) ? value : {});

const cleanString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const toFiniteNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const countCollection = (value) => {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined && item !== '').length;
  }

  if (isPlainObject(value)) {
    return Object.keys(value).length;
  }

  return 0;
};

const hasTruthyChild = (value) => Object.values(asRecord(value)).some(Boolean);

export function sanitizeDashboardText(value, fallback = 'Unavailable', maxLength = 180, options = {}) {
  const shouldRedactLongIdentifiers = options.redactLongIdentifiers !== false;
  let normalized = String(value ?? fallback)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/ExponentPushToken\[[^\]]+\]/g, '[push-token]')
    .replace(/\b(?:session|diag)_\d+_[A-Za-z0-9_-]+\b/g, '[session]')
    .replace(/\b(auth(?:uid)?|authorization|booking(?:ref|reference|id)?|drivercode|password|push(?:token)?|session(?:id)?|token|uid|userid)\b\s*[:=]\s*['"]?[^,\s'"}\]]+/gi, (_match, label) => `${label}=[redacted]`)
    .replace(/\s+/g, ' ')
    .trim();

  if (shouldRedactLongIdentifiers) {
    normalized = normalized.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[identifier]');
  }

  if (!normalized) normalized = fallback;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 18)).trim()}...<${normalized.length}>`;
}

export function subscribeToDashboardBranches(database, handlers = {}) {
  return Object.entries(DASHBOARD_BRANCHES).map(([key, path]) => onValue(
    ref(database, path),
    (snapshot) => {
      handlers.onData?.(key, snapshot.val() || {}, nowAsISOString());
    },
    (error) => {
      handlers.onError?.(key, error);
    },
  ));
}

export async function revalidateDashboardBranches(database) {
  const entries = await Promise.all(
    Object.entries(DASHBOARD_BRANCHES).map(async ([key, path]) => {
      const snapshot = await get(ref(database, path));
      return [key, snapshot.val() || {}];
    }),
  );

  return {
    ...Object.fromEntries(entries),
    revalidatedAt: nowAsISOString(),
  };
}

export function resolveDriverCurrentTourId(driver) {
  return cleanString(driver?.currentTourId || driver?.activeTourId || '');
}

export function driverHasAssignment(driver) {
  return Boolean(resolveDriverCurrentTourId(driver) || hasTruthyChild(driver?.assignments));
}

function getManifestAssignedDriverCount(manifest) {
  const assignedDrivers = asRecord(manifest?.assigned_drivers);
  const assignedCodes = asRecord(manifest?.assigned_driver_codes);
  return new Set([
    ...Object.entries(assignedDrivers).filter(([, value]) => Boolean(value)).map(([id]) => id),
    ...Object.entries(assignedCodes).filter(([, value]) => Boolean(value)).map(([id]) => id),
  ]).size;
}

function getManifestPassengerCount(manifest) {
  return Object.values(asRecord(manifest?.bookings)).reduce((total, booking) => {
    const passengerStatusCount = countCollection(booking?.passengerStatus);
    if (passengerStatusCount > 0) return total + passengerStatusCount;

    const passengerCount = countCollection(booking?.passengers);
    if (passengerCount > 0) return total + passengerCount;

    const passengerNamesCount = countCollection(booking?.passengerNames);
    if (passengerNamesCount > 0) return total + passengerNamesCount;

    return total + 1;
  }, 0);
}

function getTourPassengerCount(tour, manifest) {
  const explicitCount = toFiniteNumber(tour?.currentParticipants);
  if (explicitCount !== null && explicitCount >= 0) {
    return { count: explicitCount, source: 'tour.currentParticipants' };
  }

  const participantsCount = countCollection(tour?.participants);
  if (participantsCount > 0) {
    return { count: participantsCount, source: 'tours.participants' };
  }

  const manifestCount = getManifestPassengerCount(manifest);
  if (manifestCount > 0) {
    return { count: manifestCount, source: 'tour_manifests.bookings' };
  }

  return { count: 0, source: 'none' };
}

function getTourCapacity(tour) {
  const capacity = toFiniteNumber(tour?.maxParticipants);
  return capacity !== null && capacity > 0 ? capacity : null;
}

function buildCurrentDriverByTour(drivers) {
  const byTour = new Map();

  Object.values(asRecord(drivers)).forEach((driver) => {
    const currentTourId = resolveDriverCurrentTourId(driver);
    if (!currentTourId || byTour.has(currentTourId)) return;
    byTour.set(currentTourId, cleanString(driver?.name, 'Assigned driver'));
  });

  return byTour;
}

function getTourDateMeta(startDate, nowDate, windowOptions) {
  const parsed = parseTriageDate(startDate);
  if (!parsed.success) {
    return {
      hasValidDate: false,
      parsedDate: null,
      startAtMs: null,
      dayDelta: null,
      inAttentionWindow: false,
      urgency: null,
    };
  }

  const dayDelta = calculateDayDelta(parsed.date, nowDate);
  return {
    hasValidDate: true,
    parsedDate: parsed.date,
    startAtMs: parsed.date.getTime(),
    dayDelta,
    inAttentionWindow: isWithinTriageWindow(dayDelta, windowOptions),
    urgency: getUrgencyBadge(dayDelta),
  };
}

function buildTourRows({ drivers, tours, tourManifests }, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date(options.nowMs || Date.now());
  const windowOptions = {
    ...DEFAULT_WINDOW,
    ...(options.window || {}),
  };
  const currentDriverByTour = buildCurrentDriverByTour(drivers);

  return Object.entries(asRecord(tours)).map(([id, tour]) => {
    const manifest = asRecord(tourManifests?.[id]);
    const manifestDriverCount = getManifestAssignedDriverCount(manifest);
    const tourDriverName = cleanString(tour?.driverName);
    const assignedDriverName = currentDriverByTour.get(id) || tourDriverName;
    const isAssigned = manifestDriverCount > 0
      || Boolean(currentDriverByTour.get(id))
      || (Boolean(tourDriverName) && tourDriverName.toUpperCase() !== 'TBA');
    const passengers = getTourPassengerCount(tour, manifest);
    const capacity = getTourCapacity(tour);
    const loadPercent = capacity ? Math.round((passengers.count / capacity) * 100) : null;
    const dateMeta = getTourDateMeta(tour?.startDate, nowDate, windowOptions);

    return {
      id,
      name: sanitizeDashboardText(tour?.name || tour?.tourCode || id, id, 120, { redactLongIdentifiers: false }),
      tourCode: sanitizeDashboardText(tour?.tourCode || id, id, 120, { redactLongIdentifiers: false }),
      startDate: tour?.startDate || null,
      isActive: tour?.isActive !== false,
      isAssigned,
      assignedDriverName: isAssigned
        ? sanitizeDashboardText(assignedDriverName || 'Assigned driver', 'Assigned driver', 120)
        : null,
      manifestDriverCount,
      passengerCount: passengers.count,
      passengerCountSource: passengers.source,
      capacity,
      loadPercent,
      hasKnownCapacity: capacity !== null,
      dateMeta,
    };
  });
}

function normalizeSafetyStatus(status) {
  return Object.values(SAFETY_STATUS).includes(status) ? status : SAFETY_STATUS.PENDING;
}

function normalizeSafetySeverity(severity) {
  return Object.keys(SAFETY_SEVERITY_WEIGHT).includes(severity) ? severity : 'medium';
}

function normalizeSafetyAlert({ id, path, source, tourIdHint, payload }) {
  const timestampMs = toEpochMsStrict(payload?.timestamp);
  const severity = normalizeSafetySeverity(payload?.severity);
  const status = normalizeSafetyStatus(payload?.status);
  const message = payload?.customMessage || payload?.message || payload?.category || 'Safety event';

  return {
    id: `${source}:${id}`,
    eventId: cleanString(payload?.eventId || ''),
    paths: [path],
    source,
    tourId: cleanString(payload?.tourId || tourIdHint || ''),
    category: sanitizeDashboardText(payload?.category || 'safety', 'safety', 60, { redactLongIdentifiers: false }),
    severity,
    status,
    role: payload?.role ? sanitizeDashboardText(payload.role, 'unknown', 40, { redactLongIdentifiers: false }) : null,
    message: sanitizeDashboardText(message, 'Safety event', 180),
    isSOS: Boolean(payload?.isSOS),
    timestamp: payload?.timestamp || null,
    timestampMs: timestampMs ?? 0,
    requiresAttention: SAFETY_ATTENTION_STATUSES.has(status),
  };
}

function mergeSafetyAlert(existing, incoming) {
  if (!existing) return incoming;

  return {
    ...existing,
    paths: [...new Set([...existing.paths, ...incoming.paths])],
    source: existing.source === 'global' || incoming.source !== 'global' ? existing.source : incoming.source,
    severity: (SAFETY_SEVERITY_WEIGHT[incoming.severity] || 0) > (SAFETY_SEVERITY_WEIGHT[existing.severity] || 0)
      ? incoming.severity
      : existing.severity,
    status: existing.status === SAFETY_STATUS.RESOLVED ? incoming.status : existing.status,
    timestampMs: Math.max(existing.timestampMs, incoming.timestampMs),
    requiresAttention: existing.requiresAttention || incoming.requiresAttention,
  };
}

export function buildSafetyAlerts({ tours = {}, globalSafetyAlerts = {} } = {}) {
  const alerts = [];

  Object.entries(asRecord(globalSafetyAlerts)).forEach(([id, payload]) => {
    alerts.push(normalizeSafetyAlert({
      id,
      path: `globalSafetyAlerts/${id}`,
      source: 'global',
      tourIdHint: payload?.tourId,
      payload: payload || {},
    }));
  });

  Object.entries(asRecord(tours)).forEach(([tourId, tour]) => {
    Object.entries(asRecord(tour?.safetyAlerts)).forEach(([id, payload]) => {
      alerts.push(normalizeSafetyAlert({
        id,
        path: `tours/${tourId}/safetyAlerts/${id}`,
        source: 'tour',
        tourIdHint: tourId,
        payload: payload || {},
      }));
    });
  });

  const deduped = new Map();
  alerts.forEach((alert) => {
    const dedupeKey = alert.eventId
      ? `event:${alert.eventId}`
      : `${alert.tourId}|${alert.timestampMs}|${alert.category}|${alert.message}`;
    deduped.set(dedupeKey, mergeSafetyAlert(deduped.get(dedupeKey), alert));
  });

  return [...deduped.values()].sort((a, b) => {
    const attentionDelta = Number(b.requiresAttention) - Number(a.requiresAttention);
    if (attentionDelta !== 0) return attentionDelta;

    const severityDelta = (SAFETY_SEVERITY_WEIGHT[b.severity] || 0) - (SAFETY_SEVERITY_WEIGHT[a.severity] || 0);
    if (severityDelta !== 0) return severityDelta;

    return b.timestampMs - a.timestampMs;
  });
}

export function filterSafetyAlerts(alerts = [], status = 'attention') {
  return alerts.filter((alert) => {
    if (status === 'all') return true;
    if (status === 'attention') return alert.requiresAttention;
    return alert.status === status;
  });
}

export async function updateSafetyAlertStatus(database, alert, status) {
  if (!alert?.paths?.length) throw new Error('Missing safety alert path');
  const nextStatus = normalizeSafetyStatus(status);
  const payload = {
    status: nextStatus,
    statusUpdatedAt: nowAsISOString(),
    statusUpdatedBy: 'web-admin',
  };

  await Promise.all(alert.paths.map((path) => update(ref(database, path), payload)));
}

export function buildBroadcastActivity(broadcasts = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const recentLimit = options.limit || 8;
  const rows = [];

  Object.entries(asRecord(broadcasts)).forEach(([tourId, byBroadcastId]) => {
    Object.entries(asRecord(byBroadcastId)).forEach(([id, payload]) => {
      const timestampMs = toEpochMsStrict(payload?.createdAtMs) ?? 0;
      rows.push({
        id: `${tourId}:${id}`,
        tourId: sanitizeDashboardText(tourId, tourId, 120, { redactLongIdentifiers: false }),
        message: sanitizeDashboardText(payload?.message, 'Broadcast message', 180),
        source: sanitizeDashboardText(payload?.source || 'unknown', 'unknown', 40, { redactLongIdentifiers: false }),
        timestampMs,
      });
    });
  });

  const sorted = rows.sort((a, b) => b.timestampMs - a.timestampMs);
  const last24hCount = sorted.filter((item) => item.timestampMs > 0 && nowMs - item.timestampMs <= 24 * 60 * 60 * 1000).length;

  return {
    totalCount: sorted.length,
    last24hCount,
    tourCount: new Set(sorted.map((item) => item.tourId)).size,
    lastBroadcastAtMs: sorted[0]?.timestampMs || null,
    recent: sorted.slice(0, recentLimit),
  };
}

export function buildComponentAlertSummary(opsAlerts = []) {
  const groups = new Map();

  opsAlerts
    .filter((alert) => alert?.status !== 'resolved')
    .filter((alert) => ['warning', 'error', 'critical'].includes(alert?.severity))
    .forEach((alert) => {
      const component = sanitizeDashboardText(alert.component, 'Unknown', 80, { redactLongIdentifiers: false });
      const existing = groups.get(component) || {
        component,
        activeCount: 0,
        criticalCount: 0,
        errorCount: 0,
        warningCount: 0,
        latestSeenAtMs: 0,
        latestMessage: '',
        maxSeverity: 'info',
      };

      existing.activeCount += 1;
      if (alert.severity === 'critical') existing.criticalCount += 1;
      if (alert.severity === 'error') existing.errorCount += 1;
      if (alert.severity === 'warning') existing.warningCount += 1;

      if ((alert.lastSeenAtMs || 0) >= existing.latestSeenAtMs) {
        existing.latestSeenAtMs = alert.lastSeenAtMs || 0;
        existing.latestMessage = sanitizeDashboardText(alert.message, 'Mobile app alert', 120);
      }

      if ((OPS_SEVERITY_WEIGHT[alert.severity] || 0) > (OPS_SEVERITY_WEIGHT[existing.maxSeverity] || 0)) {
        existing.maxSeverity = alert.severity;
      }

      groups.set(component, existing);
    });

  return [...groups.values()].sort((a, b) => {
    const severityDelta = (OPS_SEVERITY_WEIGHT[b.maxSeverity] || 0) - (OPS_SEVERITY_WEIGHT[a.maxSeverity] || 0);
    if (severityDelta !== 0) return severityDelta;
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return b.latestSeenAtMs - a.latestSeenAtMs;
  });
}

export function buildOperationsDashboardModel(input = {}, options = {}) {
  const drivers = asRecord(input.drivers);
  const tours = asRecord(input.tours);
  const tourManifests = asRecord(input.tourManifests);
  const tourRows = buildTourRows({ drivers, tours, tourManifests }, options);
  const operationalTours = tourRows.filter((tour) => tour.isActive);
  const upcomingTours = operationalTours.filter((tour) => (
    tour.dateMeta.hasValidDate
    && tour.dateMeta.dayDelta >= 0
    && tour.dateMeta.dayDelta <= (options.window?.maxFutureDays ?? DEFAULT_WINDOW.maxFutureDays)
  ));
  const attentionWindowTours = operationalTours.filter((tour) => tour.dateMeta.inAttentionWindow);
  const unassignedUpcomingTours = attentionWindowTours
    .filter((tour) => !tour.isAssigned)
    .sort((a, b) => (a.dateMeta.startAtMs || Number.MAX_SAFE_INTEGER) - (b.dateMeta.startAtMs || Number.MAX_SAFE_INTEGER))
    .slice(0, options.unassignedLimit || 8);

  const knownCapacityTours = operationalTours.filter((tour) => tour.hasKnownCapacity);
  const totalPassengers = operationalTours.reduce((sum, tour) => sum + tour.passengerCount, 0);
  const totalKnownCapacity = knownCapacityTours.reduce((sum, tour) => sum + tour.capacity, 0);
  const highLoadTours = knownCapacityTours
    .filter((tour) => tour.loadPercent >= 85 || tour.passengerCount > tour.capacity)
    .sort((a, b) => (b.loadPercent || 0) - (a.loadPercent || 0))
    .slice(0, options.highLoadLimit || 6);

  const totalDrivers = Object.keys(drivers).length;
  const assignedDrivers = Object.values(drivers).filter(driverHasAssignment).length;
  const assignedUpcomingTours = upcomingTours.filter((tour) => tour.isAssigned).length;
  const allActiveAssignedTours = operationalTours.filter((tour) => tour.isAssigned).length;
  const safetyAlerts = buildSafetyAlerts({
    tours,
    globalSafetyAlerts: input.globalSafetyAlerts,
  });

  return {
    generatedAt: options.generatedAt || nowAsISOString(),
    metrics: {
      totalDrivers,
      assignedDrivers,
      availableDrivers: Math.max(totalDrivers - assignedDrivers, 0),
      totalTours: tourRows.length,
      operationalTours: operationalTours.length,
      upcomingTours: upcomingTours.length,
      assignedUpcomingTours,
      unassignedUpcomingTours: attentionWindowTours.filter((tour) => !tour.isAssigned).length,
      missingDateOperationalTours: operationalTours.filter((tour) => !tour.dateMeta.hasValidDate).length,
      upcomingAssignmentCoveragePercent: upcomingTours.length
        ? Math.round((assignedUpcomingTours / upcomingTours.length) * 100)
        : null,
      activeAssignmentCoveragePercent: operationalTours.length
        ? Math.round((allActiveAssignedTours / operationalTours.length) * 100)
        : null,
      totalPassengers,
      totalKnownCapacity,
      passengerLoadPercent: totalKnownCapacity
        ? Math.round((totalPassengers / totalKnownCapacity) * 100)
        : null,
      unknownCapacityTours: operationalTours.length - knownCapacityTours.length,
      highLoadTours: highLoadTours.length,
      safetyAttentionAlerts: safetyAlerts.filter((alert) => alert.requiresAttention).length,
    },
    tourRows,
    unassignedUpcomingTours,
    highLoadTours,
    safetyAlerts,
    broadcastActivity: buildBroadcastActivity(input.broadcasts, options.broadcasts),
    componentAlertSummary: buildComponentAlertSummary(input.opsAlerts),
  };
}
