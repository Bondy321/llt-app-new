const test = require('node:test');
const assert = require('node:assert');

const { parseSupportedStartDate } = require('../services/itineraryDateParser');

test('parses UK dd/MM/yyyy start dates and normalizes to noon', () => {
  const parsed = parseSupportedStartDate('25/01/2026');

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 0);
  assert.equal(parsed.getDate(), 25);
  assert.equal(parsed.getHours(), 12);
  assert.equal(parsed.getMinutes(), 0);
});

test('parses ISO yyyy-MM-dd start dates and normalizes to noon', () => {
  const parsed = parseSupportedStartDate('2026-01-25');

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 0);
  assert.equal(parsed.getDate(), 25);
  assert.equal(parsed.getHours(), 12);
});

test('rejects unsupported or ambiguous human-entered date strings', () => {
  assert.equal(parseSupportedStartDate('01-25-2026'), null);
  assert.equal(parseSupportedStartDate('2026/01/25'), null);
  assert.equal(parseSupportedStartDate('25 Jan 2026'), null);
});

test('rejects invalid calendar dates in supported formats', () => {
  assert.equal(parseSupportedStartDate('31/02/2026'), null);
  assert.equal(parseSupportedStartDate('2026-02-31'), null);
});
