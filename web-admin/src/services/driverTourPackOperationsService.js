import { endAt, limitToFirst, onValue, orderByChild, query, ref, startAt, update } from 'firebase/database';
import { formatDateToISO, parseISODateStrict, parseUKDateStrict } from '../utils/dateUtils';

export const DRIVER_TOUR_PACK_OPERATIONS_LIMIT = 2_000;
export const DRIVER_TOUR_PACK_ISSUES_PER_DEPARTURE_LIMIT = 100;
export const DRIVER_TOUR_PACK_PROGRESS_ROOT = 'driver_tour_pack_progress';
export const DRIVER_TOUR_PACK_ISSUES_ROOT = 'driver_tour_pack_issues';

const ISSUE_STATUSES = new Set(['open', 'acknowledged', 'resolved']);
const ISSUE_TYPES = new Set(['delay', 'vehicle', 'pickup', 'passenger', 'hotel', 'supplier', 'accessibility', 'other']);
const ISSUE_SEVERITIES = new Set(['info', 'warning', 'critical']);
const DRIVER_ID = /^D-[A-Z0-9_-]{1,77}$/;

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function exactIdentity(value) {
  if (!value || typeof value.departureKey !== 'string' || typeof value.tourId !== 'string') return false;
  const separator = value.departureKey.indexOf('::');
  if (separator <= 0) return false;
  const dateISO = value.departureKey.slice(0, separator);
  return parseISODateStrict(dateISO).success && value.departureKey.slice(separator + 2) === value.tourId;
}

function tourDateISO(tour) {
  const uk = parseUKDateStrict(tour?.startDate);
  if (uk.success) return formatDateToISO(uk.date);
  const iso = parseISODateStrict(tour?.startDate);
  return iso.success ? formatDateToISO(iso.date) : null;
}

export function departureKeyForTour(tourId, tour) {
  const dateISO = tourDateISO(tour);
  return dateISO ? `${dateISO}::${tourId}` : null;
}

export function sanitizeDriverTourPackProgress(value, departureKey) {
  return Object.fromEntries(Object.entries(asRecord(value)).flatMap(([driverId, entry]) => {
    if (!DRIVER_ID.test(driverId) || entry?.driverId !== driverId || entry?.departureKey !== departureKey || !exactIdentity(entry) || !safeInteger(entry.updatedAtMs)) return [];
    return [[driverId, {
      departureKey: entry.departureKey, tourId: entry.tourId, driverId,
      packRevision: Number.isSafeInteger(entry.packRevision) && entry.packRevision >= 1 ? entry.packRevision : null,
      updatedAtMs: entry.updatedAtMs,
      revisionAcknowledged: safeInteger(entry.revisionAcknowledged) ? entry.revisionAcknowledged : 0,
      acknowledgementCurrent: entry.acknowledgementCurrent === true,
      pickupCompleted: Number.isSafeInteger(entry.pickupCompleted) && entry.pickupCompleted >= 0 ? entry.pickupCompleted : 0,
      pickupTotal: Number.isSafeInteger(entry.pickupTotal) && entry.pickupTotal >= 0 ? entry.pickupTotal : 0,
      serviceCompleted: Number.isSafeInteger(entry.serviceCompleted) && entry.serviceCompleted >= 0 ? entry.serviceCompleted : 0,
      serviceTotal: Number.isSafeInteger(entry.serviceTotal) && entry.serviceTotal >= 0 ? entry.serviceTotal : 0,
      hotelCompleted: Number.isSafeInteger(entry.hotelCompleted) && entry.hotelCompleted >= 0 ? entry.hotelCompleted : 0,
      hotelTotal: Number.isSafeInteger(entry.hotelTotal) && entry.hotelTotal >= 0 ? entry.hotelTotal : 0,
      openIssueCount: Number.isSafeInteger(entry.openIssueCount) && entry.openIssueCount >= 0 ? entry.openIssueCount : 0,
      criticalIssueCount: Number.isSafeInteger(entry.criticalIssueCount) && entry.criticalIssueCount >= 0 ? entry.criticalIssueCount : 0,
    }]];
  }));
}

export function sanitizeDriverTourPackIssues(value) {
  return Object.fromEntries(Object.entries(asRecord(value)).flatMap(([recordKey, issue]) => {
    const projectionId = typeof issue?.projectionId === 'string' ? issue.projectionId : null;
    const isLegacy = issue?.issueId === recordKey && !projectionId;
    if (!issue || (!isLegacy && projectionId !== recordKey) || typeof issue.issueId !== 'string' || !exactIdentity(issue) || !DRIVER_ID.test(issue.driverId || '') || !ISSUE_TYPES.has(issue.category) || !ISSUE_SEVERITIES.has(issue.severity) || !ISSUE_STATUSES.has(issue.status) || !safeInteger(issue.createdAtMs) || !safeInteger(issue.updatedAtMs)) return [];
    return [[recordKey, { projectionId, issueId: issue.issueId, departureKey: issue.departureKey, tourId: issue.tourId, driverId: issue.driverId, category: issue.category, severity: issue.severity, status: issue.status, revision: Number.isSafeInteger(issue.revision) ? issue.revision : null, createdAtMs: issue.createdAtMs, updatedAtMs: issue.updatedAtMs }]];
  }));
}

export function buildDriverTourPackOperationsByTour({ tours = {}, progress = {}, issues = {}, nowMs = Date.now() } = {}) {
  const safeProgress = asRecord(progress);
  const safeIssues = sanitizeDriverTourPackIssues(issues);
  const issuesByDeparture = new Map();
  Object.values(safeIssues).forEach((issue) => {
    const entries = issuesByDeparture.get(issue.departureKey);
    if (entries) entries.push(issue);
    else issuesByDeparture.set(issue.departureKey, [issue]);
  });
  return Object.fromEntries(Object.entries(asRecord(tours)).map(([tourId, tour]) => {
    const dateISO = tourDateISO(tour);
    const departureKey = dateISO ? `${dateISO}::${tourId}` : null;
    const progressEntries = departureKey
      ? Object.values(sanitizeDriverTourPackProgress(safeProgress[departureKey], departureKey))
      : [];
    const openIssues = (issuesByDeparture.get(departureKey) || []).filter((issue) => issue.status !== 'resolved');
    const newest = Math.max(0, ...progressEntries.map((entry) => entry.updatedAtMs || 0), ...openIssues.map((entry) => entry.updatedAtMs || 0));
    return [tourId, {
      state: !dateISO ? 'ambiguous' : (progressEntries.length || openIssues.length) ? (nowMs - newest > 24 * 60 * 60 * 1_000 ? 'stale' : 'ready') : 'missing',
      reason: !dateISO ? 'Tour start date is missing or invalid.' : null,
      departureKey, progress: progressEntries, issues: openIssues, updatedAtMs: newest || null,
    }];
  }));
}

export function subscribeToDriverTourPackOperations(database, departureKeys, onData, onError, limit = DRIVER_TOUR_PACK_OPERATIONS_LIMIT) {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= DRIVER_TOUR_PACK_OPERATIONS_LIMIT ? limit : DRIVER_TOUR_PACK_OPERATIONS_LIMIT;
  const keys = [...new Set((Array.isArray(departureKeys) ? departureKeys : []).filter((key) => typeof key === 'string' && key.length <= 180))].slice(0, boundedLimit);
  const state = { progress: {}, issues: {}, progressAtLimit: keys.length >= boundedLimit, issuesAtLimit: false, limit: boundedLimit };
  const issuesByDeparture = {};
  const issueLimitByDeparture = {};
  let emitQueued = false;
  let cancelled = false;
  const emit = () => {
    if (emitQueued || cancelled) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      if (!cancelled) onData({ ...state, atLimit: state.progressAtLimit || state.issuesAtLimit });
    });
  };
  const unsubscribers = [];

  keys.forEach((departureKey) => {
    unsubscribers.push(onValue(ref(database, `${DRIVER_TOUR_PACK_PROGRESS_ROOT}/${departureKey}`), (snapshot) => {
      state.progress[departureKey] = sanitizeDriverTourPackProgress(snapshot.val(), departureKey);
      emit();
    }, onError));

    const issueQuery = query(
      ref(database, DRIVER_TOUR_PACK_ISSUES_ROOT),
      orderByChild('departurePriorityKey'),
      startAt(`${departureKey}|`),
      endAt(`${departureKey}|\uf8ff`),
      limitToFirst(DRIVER_TOUR_PACK_ISSUES_PER_DEPARTURE_LIMIT),
    );
    unsubscribers.push(onValue(issueQuery, (snapshot) => {
      const departureIssues = sanitizeDriverTourPackIssues(snapshot.val());
      issuesByDeparture[departureKey] = departureIssues;
      state.issues = Object.assign({}, ...Object.values(issuesByDeparture));
      const count = Number.isSafeInteger(snapshot.size) ? snapshot.size : Object.keys(departureIssues).length;
      issueLimitByDeparture[departureKey] = count >= DRIVER_TOUR_PACK_ISSUES_PER_DEPARTURE_LIMIT;
      state.issuesAtLimit = Object.values(issueLimitByDeparture).some(Boolean);
      emit();
    }, onError));
  });

  if (keys.length === 0) emit();
  return () => {
    cancelled = true;
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

export async function updateDriverTourPackIssueStatus(database, { departureKey, driverId, issueId, status, nowMs = Date.now() } = {}, { updateFn = update, refFn = ref } = {}) {
  if (typeof departureKey !== 'string' || !departureKey || !DRIVER_ID.test(driverId || '') || typeof issueId !== 'string' || !issueId || !ISSUE_STATUSES.has(status) || !safeInteger(nowMs)) {
    throw new TypeError('Invalid Driver Tour Pack issue status update.');
  }
  const base = `driver_tour_pack_actions/${departureKey}/${driverId}/issues/${issueId}`;
  await updateFn(refFn(database, base), { status, updatedAtMs: nowMs, statusUpdatedAtMs: nowMs, statusUpdatedBy: 'operations' });
}
