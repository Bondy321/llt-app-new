import { describe, expect, it } from 'vitest';
import { getTourPassengerSummary, normalizePassengerCount, resolveTourPassengerCount } from './tourPassengerCounts';

describe('tour passenger count authority', () => {
  it('shows source sold places when nobody has joined the app', () => {
    const tour = { sold: 32, bookedPassengerCount: 30, manifestPassengerCount: 30, currentParticipants: 0, maxParticipants: 53 };
    expect(resolveTourPassengerCount(tour)).toEqual({ count: 32, source: 'tour.sold' });
    expect(getTourPassengerSummary(tour)).toMatchObject({ text: '32 / 53 booked places', reportMismatch: true, reportCount: 30 });
  });
  it('keeps zero authoritative instead of reviving legacy participants', () => {
    expect(resolveTourPassengerCount({ sold: 0, currentParticipants: 40 })).toEqual({ count: 0, source: 'tour.sold' });
    expect(resolveTourPassengerCount({ bookedPassengerCount: 0, currentParticipants: 40 })).toEqual({ count: 0, source: 'tour.bookedPassengerCount' });
  });
  it('preserves report, actual manifest and legacy fallback precedence', () => {
    expect(resolveTourPassengerCount({ manifestPassengerCount: 7, currentParticipants: 0 }).count).toBe(7);
    expect(resolveTourPassengerCount({ currentParticipants: 0 }, { manifestPassengerCount: 9 })).toEqual({ count: 9, source: 'tour_manifests.bookings' });
    expect(resolveTourPassengerCount({ currentParticipants: 4 })).toEqual({ count: 4, source: 'tour.currentParticipants' });
    expect(resolveTourPassengerCount({ participants: { a: true, b: true } })).toEqual({ count: 2, source: 'tours.participants' });
    expect(getTourPassengerSummary({})).toMatchObject({ known: false, text: 'Passenger count unavailable', loadPercent: null });
  });
  it('accepts safe integer counts and rejects coercible non-counts', () => {
    expect(normalizePassengerCount('12')).toBe(12);
    for (const value of [null, undefined, '', ' ', ' 12 ', true, false, 1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3.5', 'x']) {
      expect(normalizePassengerCount(value)).toBeNull();
      expect(resolveTourPassengerCount({ sold: value, manifestPassengerCount: 8 }).count).toBe(8);
    }
  });
});
