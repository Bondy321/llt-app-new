import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ subscriptions: [], off: [] }));
vi.mock('firebase/database', () => ({
  ref: (_db, path) => ({ path }), orderByChild: field => ({ field }), equalTo: value => ({ value }), limitToFirst: limit => ({ limit }),
  query: (base, ...constraints) => Object.assign({ ...base }, ...constraints),
  onValue: (target, callback, error) => { const off = vi.fn(); sdk.off.push(off); sdk.subscriptions.push({ target, callback, error }); return off; },
}));
import { subscribeCoachTracking, COACH_TRACKING_PATH, COACH_TRACKING_STATUS_PATH } from './coachTrackingService';
const snapshot = entries => ({ val: () => Object.fromEntries(entries), forEach: callback => entries.forEach(([key, value]) => callback({ key, val: () => value })) });
const rowsSubscription = () => sdk.subscriptions.filter(item => item.target.path === COACH_TRACKING_PATH).at(-1);
const handlers = () => ({ onRows: vi.fn(), onStatus: vi.fn(), onConnection: vi.fn(), onClock: vi.fn(), onError: vi.fn() });
beforeEach(() => { sdk.subscriptions.length = 0; sdk.off.length = 0; });

describe('complete bounded coach tracking subscription', () => {
  it('automatically covers more than 500 rows using bounded sentinel queries', async () => {
    const h = handlers(); const off = subscribeCoachTracking({}, h);
    const entries = Array.from({ length: 503 }, (_, index) => [`T${index}`, { tourId: `T${index}` }]);
    rowsSubscription().callback(snapshot(entries.slice(0, 251)));
    await Promise.resolve(); expect(rowsSubscription().target.limit).toBe(501);
    rowsSubscription().callback(snapshot(entries.slice(0, 501)));
    await Promise.resolve(); expect(rowsSubscription().target.limit).toBe(751);
    rowsSubscription().callback(snapshot(entries));
    expect(rowsSubscription().target).toMatchObject({ field: 'listed', value: true });
    expect(h.onRows.mock.lastCall[0].complete).toBe(true);
    expect(Object.keys(h.onRows.mock.lastCall[0].rows)).toHaveLength(503);
    expect(sdk.subscriptions.every(item => item.target.path !== 'tours' && item.target.path !== 'drivers')).toBe(true);
    off(); expect(sdk.off.every(unsubscribe => unsubscribe.mock.calls.length === 1)).toBe(true);
  });
  it('explicitly reports partial coverage at its safety limit', async () => {
    const h = handlers(); const off = subscribeCoachTracking({}, h, { batchSize: 2, maxRows: 4 });
    rowsSubscription().callback(snapshot([['A', {}], ['B', {}], ['C', {}]])); await Promise.resolve();
    rowsSubscription().callback(snapshot([['A', {}], ['B', {}], ['C', {}], ['D', {}], ['E', {}]]));
    expect(h.onRows.mock.lastCall[0]).toMatchObject({ complete: false, capped: true, limit: 4 }); off();
  });
  it('ignores delayed snapshots from superseded queries and after cleanup', async () => {
    const h = handlers(); const off = subscribeCoachTracking({}, h, { batchSize: 1, maxRows: 2 });
    const old = rowsSubscription(); old.callback(snapshot([['A', {}], ['B', {}]])); await Promise.resolve();
    old.callback(snapshot([['OLD', {}]])); expect(h.onRows).toHaveBeenCalledTimes(1);
    const current = rowsSubscription(); off(); current.callback(snapshot([['LATE', {}]]));
    expect(h.onRows).toHaveBeenCalledTimes(1);
  });
  it('propagates readiness/clock/connection and sanitized errors, and deletes absent rows', () => {
    const h = handlers(); const off = subscribeCoachTracking({}, h);
    sdk.subscriptions.find(item => item.target.path === COACH_TRACKING_STATUS_PATH).callback({ val: () => ({ state: 'ready' }) });
    sdk.subscriptions.find(item => item.target.path === '.info/connected').callback({ val: () => true });
    sdk.subscriptions.find(item => item.target.path === '.info/serverTimeOffset').callback({ val: () => 1500 });
    expect(h.onClock).toHaveBeenCalledWith(1500); expect(h.onConnection).toHaveBeenCalledWith(true);
    rowsSubscription().callback(snapshot([['A', {}]])); rowsSubscription().callback(snapshot([]));
    expect(h.onRows.mock.lastCall[0].rows).toEqual({});
    rowsSubscription().error({ code: 'PERMISSION_DENIED', message: 'secret token' });
    expect(h.onError.mock.lastCall[0]).not.toContain('secret'); off();
  });
});
