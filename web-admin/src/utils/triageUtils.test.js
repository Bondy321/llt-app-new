import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculateDayDelta,
  getTriageMeta,
  getUrgencyBadge,
  isWithinTriageWindow,
  parseTriageDate,
} from './triageUtils.js';

const freezeSystemTime = (isoTimestamp) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoTimestamp));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('triageUtils', () => {
  it('yesterday/today/tomorrow transitions and labels are correct', () => {
    freezeSystemTime('2026-02-10T09:00:00.000Z');

    const yesterday = getTriageMeta('09/02/2026');
    const today = getTriageMeta('10/02/2026');
    const tomorrow = getTriageMeta('11/02/2026');

    expect(yesterday?.dayDelta).toBe(-1);
    expect(yesterday?.label).toBe('1d overdue');

    expect(today?.dayDelta).toBe(0);
    expect(today?.label).toBe('Today');

    expect(tomorrow?.dayDelta).toBe(1);
    expect(tomorrow?.label).toBe('In 1d');
  });

  it('overdue window cutoff excludes items older than 7 days by default', () => {
    freezeSystemTime('2026-02-10T09:00:00.000Z');

    const withinCutoff = getTriageMeta('03/02/2026');
    const outsideCutoff = getTriageMeta('02/02/2026');

    expect(withinCutoff?.dayDelta).toBe(-7);
    expect(withinCutoff?.label).toBe('7d overdue');
    expect(outsideCutoff).toBeNull();
  });

  it('7-day upper-bound includes day 7 and excludes day 8', () => {
    freezeSystemTime('2026-02-10T09:00:00.000Z');

    const included = getTriageMeta('17/02/2026');
    const excluded = getTriageMeta('18/02/2026');

    expect(included?.dayDelta).toBe(7);
    expect(included?.label).toBe('In 7d');
    expect(excluded).toBeNull();
  });

  it('invalid date input returns parse failure and no triage metadata', () => {
    const parsedInvalid = parseTriageDate('31/02/2026');
    const parsedGarbage = parseTriageDate('not-a-date');

    expect(parsedInvalid.success).toBe(false);
    expect(parsedGarbage.success).toBe(false);
    expect(getTriageMeta('31/02/2026')).toBeNull();
  });

  it('supports UK and ISO input formats with matching labels', () => {
    freezeSystemTime('2026-02-10T09:00:00.000Z');

    const ukDate = getTriageMeta('12/02/2026');
    const isoDate = getTriageMeta('2026-02-12');

    expect(ukDate?.dayDelta).toBe(2);
    expect(isoDate?.dayDelta).toBe(2);
    expect(ukDate?.label).toBe('In 2d');
    expect(isoDate?.label).toBe('In 2d');
  });

  it('helper functions generate expected labels and cutoffs', () => {
    expect(getUrgencyBadge(0).label).toBe('Today');
    expect(getUrgencyBadge(3).label).toBe('In 3d');
    expect(getUrgencyBadge(-3).label).toBe('3d overdue');

    expect(isWithinTriageWindow(7)).toBe(true);
    expect(isWithinTriageWindow(8)).toBe(false);
    expect(isWithinTriageWindow(-7)).toBe(true);
    expect(isWithinTriageWindow(-8)).toBe(false);

    const now = new Date('2026-02-10T09:00:00.000Z');
    const target = new Date('2026-02-11T23:59:59.999Z');
    expect(calculateDayDelta(target, now)).toBe(1);
  });
});
