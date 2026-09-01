'use strict';

// @ts-check

const { createHash } = require('node:crypto');

const DASHBOARD_SCHEMA_VERSION = 1;
const DASHBOARD_ROOT = 'admin_dashboard/v1';
const DASHBOARD_ROLLOUT_ROOT = 'admin_dashboard_rollout/v1';
const DASHBOARD_ROLLOUT_PHASES = new Set(['legacy', 'shadow', 'projection']);
const SAFETY_ATTENTION_STATUSES = new Set(['pending', 'acknowledged', 'in_progress', 'escalated']);
const SAFETY_SEVERITY_WEIGHT = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const MAX_ASSIGNED_DRIVERS = 20;
const BROADCAST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAFETY_CATEGORY_LABELS = Object.freeze({
  delay: 'Delay',
  incident: 'Incident',
  medical: 'Medical',
  lost_passenger: 'Passenger assistance',
  vehicle_issue: 'Vehicle issue',
  sos: 'SOS safety event',
  harassment: 'Harassment',
  weather: 'Weather',
  custom: 'Safety event',
});
const SAFETY_ROLES = new Set(['passenger', 'driver', 'operations', 'admin']);
const BROADCAST_SOURCES = new Set(['web_admin', 'server']);

const asRecord = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const cleanString = (value, fallback = '') => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
};

const toFiniteNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const countCollection = (value) => {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== '').length;
  return Object.keys(asRecord(value)).length;
};

const sanitizeDashboardText = (value, fallback = 'Unavailable', maxLength = 180) => {
  let text = String(value ?? fallback)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+44\s?\d(?:[\s-]?\d){8,10}|\b0\d(?:[\s-]?\d){8,10})\b/g, '[phone]')
    .replace(/ExponentPushToken\[[^\]]+\]/g, '[push-token]')
    .replace(/\b(?:session|diag)_\d+_[A-Za-z0-9_-]+\b/g, '[session]')
    .replace(/\b(auth(?:uid)?|authorization|booking(?:ref|reference|id)?|drivercode|password|push(?:token)?|session(?:id)?|token|uid|userid)\b\s*[:=]\s*['"]?[^,\s'"}\]]+/gi, (_match, label) => `${label}=[redacted]`)
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[identifier]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = fallback;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const stableObject = (value) => {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
};

const fingerprint = (value) => createHash('sha256')
  .update(JSON.stringify(stableObject(value)))
  .digest('hex')
  .slice(0, 32);

const countManifestBooking = (booking) => {
  if (!booking || typeof booking !== 'object') return 0;
  const passengerStatusCount = countCollection(booking.passengerStatus);
  if (passengerStatusCount > 0) return passengerStatusCount;
  const passengerNamesCount = countCollection(booking.passengerNames);
  return passengerNamesCount > 0 ? passengerNamesCount : 1;
};

const countManifestBookings = (manifest) => Object.values(asRecord(manifest?.bookings))
  .reduce((total, booking) => total + countManifestBooking(booking), 0);

const resolvePassengerCount = ({ tour = {}, participantCount = 0, manifestPassengerCount = 0 } = {}) => {
  const explicitCount = toFiniteNumber(tour.currentParticipants);
  if (explicitCount !== null && explicitCount >= 0) {
    return { passengerCount: explicitCount, passengerCountSource: 'tour.currentParticipants' };
  }
  if (participantCount > 0) {
    return { passengerCount: participantCount, passengerCountSource: 'tours.participants' };
  }
  if (manifestPassengerCount > 0) {
    return { passengerCount: manifestPassengerCount, passengerCountSource: 'tour_manifests.bookings' };
  }
  return { passengerCount: 0, passengerCountSource: 'none' };
};

const resolveAssignedDriverIds = (assignment = {}) => [...new Set([
  ...Object.entries(asRecord(assignment.assignedDrivers)).filter(([, value]) => Boolean(value)).map(([id]) => id),
  ...Object.keys(asRecord(assignment.assignedDriverCodes)),
])].sort().slice(0, MAX_ASSIGNED_DRIVERS);

const buildTourProjection = ({
  tourId,
  tour = {},
  participantCount = 0,
  manifestPassengerCount = 0,
  assignment = {},
  driverProfiles = {},
} = {}) => { // eslint-disable-line complexity -- centralises legacy fallback precedence
  if (!cleanString(tourId) || !tour || typeof tour !== 'object') return null;
  const assignedDriverIds = resolveAssignedDriverIds(assignment);
  const assignedDriverCount = assignedDriverIds.length;
  const tourDriverName = cleanString(tour.driverName);
  const driverNames = assignedDriverIds
    .map((driverId) => cleanString(driverProfiles?.[driverId]?.name, driverId))
    .filter(Boolean);
  const assignedDriverDisplaySummary = assignedDriverCount > 0 || (tourDriverName && tourDriverName.toUpperCase() !== 'TBA')
    ? sanitizeDashboardText(driverNames.join(', ') || tourDriverName || 'Assigned driver', 'Assigned driver', 120)
    : null;
  const passenger = resolvePassengerCount({ tour, participantCount, manifestPassengerCount });
  const capacityValue = toFiniteNumber(tour.maxParticipants);
  const capacity = capacityValue !== null && capacityValue > 0 ? capacityValue : null;
  const startAtMs = toFiniteNumber(tour.startDateEpochMs);
  const endAtMs = toFiniteNumber(tour.endDateEpochMs);
  const row = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    tourId,
    tourCode: sanitizeDashboardText(tour.tourCode || tourId, tourId, 120),
    displayName: sanitizeDashboardText(tour.name || tour.tourCode || tourId, tourId, 120),
    startDate: cleanString(tour.startDate) || null,
    startAtMs,
    endAtMs,
    isActive: tour.isActive !== false,
    ...passenger,
    capacity,
    loadPercent: capacity ? Math.round((passenger.passengerCount / capacity) * 100) : null,
    hasKnownCapacity: capacity !== null,
    assignedDriverCount,
    assignedDriverDisplaySummary,
    isAssigned: assignedDriverCount > 0 || Boolean(assignedDriverDisplaySummary),
  };
  return { ...row, sourceFingerprint: fingerprint(row) };
};

const normalizeSafetyStatus = (value) => cleanString(value, 'pending').toLowerCase();
const normalizeSafetySeverity = (value) => {
  const severity = cleanString(value, 'medium').toLowerCase();
  return SAFETY_SEVERITY_WEIGHT[severity] ? severity : 'medium';
};

const buildSafetyAttentionProjection = ({ eventId, tourId, alert = {} } = {}) => {
  const status = normalizeSafetyStatus(alert.status);
  if (!eventId || !tourId || !SAFETY_ATTENTION_STATUSES.has(status)) return null;
  const severity = normalizeSafetySeverity(alert.severity);
  const categoryKey = cleanString(alert.category).toLowerCase();
  const categoryLabel = SAFETY_CATEGORY_LABELS[categoryKey] || 'Safety event';
  const role = cleanString(alert.role).toLowerCase();
  const eventTimestampMs = toFiniteNumber(alert.timestampMs, toFiniteNumber(alert.receivedAtMs, 0));
  const statusUpdatedAtMs = toFiniteNumber(alert.statusUpdatedAtMs, eventTimestampMs);
  const row = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    eventId,
    tourId,
    category: Object.hasOwn(SAFETY_CATEGORY_LABELS, categoryKey) ? categoryKey : 'safety',
    severity,
    status,
    safeSummary: alert.isSOS ? 'SOS safety event' : categoryLabel,
    role: SAFETY_ROLES.has(role) ? role : null,
    isSOS: Boolean(alert.isSOS),
    eventTimestampMs,
    statusUpdatedAtMs,
    attentionSortKey: (SAFETY_SEVERITY_WEIGHT[severity] * 10 ** 15) + Math.max(0, eventTimestampMs || 0),
  };
  return { ...row, sourceFingerprint: fingerprint(row) };
};

const buildRecentBroadcastProjection = ({
  broadcastId,
  tourId,
  broadcast = {},
  nowMs = Date.now(),
  retentionMs = BROADCAST_RETENTION_MS,
} = {}) => {
  if (!broadcastId || !tourId || !broadcast || typeof broadcast !== 'object') return null;
  const createdAtMs = toFiniteNumber(broadcast.createdAtMs, 0);
  if (createdAtMs <= 0 || createdAtMs < nowMs - retentionMs) return null;
  const updatedAtMs = toFiniteNumber(broadcast.deliveryUpdatedAtMs, createdAtMs);
  const source = cleanString(broadcast.source).toLowerCase();
  const row = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    broadcastId,
    tourId,
    scopeType: 'tour',
    safeSummary: 'Tour broadcast',
    source: BROADCAST_SOURCES.has(source) ? source : 'unknown',
    deliveryStatus: sanitizeDashboardText(broadcast.deliveryStatus || 'queued', 'queued', 40),
    recipientCount: toFiniteNumber(broadcast.recipientCount),
    createdAtMs,
    updatedAtMs,
  };
  return { ...row, sourceFingerprint: fingerprint(row) };
};

const resolveDashboardRolloutPhase = (value) => (
  value?.schemaVersion === DASHBOARD_SCHEMA_VERSION
  && DASHBOARD_ROLLOUT_PHASES.has(value?.phase)
    ? value.phase
    : 'legacy'
);

const hasProhibitedProjectionField = (value) => {
  const prohibited = /^(passengerNames?|email|phone|booking(?:Ref|Reference|Id)?|authUid|userId|reporterAuthUid|coords|latitude|longitude|pushToken|token|participants|bookings|manifest)$/i;
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return Object.entries(candidate).some(([key, child]) => prohibited.test(key) || visit(child));
  };
  return visit(value);
};

const measureJsonBytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

module.exports = {
  BROADCAST_RETENTION_MS,
  DASHBOARD_ROLLOUT_PHASES,
  DASHBOARD_ROLLOUT_ROOT,
  DASHBOARD_ROOT,
  DASHBOARD_SCHEMA_VERSION,
  MAX_ASSIGNED_DRIVERS,
  SAFETY_ATTENTION_STATUSES,
  buildRecentBroadcastProjection,
  buildSafetyAttentionProjection,
  buildTourProjection,
  countManifestBooking,
  countManifestBookings,
  fingerprint,
  hasProhibitedProjectionField,
  measureJsonBytes,
  resolveDashboardRolloutPhase,
  resolvePassengerCount,
  sanitizeDashboardText,
};
