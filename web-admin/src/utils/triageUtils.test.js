import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDayDelta,
  getTriageMeta,
  getUrgencyBadge,
  isWithinTriageWindow,
  parseTriageDate,
} from './triageUtils.js';

const freezeSystemTime = (isoTimestamp) => {
  const RealDate = Date;
  const fixed = new RealDate(isoTimestamp);

  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        return new RealDate(fixed);
      }
      return new RealDate(...args);
    }

    static now() {
      return fixed.getTime();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  }

  globalThis.Date = MockDate;
  return () => {
    globalThis.Date = RealDate;
  };
};

test('yesterday/today/tomorrow transitions and labels are correct', () => {
  const restoreTime = freezeSystemTime('2026-02-10T09:00:00.000Z');

  try {
    const yesterday = getTriageMeta('09/02/2026');
    const today = getTriageMeta('10/02/2026');
    const tomorrow = getTriageMeta('11/02/2026');

    assert.equal(yesterday?.dayDelta, -1);
    assert.equal(yesterday?.label, '1d overdue');

    assert.equal(today?.dayDelta, 0);
    assert.equal(today?.label, 'Today');

    assert.equal(tomorrow?.dayDelta, 1);
    assert.equal(tomorrow?.label, 'In 1d');
  } finally {
    restoreTime();
  }
});

test('overdue window cutoff excludes items older than 7 days by default', () => {
  const restoreTime = freezeSystemTime('2026-02-10T09:00:00.000Z');

  try {
    const withinCutoff = getTriageMeta('03/02/2026');
    const outsideCutoff = getTriageMeta('02/02/2026');

    assert.equal(withinCutoff?.dayDelta, -7);
    assert.equal(withinCutoff?.label, '7d overdue');
    assert.equal(outsideCutoff, null);
  } finally {
    restoreTime();
  }
});

test('7-day upper-bound includes day 7 and excludes day 8', () => {
  const restoreTime = freezeSystemTime('2026-02-10T09:00:00.000Z');

  try {
    const included = getTriageMeta('17/02/2026');
    const excluded = getTriageMeta('18/02/2026');

    assert.equal(included?.dayDelta, 7);
    assert.equal(included?.label, 'In 7d');
    assert.equal(excluded, null);
  } finally {
    restoreTime();
  }
});

test('invalid date input returns parse failure and no triage metadata', () => {
  const parsedInvalid = parseTriageDate('31/02/2026');
  const parsedGarbage = parseTriageDate('not-a-date');

  assert.equal(parsedInvalid.success, false);
  assert.equal(parsedGarbage.success, false);
  assert.equal(getTriageMeta('31/02/2026'), null);
});

test('supports UK and ISO input formats with matching labels', () => {
  const restoreTime = freezeSystemTime('2026-02-10T09:00:00.000Z');

  try {
    const ukDate = getTriageMeta('12/02/2026');
    const isoDate = getTriageMeta('2026-02-12');

    assert.equal(ukDate?.dayDelta, 2);
    assert.equal(isoDate?.dayDelta, 2);
    assert.equal(ukDate?.label, 'In 2d');
    assert.equal(isoDate?.label, 'In 2d');
  } finally {
    restoreTime();
  }
});

test('helper functions generate expected labels and cutoffs', () => {
  assert.equal(getUrgencyBadge(0).label, 'Today');
  assert.equal(getUrgencyBadge(3).label, 'In 3d');
  assert.equal(getUrgencyBadge(-3).label, '3d overdue');

  assert.equal(isWithinTriageWindow(7), true);
  assert.equal(isWithinTriageWindow(8), false);
  assert.equal(isWithinTriageWindow(-7), true);
  assert.equal(isWithinTriageWindow(-8), false);

  const now = new Date('2026-02-10T09:00:00.000Z');
  const target = new Date('2026-02-11T23:59:59.999Z');
  assert.equal(calculateDayDelta(target, now), 1);
});
