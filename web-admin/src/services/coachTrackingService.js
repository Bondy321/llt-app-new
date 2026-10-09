import { equalTo, limitToFirst, onValue, orderByChild, query, ref } from 'firebase/database';

export const COACH_TRACKING_PATH = 'admin_dashboard/v1/coach_tracking';
export const COACH_TRACKING_STATUS_PATH = 'admin_dashboard/v1/coach_tracking_status';
export const TRACKING_BATCH_SIZE = 250;
export const TRACKING_ROW_LIMIT = 10_000;

// Each query is bounded, with one sentinel row. Expand automatically rather
// than applying the dashboard's 500-tour window to a complete fleet feed.
export function subscribeCoachTracking(database, handlers, { batchSize = TRACKING_BATCH_SIZE,
  maxRows = TRACKING_ROW_LIMIT } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(maxRows)
    || maxRows < batchSize || maxRows > TRACKING_ROW_LIMIT) throw Error('INVALID_TRACKING_BUDGET');
  let active = true;
  let generation = 0;
  let rowsOff;
  let limit = batchSize;
  const subscribeRows = () => {
    if (!active) return;
    rowsOff?.();
    const epoch = ++generation;
    rowsOff = onValue(query(ref(database, COACH_TRACKING_PATH), orderByChild('listed'), equalTo(true), limitToFirst(limit + 1)), snapshot => {
      if (!active || epoch !== generation) return;
      const entries = [];
      snapshot.forEach(child => { entries.push([child.key, child.val()]); });
      const hasMore = entries.length > limit;
      handlers.onRows({ rows: Object.fromEntries(entries.slice(0, limit)), complete: !hasMore,
        limit, capped: hasMore && limit === maxRows });
      if (hasMore && limit < maxRows) {
        limit = Math.min(maxRows, limit + batchSize);
        // Avoid a synchronous subscriber replacing its own unsubscribe handle.
        queueMicrotask(() => { if (active && epoch === generation) subscribeRows(); });
      }
    }, error => {
      if (active && epoch === generation) handlers.onError(error?.code === 'PERMISSION_DENIED'
        ? 'Tracking access was denied. Sign in again with an operations account.'
        : 'The tracking feed could not be loaded. Retry the connection.');
    });
  };
  const subscriptions = [
    onValue(ref(database, COACH_TRACKING_STATUS_PATH), snapshot => {
      if (active) handlers.onStatus(snapshot.val());
    }, () => { if (active) handlers.onError('Tracking readiness could not be checked. Retry the connection.'); }),
    onValue(ref(database, '.info/connected'), snapshot => { if (active) handlers.onConnection(snapshot.val() === true); }),
    onValue(ref(database, '.info/serverTimeOffset'), snapshot => {
      if (active) handlers.onClock(Number.isFinite(snapshot.val()) ? snapshot.val() : 0);
    }),
  ];
  subscribeRows();
  return () => { active = false; generation += 1; rowsOff?.(); subscriptions.forEach(off => off()); };
}
