const test = require('node:test');
const assert = require('node:assert');
const { parseSupportedStartDate, getTourDayContext } = require('../services/itineraryDateParser');

test('parseSupportedStartDate parses strict UK dates', () => {
  const parsed = parseSupportedStartDate('09/10/2025');

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2025);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 9);
  assert.equal(parsed.getHours(), 12);
});

test('parseSupportedStartDate parses strict ISO dates', () => {
  const parsed = parseSupportedStartDate('2025-10-09');

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2025);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 9);
  assert.equal(parsed.getHours(), 12);
});

test('parseSupportedStartDate rejects invalid or ambiguous formats', () => {
  assert.equal(parseSupportedStartDate('10/09/25'), null);
  assert.equal(parseSupportedStartDate('2025/10/09'), null);
  assert.equal(parseSupportedStartDate('31/02/2025'), null);
  assert.equal(parseSupportedStartDate('2025-02-31'), null);
});

test('getTourDayContext returns ACTIVE with current day data', () => {
  const context = getTourDayContext({
    startDate: '09/10/2025',
    itineraryDays: [{ day: 1 }, { day: 2 }, { day: 3 }],
    now: new Date('2025-10-10T09:00:00.000Z'),
  });

  assert.equal(context.status, 'ACTIVE');
  assert.equal(context.dayIndex, 1);
  assert.equal(context.dayNumber, 2);
  assert.deepEqual(context.data, { day: 2 });
});

test('getTourDayContext returns FUTURE with daysToGo', () => {
  const context = getTourDayContext({
    startDate: '2025-10-12',
    itineraryDays: [{ day: 1 }, { day: 2 }],
    now: new Date('2025-10-10T09:00:00.000Z'),
  });

  assert.equal(context.status, 'FUTURE');
  assert.equal(context.daysToGo, 2);
});

test('getTourDayContext returns COMPLETED when tour days are exhausted', () => {
  const context = getTourDayContext({
    startDate: '09/10/2025',
    itineraryDays: [{ day: 1 }],
    now: new Date('2025-10-12T09:00:00.000Z'),
  });

  assert.equal(context.status, 'COMPLETED');
  assert.equal(context.dayIndex, 3);
});

test('getTourDayContext returns status for invalid start date or itinerary content', () => {
  const invalidStart = getTourDayContext({
    startDate: '10-09-2025',
    itineraryDays: [{ day: 1 }],
  });

  const noDays = getTourDayContext({
    startDate: '09/10/2025',
    itineraryDays: [],
  });

  assert.equal(invalidStart.status, 'INVALID_START_DATE');
  assert.equal(noDays.status, 'NO_ITINERARY_DAYS');
});
