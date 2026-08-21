'use strict';

const { canonicalJson } = require('./driverTourPackSchema');

const DRIVER_TOUR_PACK_CHANGE_SECTIONS = Object.freeze([
  'status',
  'tour',
  'pickups',
  'passengers',
  'seats',
  'timeline',
  'hotels',
  'services',
  'coach',
  'contacts',
  'itineraries',
  'coverage',
  'quality',
]);

const DRIVER_TOUR_PACK_ISSUE_CATEGORIES = Object.freeze([
  'delay',
  'vehicle',
  'pickup',
  'passenger',
  'hotel',
  'supplier',
  'accessibility',
  'other',
]);
const DRIVER_TOUR_PACK_ISSUE_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
const DRIVER_TOUR_PACK_ISSUE_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const values = (value) => Object.values(isObject(value) ? value : {});
const safeInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;

function changedSectionNames(beforePack, afterPack) {
  if (!isObject(afterPack)) return [];
  return DRIVER_TOUR_PACK_CHANGE_SECTIONS.filter((section) => (
    canonicalJson(beforePack?.[section] ?? null) !== canonicalJson(afterPack?.[section] ?? null)
  ));
}

function selectedTimingFacts(pack) {
  if (!isObject(pack)) return null;
  const compactRecord = (record, fields) => Object.fromEntries(
    Object.entries(isObject(record) ? record : {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]))]),
  );
  return {
    status: pack.status ?? null,
    tour: {
      endDateISO: pack.tour?.endDateISO ?? null,
      days: pack.tour?.days ?? null,
    },
    pickups: compactRecord(pack.pickups, ['dateISO', 'time', 'name', 'address', 'sequence']),
    timeline: compactRecord(pack.timeline, ['type', 'dateISO', 'time', 'sequence']),
    hotels: compactRecord(pack.hotels, ['arrivalDateISO', 'nights']),
    services: compactRecord(pack.services, ['dateISO', 'time']),
  };
}

function summarizeDriverTourPackChange(beforePack, afterPack, {
  eventId = '',
  createdAtMs = Date.now(),
} = {}) {
  if (!isObject(afterPack) || afterPack.status === 'expired') return null;
  const changedSections = changedSectionNames(beforePack, afterPack);
  if (!changedSections.length) return null;
  const critical = !beforePack
    ? false
    : canonicalJson(selectedTimingFacts(beforePack)) !== canonicalJson(selectedTimingFacts(afterPack));
  return {
    schemaVersion: 1,
    changeId: `revision_${afterPack.revision}`,
    eventId: String(eventId || `revision_${afterPack.revision}`).slice(0, 160),
    departureKey: afterPack.departureKey,
    tourId: afterPack.tourId,
    revision: afterPack.revision,
    previousRevision: Number.isSafeInteger(beforePack?.revision) ? beforePack.revision : 0,
    changedSections,
    critical,
    requiresAcknowledgement: critical,
    createdAtMs,
  };
}

function normalizeIssue(issueId, raw, { departureKey, tourId, driverId } = {}) {
  if (!isObject(raw)) return null;
  const category = DRIVER_TOUR_PACK_ISSUE_CATEGORIES.includes(raw.category) ? raw.category : null;
  const severity = DRIVER_TOUR_PACK_ISSUE_SEVERITIES.includes(raw.severity) ? raw.severity : null;
  const status = DRIVER_TOUR_PACK_ISSUE_STATUSES.includes(raw.status) ? raw.status : null;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 240) : '';
  if (!issueId || !category || !severity || !status || !summary || !departureKey || !tourId || !driverId) return null;
  return {
    schemaVersion: 1,
    issueId,
    departureKey,
    tourId,
    driverId,
    category,
    severity,
    status,
    revision: safeInteger(raw.revision, 1),
    createdAtMs: safeInteger(raw.createdAtMs),
    updatedAtMs: safeInteger(raw.statusUpdatedAtMs ?? raw.updatedAtMs ?? raw.createdAtMs),
    ...(raw.statusUpdatedBy === 'operations' ? { statusUpdatedBy: 'operations' } : {}),
  };
}

function countStates(record, allowedStates) {
  const counts = { total: 0 };
  allowedStates.forEach((state) => { counts[state.toLowerCase()] = 0; });
  values(record).forEach((item) => {
    const state = allowedStates.includes(item?.state) ? item.state : allowedStates[0];
    counts.total += 1;
    counts[state.toLowerCase()] += 1;
  });
  return counts;
}

function buildDriverTourPackProgress({ departureKey, driverId, pack, actions, updatedAtMs = Date.now() } = {}) {
  if (!isObject(pack) || !departureKey || !driverId) return null;
  const pickupStates = countStates(actions?.pickupStops, ['PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED']);
  const serviceStates = countStates(actions?.serviceCompletion, ['PENDING', 'COMPLETED', 'SKIPPED']);
  const hotelStates = countStates(actions?.hotelCompletion, ['PENDING', 'COMPLETED', 'SKIPPED']);
  const issues = values(actions?.issues).filter(isObject);
  const latestIssueUpdate = issues.reduce((latest, issue) => Math.max(
    latest,
    safeInteger(issue?.statusUpdatedAtMs ?? issue?.updatedAtMs ?? issue?.createdAtMs),
  ), 0);
  return {
    schemaVersion: 1,
    departureKey,
    tourId: pack.tourId,
    driverId,
    packRevision: safeInteger(pack.revision, 1),
    revisionAcknowledged: safeInteger(actions?.revisionAcknowledged),
    acknowledgementCurrent: safeInteger(actions?.revisionAcknowledged) >= safeInteger(pack.revision, 1),
    pickupTotal: Object.keys(pack.pickups || {}).length,
    pickupArrived: pickupStates.arrived,
    pickupCompleted: pickupStates.completed,
    pickupSkipped: pickupStates.skipped,
    serviceTotal: Object.keys(pack.services || {}).length,
    serviceCompleted: serviceStates.completed,
    serviceSkipped: serviceStates.skipped,
    hotelTotal: Object.keys(pack.hotels || {}).length,
    hotelCompleted: hotelStates.completed,
    hotelSkipped: hotelStates.skipped,
    openIssueCount: issues.filter((issue) => issue.status !== 'resolved').length,
    criticalIssueCount: issues.filter((issue) => issue.status !== 'resolved' && issue.severity === 'critical').length,
    updatedAtMs: Math.max(safeInteger(actions?.updatedAtMs), latestIssueUpdate, safeInteger(updatedAtMs)),
  };
}

function buildDriverTourPackActionProjectionUpdates({
  departureKey,
  driverId,
  pack,
  beforeActions,
  afterActions,
  updatedAtMs = Date.now(),
} = {}) {
  const updates = {};
  const progressPath = `driver_tour_pack_progress/${departureKey}/${driverId}`;
  if (!isObject(afterActions) || !isObject(pack)) {
    updates[progressPath] = null;
  } else {
    updates[progressPath] = buildDriverTourPackProgress({ departureKey, driverId, pack, actions: afterActions, updatedAtMs });
  }
  const beforeIssues = isObject(beforeActions?.issues) ? beforeActions.issues : {};
  const afterIssues = isObject(afterActions?.issues) ? afterActions.issues : {};
  const issueIds = new Set([...Object.keys(beforeIssues), ...Object.keys(afterIssues)]);
  issueIds.forEach((issueId) => {
    updates[`driver_tour_pack_issues/${issueId}`] = normalizeIssue(issueId, afterIssues[issueId], {
      departureKey,
      tourId: pack?.tourId,
      driverId,
    });
  });
  return updates;
}

module.exports = {
  DRIVER_TOUR_PACK_CHANGE_SECTIONS,
  DRIVER_TOUR_PACK_ISSUE_CATEGORIES,
  DRIVER_TOUR_PACK_ISSUE_SEVERITIES,
  DRIVER_TOUR_PACK_ISSUE_STATUSES,
  buildDriverTourPackActionProjectionUpdates,
  buildDriverTourPackProgress,
  changedSectionNames,
  normalizeIssue,
  selectedTimingFacts,
  summarizeDriverTourPackChange,
};
