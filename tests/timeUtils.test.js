const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTimestampMs, getMinutesAgo } = require('../services/timeUtils');

test('parseTimestampMs handles numbers, strict date formats, and rejects invalid values', () => {
  assert.equal(parseTimestampMs(1700000000000), 1700000000000);
  assert.equal(parseTimestampMs('1700000000000'), 1700000000000);

  const isoUtcMs = parseTimestampMs('2026-02-20T10:30:00.000Z');
  assert.equal(Number.isFinite(isoUtcMs), true);

  assert.equal(parseTimestampMs('2026-02-20'), new Date(2026, 1, 20, 0, 0, 0, 0).getTime());
  assert.equal(parseTimestampMs('20/02/2026'), new Date(2026, 1, 20, 0, 0, 0, 0).getTime());
  assert.equal(parseTimestampMs('2026-02-20 10:30:15.12'), new Date(2026, 1, 20, 10, 30, 15, 120).getTime());

  assert.equal(parseTimestampMs('31/02/2026'), null);
  assert.equal(parseTimestampMs('2026-02-31'), null);
  assert.equal(parseTimestampMs('2026-13-01'), null);
  assert.equal(parseTimestampMs('02/20/2026'), null);
  assert.equal(parseTimestampMs('Thu, 20 Feb 2026 10:30:00 GMT'), null);

  assert.equal(parseTimestampMs('not-a-date'), null);
  assert.equal(parseTimestampMs(''), null);
  assert.equal(parseTimestampMs(undefined), null);
});

test('getMinutesAgo returns null for invalid timestamps and floors elapsed minutes', () => {
  const now = Date.UTC(2026, 1, 20, 10, 30, 0); // 20 Feb 2026 10:30 UTC

  assert.equal(getMinutesAgo('invalid', now), null);
  assert.equal(getMinutesAgo('2026-02-20T10:00:59.000Z', now), 29);
  assert.equal(getMinutesAgo('2026-02-20T10:00:00.000Z', now), 30);
});
