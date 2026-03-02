import { describe, expect, it } from 'vitest';
import {
  formatDateForDisplay,
  formatDateTimeForDisplay,
  formatLongDateForDisplay,
  formatTimeForDisplay,
  parseTimestampStrict,
  toEpochMsStrict,
} from './dateUtils';

describe('dateUtils timestamp parsing contract', () => {
  it('accepts epoch number and numeric epoch string', () => {
    const asNumber = parseTimestampStrict(1738400400000);
    const asString = parseTimestampStrict('1738400400000');

    expect(asNumber.success).toBe(true);
    expect(asString.success).toBe(true);
    expect(asNumber.date.getTime()).toBe(1738400400000);
    expect(asString.date.getTime()).toBe(1738400400000);
  });

  it('accepts ISO datetime with timezone and rejects UK date strings for timestamps', () => {
    const iso = parseTimestampStrict('2026-02-01T10:15:00.000Z');
    const ukDate = parseTimestampStrict('01/02/2026');

    expect(iso.success).toBe(true);
    expect(ukDate.success).toBe(false);
  });

  it('rejects invalid and locale-ambiguous timestamp values', () => {
    expect(parseTimestampStrict('02/01/2026 10:30').success).toBe(false);
    expect(parseTimestampStrict('not-a-date').success).toBe(false);
    expect(parseTimestampStrict('').success).toBe(false);
  });

  it('normalizes timezone offsets to a deterministic epoch value', () => {
    const utcMs = toEpochMsStrict('2026-03-29T00:30:00Z');
    const offsetMs = toEpochMsStrict('2026-03-29T01:30:00+01:00');

    expect(utcMs).toBe(offsetMs);
  });
});

describe('dateUtils display formatters', () => {
  it('uses strict path for date display fallbacks', () => {
    expect(formatDateForDisplay('2026-02-05')).toBe('05/02/2026');
    expect(formatDateForDisplay('05/02/2026')).toBe('05/02/2026');
    expect(formatDateForDisplay('02-05-2026', 'Unknown')).toBe('Unknown');
  });

  it('formats time/date-time using strict timestamp parsing', () => {
    expect(formatTimeForDisplay('2026-02-01T10:15:00Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatDateTimeForDisplay('2026-02-01T10:15:00Z')).toContain('2026');
    expect(formatLongDateForDisplay('2026-02-01T10:15:00Z')).toContain('2026');
    expect(formatTimeForDisplay('01/02/2026', 'Unknown')).toBe('Unknown');
  });
});
