const test = require('node:test');
const assert = require('node:assert');
const {
  normalizePickupTimeInput,
  parsePickupTime,
  pickupTimeToMinutes,
  getPickupCountdownState,
  parsePickupDateTime,
} = require('../services/pickupTimeParser');

test('normalizes common sheet sync variants', () => {
  assert.equal(normalizePickupTimeInput(' 9:05 a.m. '), '9:05 AM');
  assert.equal(normalizePickupTimeInput('10:45   pm'), '10:45 PM');
});

test('parses 24-hour pickup times', () => {
  const result = parsePickupTime('06:30');
  assert.equal(result.success, true);
  assert.equal(result.parsed.hours, 6);
  assert.equal(result.parsed.minutes, 30);
});

test('parses 12-hour pickup times with AM/PM', () => {
  const amResult = parsePickupTime('12:01 am');
  assert.equal(amResult.success, true);
  assert.equal(amResult.parsed.hours, 0);

  const pmResult = parsePickupTime('1:45 P.M.');
  assert.equal(pmResult.success, true);
  assert.equal(pmResult.parsed.hours, 13);
  assert.equal(pmResult.parsed.minutes, 45);
});


test('converts supported pickup time formats into sortable minute offsets', () => {
  assert.equal(pickupTimeToMinutes('06:30'), 390);
  assert.equal(pickupTimeToMinutes('1:45 P.M.'), 825);
  assert.equal(pickupTimeToMinutes('TBA'), Number.MAX_SAFE_INTEGER);
  assert.equal(pickupTimeToMinutes('not-a-time'), Number.MAX_SAFE_INTEGER);
});
test('rejects malformed or empty pickup times', () => {
  assert.equal(parsePickupTime('').success, false);
  assert.equal(parsePickupTime('25:99').success, false);
  assert.equal(parsePickupTime('tomorrow morning').success, false);
});

test('rolls next-day countdown forward when time has passed and no date context exists', () => {
  const now = new Date(2026, 0, 10, 23, 50, 0);
  const result = parsePickupDateTime({ pickupTime: '00:10', now });

  assert.equal(result.success, true);
  assert.equal(result.pickup.getDate(), 11);
  assert.equal(result.pickup.getHours(), 0);
  assert.equal(result.pickup.getMinutes(), 10);
});

test('uses explicit UK date context for countdown calculations', () => {
  const now = new Date(2026, 0, 10, 23, 50, 0);
  const countdown = getPickupCountdownState({
    pickupTime: '00:10',
    pickupDate: '11/01/2026',
    now,
  });

  assert.equal(countdown.mode, 'countdown');
  assert.equal(countdown.hoursLeft, 0);
  assert.equal(countdown.minutesLeft, 20);
});

test('uses explicit ISO date context for countdown calculations', () => {
  const now = new Date(2026, 0, 10, 8, 0, 0);
  const countdown = getPickupCountdownState({
    pickupTime: '10:00',
    pickupDate: '2026-01-10',
    now,
  });

  assert.equal(countdown.mode, 'countdown');
  assert.equal(countdown.hoursLeft, 2);
  assert.equal(countdown.minutesLeft, 0);
});

test('rejects countdown when explicit pickup date format is unsupported', () => {
  const now = new Date(2026, 0, 10, 8, 0, 0);
  const countdown = getPickupCountdownState({
    pickupTime: '10:00',
    pickupDate: '10-01-2026',
    now,
  });

  assert.equal(countdown.mode, 'invalid');
  assert.equal(countdown.reason, 'DATE_PARSE_FAILED');
});
