import { beforeEach, describe, expect, it, vi } from 'vitest';

const onValueMock = vi.fn();
const getMock = vi.fn();

vi.mock('firebase/database', () => ({
  ref: (_database, path) => ({ path }),
  query: (reference, ...constraints) => ({ ...reference, constraints }),
  onValue: (...args) => onValueMock(...args),
  get: (...args) => getMock(...args),
  orderByChild: (path) => ({ type: 'orderByChild', path }),
  orderByKey: () => ({ type: 'orderByKey' }),
  startAt: (value) => ({ type: 'startAt', value }),
  endAt: (value) => ({ type: 'endAt', value }),
  limitToFirst: (limit) => ({ type: 'limitToFirst', limit }),
  limitToLast: (limit) => ({ type: 'limitToLast', limit }),
}));

import {
  buildDriversByTour,
  fetchDriverByExactId,
  fetchDriverDirectoryPage,
  fetchTourByExactId,
  getTourWindowQueryPlan,
  subscribeToDriverDirectory,
  subscribeToTourWindow,
  TOUR_WINDOW_LIMIT,
} from './adminDirectoryService';

describe('admin directory subscriptions', () => {
  beforeEach(() => {
    onValueMock.mockReset();
    getMock.mockReset();
  });

  it('uses indexed, bounded date-window query plans', () => {
    const nowMs = new Date(2026, 7, 22, 12).getTime();
    const todayMs = Date.UTC(2026, 7, 22);
    expect(getTourWindowQueryPlan({ dateScope: 'current', nowMs })).toEqual({
      orderByChild: 'endDateEpochMs', startAt: todayMs, limitToFirst: TOUR_WINDOW_LIMIT,
    });
    expect(getTourWindowQueryPlan({ dateScope: 'past', nowMs, limit: 25 })).toEqual({
      orderByChild: 'endDateEpochMs', endAt: todayMs - 1, limitToLast: 25,
    });
    expect(getTourWindowQueryPlan({ dateScope: 'all', nowMs })).toEqual({
      orderByChild: 'endDateEpochMs', limitToLast: TOUR_WINDOW_LIMIT,
    });
  });

  it('reports a capped tour window instead of silently presenting it as complete', () => {
    onValueMock.mockImplementation((...args) => {
      expect(args).toHaveLength(3);
      expect(typeof args[1]).toBe('function');
      args[1]({ val: () => ({ A: {}, B: {} }), size: 2 });
      return vi.fn();
    });
    const onData = vi.fn();
    subscribeToTourWindow({}, { dateScope: 'all', limit: 2 }, onData, vi.fn());
    expect(onData).toHaveBeenCalledWith({ tours: { A: {}, B: {} }, atLimit: true, limit: 2, dateScope: 'all' });
    expect(onValueMock.mock.calls[0][0].constraints).toEqual([
      { type: 'orderByChild', path: 'endDateEpochMs' },
      { type: 'limitToLast', limit: 2 },
    ]);
  });

  it('shares one bounded Firebase driver listener across consumers and tears it down once', () => {
    const firebaseUnsubscribe = vi.fn();
    onValueMock.mockReturnValue(firebaseUnsubscribe);
    const database = {};
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToDriverDirectory(database, first, vi.fn());
    const unsubscribeSecond = subscribeToDriverDirectory(database, second, vi.fn());
    expect(onValueMock).toHaveBeenCalledTimes(1);
    expect(onValueMock.mock.calls[0][0].constraints).toEqual([
      { type: 'orderByKey' },
      { type: 'limitToFirst', limit: 500 },
    ]);
    unsubscribeFirst();
    expect(firebaseUnsubscribe).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(firebaseUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('indexes driver assignments with one pass', () => {
    expect(buildDriversByTour({
      'D-1': { currentTourId: 'TOUR_A' },
      'D-2': { currentTourId: 'TOUR_A' },
      'D-3': { currentTourId: 'TOUR_B' },
    })).toEqual(new Map([
      ['TOUR_A', ['D-1', 'D-2']],
      ['TOUR_B', ['D-3']],
    ]));
  });

  it('fetches an exact deep-linked tour on demand without broadening the live window', async () => {
    getMock.mockResolvedValue({ exists: () => true, val: () => ({ name: 'Deep linked' }) });
    await expect(fetchTourByExactId({}, ' 5001d 1 ')).resolves.toEqual({
      tourId: '5001D_1',
      tour: { name: 'Deep linked' },
    });
    expect(getMock).toHaveBeenCalledWith({ path: 'tours/5001D_1' });
    await expect(fetchTourByExactId({}, 'unsafe/path')).resolves.toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('pages beyond the live driver window and supports exact Driver ID management', async () => {
    getMock
      .mockResolvedValueOnce({ val: () => ({ 'D-0500': { name: 'Boundary' }, 'D-0501': { name: 'Next' }, 'D-0502': { name: 'More' } }) })
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ name: 'Exact' }) });
    await expect(fetchDriverDirectoryPage({}, { afterKey: 'D-0500', limit: 1 })).resolves.toEqual({
      drivers: { 'D-0501': { name: 'Next' } }, hasMore: true, nextCursor: 'D-0501', limit: 1,
    });
    expect(getMock.mock.calls[0][0].constraints).toEqual([
      { type: 'orderByKey' }, { type: 'startAt', value: 'D-0500' }, { type: 'limitToFirst', limit: 3 },
    ]);
    await expect(fetchDriverByExactId({}, ' d-9999 ')).resolves.toEqual({ driverId: 'D-9999', driver: { name: 'Exact' } });
  });
});
