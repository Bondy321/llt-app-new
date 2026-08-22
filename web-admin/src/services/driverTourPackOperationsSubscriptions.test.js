import { beforeEach, describe, expect, it, vi } from 'vitest';

const onValueMock = vi.fn();

vi.mock('firebase/database', () => ({
  ref: (_database, path) => ({ path }),
  query: (reference, ...constraints) => ({ ...reference, constraints }),
  onValue: (...args) => onValueMock(...args),
  orderByChild: (path) => ({ type: 'orderByChild', path }),
  startAt: (value) => ({ type: 'startAt', value }),
  endAt: (value) => ({ type: 'endAt', value }),
  limitToFirst: (limit) => ({ type: 'limitToFirst', limit }),
  update: vi.fn(),
}));

import { subscribeToDriverTourPackOperations } from './driverTourPackOperationsService';

describe('bounded Driver Tour Pack operations subscriptions', () => {
  beforeEach(() => onValueMock.mockReset());

  it('queries deterministic priority keys per exact departure, surfaces truncation, and tears down all listeners', async () => {
    const unsubscribers = [];
    onValueMock.mockImplementation((reference, onData) => {
      const unsubscribe = vi.fn();
      unsubscribers.push(unsubscribe);
      if (typeof onData !== 'function') return unsubscribe;
      if (unsubscribers.filter((item) => item).length === 1) {
        onData({ val: () => ({}), size: 0 });
      } else {
        onData({ val: () => ({}), size: 100 });
      }
      return unsubscribe;
    });
    const onData = vi.fn();
    const stop = subscribeToDriverTourPackOperations({}, ['2026-09-10::TOUR_A'], onData, vi.fn());
    await Promise.resolve();

    const issueReference = onValueMock.mock.calls[1][0];
    expect(issueReference.constraints).toEqual([
      { type: 'orderByChild', path: 'departurePriorityKey' },
      { type: 'startAt', value: '2026-09-10::TOUR_A|' },
      { type: 'endAt', value: '2026-09-10::TOUR_A|\uf8ff' },
      { type: 'limitToFirst', limit: 100 },
    ]);
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ atLimit: true, issuesAtLimit: true }));
    stop();
    expect(unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
  });
});
