import { nowAsISOString } from '../utils/dateUtils';
import {
  calculateDayDelta,
  getUrgencyBadge,
  isWithinTriageWindow,
} from '../utils/triageUtils';
import {
  DEFAULT_WINDOW,
  SAFETY_ATTENTION_STATUSES,
  SAFETY_SEVERITY_WEIGHT,
  asRecord,
  cleanString,
  toFiniteNumber,
} from './dashboardModelPolicy';
import {
  buildComponentAlertSummary,
  getTourDateMeta,
  normalizeSafetySeverity,
  normalizeSafetyStatus,
  sanitizeDashboardText,
} from './dashboardService';

const getProjectedTourDateMeta = (row, nowDate, windowOptions) => {
  const startAtMs = row?.startAtMs === null || row?.startAtMs === undefined
    ? null : toFiniteNumber(row.startAtMs);
  if (startAtMs === null) return getTourDateMeta(row?.startDate, nowDate, windowOptions);
  const parsedDate = new Date(startAtMs);
  const dayDelta = calculateDayDelta(parsedDate, nowDate);
  return {
    hasValidDate: true,
    parsedDate,
    startAtMs,
    dayDelta,
    inAttentionWindow: isWithinTriageWindow(dayDelta, windowOptions),
    urgency: getUrgencyBadge(dayDelta),
  };
};

export function buildOperationsDashboardProjectionModel(input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date(options.nowMs || Date.now());
  const windowOptions = { ...DEFAULT_WINDOW, ...(options.window || {}) };
  const tourRows = Object.entries(asRecord(input.tours)).map(([id, row]) => ({
    id,
    name: sanitizeDashboardText(row?.displayName || row?.tourCode || id, id, 120, { redactLongIdentifiers: false }),
    tourCode: sanitizeDashboardText(row?.tourCode || id, id, 120, { redactLongIdentifiers: false }),
    startDate: row?.startDate || null,
    isActive: row?.isActive !== false,
    isAssigned: Boolean(row?.isAssigned),
    assignedDriverName: row?.assignedDriverDisplaySummary || null,
    manifestDriverCount: Number(row?.assignedDriverCount || 0),
    passengerCount: Number(row?.passengerCount || 0),
    passengerCountSource: row?.passengerCountSource || 'none',
    capacity: Number.isFinite(Number(row?.capacity)) && Number(row.capacity) > 0 ? Number(row.capacity) : null,
    loadPercent: row?.loadPercent !== null && row?.loadPercent !== undefined
      && Number.isFinite(Number(row.loadPercent)) ? Number(row.loadPercent) : null,
    hasKnownCapacity: row?.hasKnownCapacity === true,
    dateMeta: getProjectedTourDateMeta(row, nowDate, windowOptions),
  }));
  const operationalTours = tourRows.filter((tour) => tour.isActive);
  const upcomingTours = operationalTours.filter((tour) => (
    tour.dateMeta.hasValidDate && tour.dateMeta.dayDelta >= 0
    && tour.dateMeta.dayDelta <= windowOptions.maxFutureDays
  ));
  const attentionWindowTours = operationalTours.filter((tour) => tour.dateMeta.inAttentionWindow);
  const unassignedUpcomingTours = attentionWindowTours
    .filter((tour) => !tour.isAssigned)
    .sort((left, right) => (left.dateMeta.startAtMs || Number.MAX_SAFE_INTEGER) - (right.dateMeta.startAtMs || Number.MAX_SAFE_INTEGER))
    .slice(0, options.unassignedLimit || 8);
  const highLoadTours = operationalTours
    .filter((tour) => tour.hasKnownCapacity && (tour.loadPercent >= 85 || tour.passengerCount > tour.capacity))
    .sort((left, right) => (right.loadPercent || 0) - (left.loadPercent || 0))
    .slice(0, options.highLoadLimit || 6);
  const safetyAlerts = Object.entries(asRecord(input.safetyAttention)).map(([id, row]) => ({
    id: `projection:${id}`,
    eventId: row?.eventId || id,
    paths: [`tours/${row?.tourId}/safetyAlerts/${row?.eventId || id}`],
    source: 'projection',
    tourId: cleanString(row?.tourId),
    category: sanitizeDashboardText(row?.category || 'safety', 'safety', 60, { redactLongIdentifiers: false }),
    severity: normalizeSafetySeverity(row?.severity),
    status: normalizeSafetyStatus(row?.status),
    role: row?.role ? sanitizeDashboardText(row.role, 'unknown', 40, { redactLongIdentifiers: false }) : null,
    message: sanitizeDashboardText(row?.safeSummary, 'Safety event', 180),
    isSOS: Boolean(row?.isSOS),
    timestamp: row?.eventTimestampMs || null,
    timestampMs: Number(row?.eventTimestampMs || 0),
    requiresAttention: SAFETY_ATTENTION_STATUSES.has(normalizeSafetyStatus(row?.status)),
  })).sort((left, right) => (
    (SAFETY_SEVERITY_WEIGHT[right.severity] || 0) - (SAFETY_SEVERITY_WEIGHT[left.severity] || 0)
    || right.timestampMs - left.timestampMs
  ));
  const recentBroadcasts = Object.entries(asRecord(input.recentBroadcasts)).map(([id, row]) => ({
    id,
    tourId: sanitizeDashboardText(row?.tourId || '', '', 120, { redactLongIdentifiers: false }),
    message: sanitizeDashboardText(row?.safeSummary, 'Broadcast message', 180),
    source: sanitizeDashboardText(row?.source || 'unknown', 'unknown', 40, { redactLongIdentifiers: false }),
    deliveryStatus: sanitizeDashboardText(row?.deliveryStatus || 'queued', 'queued', 40, { redactLongIdentifiers: false }),
    recipientCount: row?.recipientCount !== null && row?.recipientCount !== undefined
      && Number.isFinite(Number(row.recipientCount)) ? Number(row.recipientCount) : null,
    timestampMs: Number(row?.createdAtMs || 0),
  })).sort((left, right) => right.timestampMs - left.timestampMs);
  const summary = asRecord(input.summary);
  const localKnownCapacity = operationalTours.filter((tour) => tour.hasKnownCapacity);
  const localTotalPassengers = operationalTours.reduce((total, tour) => total + tour.passengerCount, 0);
  const localTotalCapacity = localKnownCapacity.reduce((total, tour) => total + tour.capacity, 0);
  const metric = (key, fallback) => summary[key] !== null && summary[key] !== undefined
    && Number.isFinite(Number(summary[key])) ? Number(summary[key]) : fallback;
  const totalDrivers = metric('totalDrivers', 0);
  const assignedDrivers = metric('assignedDrivers', 0);
  const broadcastNowMs = options.broadcasts?.nowMs || options.nowMs || Date.now();
  const last24hCount = recentBroadcasts.filter((item) => (
    item.timestampMs > 0 && broadcastNowMs - item.timestampMs <= 24 * 60 * 60 * 1000
  )).length;
  return {
    generatedAt: options.generatedAt || nowAsISOString(),
    metrics: {
      totalDrivers,
      assignedDrivers,
      availableDrivers: metric('availableDrivers', Math.max(totalDrivers - assignedDrivers, 0)),
      totalTours: metric('totalTours', tourRows.length),
      operationalTours: metric('operationalTours', operationalTours.length),
      upcomingTours: metric('upcomingTours', upcomingTours.length),
      assignedUpcomingTours: metric('assignedUpcomingTours', upcomingTours.filter((tour) => tour.isAssigned).length),
      unassignedUpcomingTours: metric('unassignedUpcomingTours', attentionWindowTours.filter((tour) => !tour.isAssigned).length),
      missingDateOperationalTours: metric('missingDateOperationalTours', operationalTours.filter((tour) => !tour.dateMeta.hasValidDate).length),
      upcomingAssignmentCoveragePercent: metric('upcomingAssignmentCoveragePercent', upcomingTours.length
        ? Math.round((upcomingTours.filter((tour) => tour.isAssigned).length / upcomingTours.length) * 100) : null),
      activeAssignmentCoveragePercent: metric('activeAssignmentCoveragePercent', metric('operationalTours', operationalTours.length)
        ? Math.round((metric('assignedOperationalTours', operationalTours.filter((tour) => tour.isAssigned).length)
          / metric('operationalTours', operationalTours.length)) * 100) : null),
      totalPassengers: metric('totalPassengers', localTotalPassengers),
      totalKnownCapacity: metric('totalKnownCapacity', localTotalCapacity),
      passengerLoadPercent: metric('passengerLoadPercent', localTotalCapacity
        ? Math.round((localTotalPassengers / localTotalCapacity) * 100) : null),
      unknownCapacityTours: metric('unknownCapacityTours', operationalTours.length - localKnownCapacity.length),
      highLoadTours: metric('highLoadTours', highLoadTours.length),
      safetyAttentionAlerts: metric('safetyAttentionAlerts', safetyAlerts.length),
    },
    tourRows,
    unassignedUpcomingTours,
    highLoadTours,
    safetyAlerts,
    broadcastActivity: {
      totalCount: metric('broadcastTotalCount', recentBroadcasts.length),
      last24hCount: metric('broadcastLast24hCount', last24hCount),
      tourCount: metric('broadcastTourCount', new Set(recentBroadcasts.map((item) => item.tourId)).size),
      lastBroadcastAtMs: metric('lastBroadcastAtMs', recentBroadcasts[0]?.timestampMs || null),
      recent: recentBroadcasts.slice(0, options.broadcasts?.limit || 8),
    },
    componentAlertSummary: buildComponentAlertSummary(input.opsAlerts),
  };
}
