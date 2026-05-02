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

// --- Strict date-contract enforcement -------------------------------------
// docs/date-contract.md only permits zero-padded UK (dd/MM/yyyy) and ISO
// (yyyy-MM-dd) date strings. Loose variants must be rejected so ambiguous
// inputs like "1/2/2026" cannot silently parse and drive a wrong countdown.

const NOW = new Date(2026, 0, 10, 8, 0, 0);

const expectDateRejected = (pickupDate) => {
  const result = parsePickupDateTime({ pickupTime: '10:00', pickupDate, now: NOW });
  assert.equal(result.success, false, `expected ${JSON.stringify(pickupDate)} to be rejected`);
  assert.equal(result.reason, 'DATE_PARSE_FAILED');

  const countdown = getPickupCountdownState({ pickupTime: '10:00', pickupDate, now: NOW });
  assert.equal(countdown.mode, 'invalid');
  assert.equal(countdown.reason, 'DATE_PARSE_FAILED');
};

const expectDateAccepted = (pickupDate, { day, month, year }) => {
  const result = parsePickupDateTime({ pickupTime: '10:00', pickupDate, now: NOW });
  assert.equal(result.success, true, `expected ${JSON.stringify(pickupDate)} to be accepted`);
  assert.equal(result.hasExplicitDate, true);
  assert.equal(result.pickup.getFullYear(), year);
  assert.equal(result.pickup.getMonth(), month - 1);
  assert.equal(result.pickup.getDate(), day);
};

test('accepts canonical zero-padded UK and ISO date strings', () => {
  expectDateAccepted('09/01/2026', { day: 9, month: 1, year: 2026 });
  expectDateAccepted('31/12/2026', { day: 31, month: 12, year: 2026 });
  expectDateAccepted('2026-01-09', { day: 9, month: 1, year: 2026 });
  expectDateAccepted('2026-12-31', { day: 31, month: 12, year: 2026 });
});

test('still trims surrounding whitespace on canonical date strings', () => {
  expectDateAccepted(' 09/01/2026 ', { day: 9, month: 1, year: 2026 });
  expectDateAccepted('\t2026-01-09\n', { day: 9, month: 1, year: 2026 });
});

test('rejects single-digit day or month UK date strings', () => {
  expectDateRejected('9/01/2026');
  expectDateRejected('09/1/2026');
  expectDateRejected('9/1/2026');
  expectDateRejected('1/2/2026');
});

test('rejects single-digit day or month ISO date strings', () => {
  expectDateRejected('2026-1-09');
  expectDateRejected('2026-01-9');
  expectDateRejected('2026-1-9');
});

test('rejects calendar-invalid date strings', () => {
  // April has 30 days
  expectDateRejected('31/04/2026');
  expectDateRejected('2026-04-31');
  // February in a non-leap year
  expectDateRejected('29/02/2025');
  expectDateRejected('2025-02-29');
  // Out-of-range day/month components
  expectDateRejected('00/01/2026');
  expectDateRejected('01/00/2026');
  expectDateRejected('32/01/2026');
  expectDateRejected('01/13/2026');
  expectDateRejected('2026-00-01');
  expectDateRejected('2026-13-01');
  expectDateRejected('2026-01-00');
  expectDateRejected('2026-01-32');
});

test('accepts a leap-day date in a leap year', () => {
  expectDateAccepted('29/02/2024', { day: 29, month: 2, year: 2024 });
  expectDateAccepted('2024-02-29', { day: 29, month: 2, year: 2024 });
});

test('rejects ambiguous separator variants regardless of position', () => {
  // Hyphen UK / slash ISO mixups must not slip through
  expectDateRejected('09-01-2026');
  expectDateRejected('2026/01/09');
  expectDateRejected('20260109');
  expectDateRejected('09/01/26');
  expectDateRejected('Jan 9, 2026');
});

test('pickupTimeToMinutes still ignores ambient date and only uses time-of-day', () => {
  // Defensive coverage: even when feeding a now-rejected pickupDate to a flow,
  // pickupTimeToMinutes never consumes the date and stays usable for sorting.
  assert.equal(pickupTimeToMinutes('1:45 P.M.'), 825);
  assert.equal(pickupTimeToMinutes('06:30'), 390);
});
