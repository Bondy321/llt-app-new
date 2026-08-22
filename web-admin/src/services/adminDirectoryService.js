import {
  endAt,
  get,
  limitToFirst,
  limitToLast,
  onValue,
  orderByChild,
  orderByKey,
  query,
  ref,
  startAt,
} from 'firebase/database';

export const TOUR_WINDOW_LIMIT = 500;
export const DRIVER_DIRECTORY_LIMIT = 500;
export const DRIVER_DIRECTORY_PAGE_SIZE = 100;

const sharedDriverDirectories = new WeakMap();

const clampLimit = (value, maximum) => (
  Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : maximum
);

const utcStartOfLocalDay = (nowMs) => {
  const date = new Date(nowMs);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
};

export function getTourWindowQueryPlan({ dateScope = 'current', nowMs = Date.now(), limit = TOUR_WINDOW_LIMIT } = {}) {
  const boundedLimit = clampLimit(limit, TOUR_WINDOW_LIMIT);
  const todayMs = utcStartOfLocalDay(nowMs);

  if (dateScope === 'past') {
    return { orderByChild: 'endDateEpochMs', endAt: todayMs - 1, limitToLast: boundedLimit };
  }
  if (dateScope === 'all') {
    return { orderByChild: 'endDateEpochMs', limitToLast: boundedLimit };
  }
  return { orderByChild: 'endDateEpochMs', startAt: todayMs, limitToFirst: boundedLimit };
}

export function buildTourWindowQuery(database, options = {}) {
  const plan = getTourWindowQueryPlan(options);
  const constraints = [orderByChild(plan.orderByChild)];
  if (Number.isSafeInteger(plan.startAt)) constraints.push(startAt(plan.startAt));
  if (Number.isSafeInteger(plan.endAt)) constraints.push(endAt(plan.endAt));
  if (Number.isSafeInteger(plan.limitToFirst)) constraints.push(limitToFirst(plan.limitToFirst));
  if (Number.isSafeInteger(plan.limitToLast)) constraints.push(limitToLast(plan.limitToLast));
  return query(ref(database, 'tours'), ...constraints);
}

export function subscribeToTourWindow(database, options, onData, onError) {
  const plan = getTourWindowQueryPlan(options);
  const limit = plan.limitToFirst || plan.limitToLast;
  return onValue(buildTourWindowQuery(database, options), (snapshot) => {
    const tours = snapshot.val() || {};
    const count = Number.isSafeInteger(snapshot.size) ? snapshot.size : Object.keys(tours).length;
    onData({ tours, atLimit: count >= limit, limit, dateScope: options?.dateScope || 'current' });
  }, onError);
}

export async function fetchTourByExactId(database, candidate) {
  if (typeof candidate !== 'string') return null;
  const tourId = candidate.trim().toUpperCase().replace(/\s+/g, '_');
  if (!tourId || tourId.length > 100 || /[.#$/[\]]/.test(tourId)) return null;
  const snapshot = await get(ref(database, `tours/${tourId}`));
  if (!snapshot?.exists?.()) return null;
  return { tourId, tour: snapshot.val() || {} };
}

export async function fetchDriverDirectoryPage(database, { afterKey = null, limit = DRIVER_DIRECTORY_PAGE_SIZE } = {}) {
  const boundedLimit = Math.min(clampLimit(limit, DRIVER_DIRECTORY_PAGE_SIZE), DRIVER_DIRECTORY_LIMIT - 1);
  const constraints = [orderByKey()];
  if (typeof afterKey === 'string' && afterKey) constraints.push(startAt(afterKey));
  // startAt is inclusive, so later pages need one slot for the cursor itself
  // and one extra unseen row to determine whether another page exists.
  constraints.push(limitToFirst(boundedLimit + (afterKey ? 2 : 1)));
  const snapshot = await get(query(ref(database, 'drivers'), ...constraints));
  let entries = Object.entries(snapshot.val() || {}).sort(([left], [right]) => left.localeCompare(right));
  if (afterKey && entries[0]?.[0] === afterKey) entries = entries.slice(1);
  const hasMore = entries.length > boundedLimit;
  const pageEntries = entries.slice(0, boundedLimit);
  return {
    drivers: Object.fromEntries(pageEntries),
    hasMore,
    nextCursor: pageEntries.at(-1)?.[0] || null,
    limit: boundedLimit,
  };
}

export async function fetchDriverByExactId(database, candidate) {
  if (typeof candidate !== 'string') return null;
  const driverId = candidate.trim().toUpperCase();
  if (!/^D-[A-Z0-9_-]{1,77}$/.test(driverId)) return null;
  const snapshot = await get(ref(database, `drivers/${driverId}`));
  return snapshot?.exists?.() ? { driverId, driver: snapshot.val() || {} } : null;
}

function startSharedDriverDirectory(database, limit) {
  const entry = {
    listeners: new Set(),
    errorListeners: new Set(),
    snapshot: null,
    error: null,
    unsubscribe: null,
  };
  const directoryQuery = query(ref(database, 'drivers'), orderByKey(), limitToFirst(limit));
  entry.unsubscribe = onValue(directoryQuery, (snapshot) => {
    const drivers = snapshot.val() || {};
    const count = Number.isSafeInteger(snapshot.size) ? snapshot.size : Object.keys(drivers).length;
    entry.snapshot = { drivers, atLimit: count >= limit, limit };
    entry.error = null;
    entry.listeners.forEach((listener) => listener(entry.snapshot));
  }, (error) => {
    entry.error = error;
    entry.errorListeners.forEach((listener) => listener(error));
  });
  sharedDriverDirectories.set(database, entry);
  return entry;
}

export function subscribeToDriverDirectory(database, onData, onError, requestedLimit = DRIVER_DIRECTORY_LIMIT) {
  const limit = clampLimit(requestedLimit, DRIVER_DIRECTORY_LIMIT);
  let entry = sharedDriverDirectories.get(database);
  if (!entry) entry = startSharedDriverDirectory(database, limit);

  entry.listeners.add(onData);
  if (typeof onError === 'function') entry.errorListeners.add(onError);
  if (entry.snapshot) queueMicrotask(() => entry.listeners.has(onData) && onData(entry.snapshot));
  if (entry.error && typeof onError === 'function') queueMicrotask(() => entry.errorListeners.has(onError) && onError(entry.error));

  return () => {
    entry.listeners.delete(onData);
    if (typeof onError === 'function') entry.errorListeners.delete(onError);
    if (entry.listeners.size === 0) {
      entry.unsubscribe?.();
      sharedDriverDirectories.delete(database);
    }
  };
}

export function buildDriversByTour(drivers = {}) {
  const index = new Map();
  Object.entries(drivers && typeof drivers === 'object' ? drivers : {}).forEach(([driverId, driver]) => {
    const currentTourId = driver?.currentTourId;
    const tourId = typeof currentTourId === 'string' ? currentTourId.trim() : '';
    if (!tourId) return;
    const ids = index.get(tourId);
    if (ids) ids.push(driverId);
    else index.set(tourId, [driverId]);
  });
  return index;
}
