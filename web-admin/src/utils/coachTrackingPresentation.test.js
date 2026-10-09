import { describe, expect, it } from 'vitest';
import { buildCoachRows, filterCoachRows, presentCoachLocation, formatCoachTime } from './coachTrackingPresentation';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const live = age => ({ isSharing: true, mode: 'live', source: 'auto', latitude: 56, longitude: -4, timestamp: NOW - age, accuracy: 10 });
const row = (location, other = {}) => ({ T1: { schemaVersion: 1, tourId: 'T1', tourCode: 'CODE 1', name: 'Test tour', assignedDrivers: [{ driverId: 'D-1', name: 'Driver One' }], location, ...other } });

describe('coach position presentation', () => {
  it.each([[239999, 'live'], [240000, 'recent'], [599999, 'recent'], [600000, 'stale'], [1799999, 'stale'], [1800000, 'unavailable']])('ages a position at the exact %i ms boundary', (age, state) => {
    const result = presentCoachLocation(live(age), NOW);
    expect(result.state).toBe(state);
    expect(Boolean(result.position)).toBe(state !== 'unavailable');
  });
  it('accepts zero coordinates without inventing them for null or invalid data', () => {
    expect(presentCoachLocation({ ...live(0), latitude: 0, longitude: 0 }, NOW).position).toEqual({ latitude: 0, longitude: 0 });
    for (const latitude of [null, '', '56', false, NaN, Infinity, 91]) expect(presentCoachLocation({ ...live(0), latitude }, NOW).position).toBeNull();
  });
  it('hides withdrawn, expired and excessively future points', () => {
    for (const value of [{ ...live(0), isSharing: false }, live(1800000), live(-300001), { ...live(0), timestamp: null }]) expect(presentCoachLocation(value, NOW).position).toBeNull();
  });
  it('shows low accuracy as approximate, but age still wins for stale positions', () => {
    expect(presentCoachLocation({ ...live(0), accuracy: 850 }, NOW).state).toBe('low_accuracy');
    expect(presentCoachLocation({ ...live(0), accuracy: 50_001 }, NOW).state).toBe('low_accuracy');
    expect(presentCoachLocation({ ...live(600000), accuracy: 850 }, NOW).state).toBe('stale');
  });
  it('keeps a fixed pickup separate even after live expiry', () => {
    const pickup = { ...live(0), mode: 'pickup', source: 'manual', address: 'Harbour' };
    const result = presentCoachLocation({ ...live(1800000), fallbackPickup: pickup }, NOW);
    expect(result.position).toBeNull(); expect(result.pickup.address).toBe('Harbour');
    expect(presentCoachLocation(pickup, NOW).state).toBe('unavailable');
    expect(presentCoachLocation({ ...live(-300001), fallbackPickup: pickup }, NOW).pickup.address).toBe('Harbour');
  });
  it('never labels an offline cached position Live and ages it while disconnected', () => {
    const result = buildCoachRows(row(live(0)), NOW, { connected: false });
    expect(result[0].state).toBe('recent'); expect(result[0].reason).toMatch(/cached/);
    expect(buildCoachRows(row(live(1800000)), NOW, { connected: false })[0].position).toBeNull();
  });
  it('rejects schema/identity mismatches, strips private properties and searches assigned drivers', () => {
    expect(buildCoachRows(row(live(0), { tourId: 'OTHER' }), NOW)).toEqual([]);
    expect(buildCoachRows(row(live(0), { deleted: true }), NOW)).toEqual([]);
    const result = buildCoachRows(row(live(0), { participants: 'secret', authUid: 'secret' }), NOW);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(filterCoachRows(result, { search: 'driver one' })).toHaveLength(1);
    expect(filterCoachRows(result, { status: 'attention' })).toHaveLength(0);
  });
  it('shows UK local time across daylight saving transitions', () => {
    expect(formatCoachTime(Date.parse('2026-10-09T12:00:00Z'))).toContain('13:00:00');
    expect(formatCoachTime(Date.parse('2026-11-09T12:00:00Z'))).toContain('12:00:00');
    expect(formatCoachTime(1e20)).toBe('Unavailable');
    expect(buildCoachRows(row(live(0), { startAtMs: 1e20 }), NOW)[0].startAtMs).toBeNull();
  });
});
