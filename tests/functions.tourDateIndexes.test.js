const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpdates,
  parseArgs,
  parseDateOnly,
} = require('../functions/scripts/backfillTourDateIndexes');
const { deriveTourDateIndexUpdate } = require('../functions/lib/tourDateIndex');

test('tour date index backfill parses only strict UK and ISO calendar dates', () => {
  assert.equal(parseDateOnly('22/08/2026'), Date.UTC(2026, 7, 22));
  assert.equal(parseDateOnly('2026-08-22'), Date.UTC(2026, 7, 22));
  assert.equal(parseDateOnly('31/02/2026'), null);
  assert.equal(parseDateOnly('08/22/2026'), null);
});

test('server normalization repairs drift from every tour producer and removes invalid stale indexes', () => {
  assert.deepEqual(deriveTourDateIndexUpdate({ startDate: '22/08/2026', endDate: '24/08/2026', startDateEpochMs: 1, endDateEpochMs: 2 }), {
    startDateEpochMs: Date.UTC(2026, 7, 22),
    endDateEpochMs: Date.UTC(2026, 7, 24),
  });
  assert.equal(deriveTourDateIndexUpdate({ startDate: '22/08/2026', endDate: '24/08/2026', startDateEpochMs: Date.UTC(2026, 7, 22), endDateEpochMs: Date.UTC(2026, 7, 24) }), null);
  assert.deepEqual(deriveTourDateIndexUpdate({ startDate: 'invalid', startDateEpochMs: 1, endDateEpochMs: 2 }), { startDateEpochMs: null, endDateEpochMs: null });
});

test('tour date index backfill is dry-run by default and requires explicit full-scan acknowledgement for apply', () => {
  assert.deepEqual(parseArgs([]), { apply: false, allowFullScan: false, limit: 500 });
  assert.deepEqual(parseArgs(['--apply', '--allow-full-scan', '--limit=25']), { apply: true, allowFullScan: true, limit: 25 });
});

test('tour date index backfill creates bounded multipath updates and reports invalid records', () => {
  const result = buildUpdates({
    READY: { startDate: '22/08/2026', endDate: '24/08/2026' },
    UNCHANGED: {
      startDate: '01/09/2026', endDate: '01/09/2026',
      startDateEpochMs: Date.UTC(2026, 8, 1), endDateEpochMs: Date.UTC(2026, 8, 1),
    },
    INVALID: { startDate: '31/02/2026', endDate: '01/03/2026' },
  }, 10);
  assert.deepEqual(result.updates, {
    'tours/READY/startDateEpochMs': Date.UTC(2026, 7, 22),
    'tours/READY/endDateEpochMs': Date.UTC(2026, 7, 24),
  });
  assert.deepEqual(result.summary, {
    scanned: 3,
    indexed: 1,
    unchanged: 1,
    invalidTourIds: ['INVALID'],
    capped: false,
  });
});
