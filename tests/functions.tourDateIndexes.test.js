const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpdates,
  parseArgs,
  parseDateOnly,
  validateTarget,
  runBackfill,
} = require('../functions/scripts/backfillTourDateIndexes');
const { deriveTourDateIndexUpdate, reconcileTourDateIndexes } = require('../functions/lib/tourDateIndex');

test('tour date index backfill parses only strict UK and ISO calendar dates', () => {
  assert.equal(parseDateOnly('22/08/2026'), Date.UTC(2026, 7, 22));
  assert.equal(parseDateOnly('2026-08-22'), Date.UTC(2026, 7, 22));
  assert.equal(parseDateOnly('31/02/2026'), null);
  assert.equal(parseDateOnly('08/22/2026'), null);
  assert.equal(parseDateOnly('09/10/2026 00:00:00'), null);
  assert.equal(parseDateOnly('2026-10-09T00:00:00'), null);
});

test('server normalization repairs drift from every tour producer and removes invalid stale indexes', () => {
  assert.deepEqual(deriveTourDateIndexUpdate({ startDate: '22/08/2026', endDate: '24/08/2026', startDateEpochMs: 1, endDateEpochMs: 2 }), {
    startDateEpochMs: Date.UTC(2026, 7, 22),
    endDateEpochMs: Date.UTC(2026, 7, 24),
  });
  assert.equal(deriveTourDateIndexUpdate({ startDate: '22/08/2026', endDate: '24/08/2026', startDateEpochMs: Date.UTC(2026, 7, 22), endDateEpochMs: Date.UTC(2026, 7, 24) }), null);
  assert.deepEqual(deriveTourDateIndexUpdate({ startDate: 'invalid', startDateEpochMs: 1, endDateEpochMs: 2 }), { startDateEpochMs: null, endDateEpochMs: null });
});

test('backfill defaults to bounded dry-run and rejects invalid options', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.limit, 500);
  assert.equal(defaults.pageSize, 50);
  assert.equal(parseArgs(['--apply', '--allow-full-scan', '--limit=25']).limit, 25);
  assert.equal(parseArgs(['--page-size=900']).pageSize, 100);
  assert.throws(() => parseArgs(['--limit=0']), /positive integer/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
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
    cleared: 0,
    unchanged: 2,
    invalidTourIds: ['INVALID'],
    capped: false,
    nextCursor: null,
  });
});

const TARGET = 'https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app';
test('explicit project/database validation fails before initialization and apply needs both exact confirmations', () => {
  const targetArgs = ['--project=loch-lomond-travel', `--database-url=${TARGET}`];
  assert.throws(() => validateTarget(parseArgs([])), /explicit valid --project/);
  assert.deepEqual(validateTarget(parseArgs(targetArgs)), { projectId: 'loch-lomond-travel', databaseURL: TARGET });
  assert.throws(() => validateTarget(parseArgs([...targetArgs, '--apply'])), /matching the explicit target/);
  assert.throws(() => validateTarget(parseArgs([...targetArgs, '--apply', '--confirm-project=other-project', `--confirm-database=${TARGET}`])), /matching the explicit target/);
  assert.deepEqual(validateTarget(parseArgs([...targetArgs, '--apply', '--confirm-project=loch-lomond-travel', `--confirm-database=${TARGET}`])), { projectId: 'loch-lomond-travel', databaseURL: TARGET });
  for (const url of ['https://other-project.firebaseio.com', `${TARGET}/tours`, `${TARGET}?auth=token`, 'http://loch-lomond-travel.firebaseio.com', 'https://loch-lomond-travel.evil.example']) {
    assert.throws(() => validateTarget(parseArgs(['--project=loch-lomond-travel', `--database-url=${url}`])));
  }
  assert.throws(() => validateTarget(parseArgs([...targetArgs, '--after-key=bad/key'])), /Invalid --after-key/);
});

test('planner removes invalid/reversed stale indexes and distinguishes a full batch from remaining work', () => {
  const result = buildUpdates({
    BAD: { startDate: '09/10/2026 00:00:00', startDateEpochMs: 1, endDateEpochMs: 2 },
    REVERSED: { startDate: '10/10/2026', endDate: '09/10/2026', startDateEpochMs: 1, endDateEpochMs: 2 },
    READY: { startDate: '12/10/2026' },
  }, 2);
  assert.equal(result.summary.scanned, 2);
  assert.equal(result.summary.cleared, 2);
  assert.equal(result.summary.capped, true);
  assert.equal(result.summary.nextCursor, 'REVERSED');
  assert.equal(result.updates['tours/BAD/startDateEpochMs'], null);
  assert.equal(result.updates['tours/REVERSED/endDateEpochMs'], null);
  assert.equal(buildUpdates({ READY: { startDate: '12/10/2026' } }, 1).summary.capped, false);
});

test('transaction retries derive latest dates, preserve concurrent operational fields and do not recreate deletion', async () => {
  let current = { startDate: '09/10/2026', endDate: '10/10/2026', participants: { before: true } };
  const result = await reconcileTourDateIndexes({
    async transaction(update, _onComplete, applyLocally) {
      assert.equal(applyLocally, false);
      // Empty SDK cache must not abort before the server compare/retry.
      assert.equal(update(null), null);
      const superseded = update(current);
      assert.equal(superseded.startDateEpochMs, Date.UTC(2026, 9, 9));
      current = { ...current, startDate: '12/10/2026', endDate: '14/10/2026', participants: { after: true }, driverLocation: { latitude: 56 } };
      current = update(current);
      return { committed: true, snapshot: { val: () => current } };
    },
  });
  assert.equal(result.committed, true);
  assert.equal(current.startDateEpochMs, Date.UTC(2026, 9, 12));
  assert.equal(current.endDateEpochMs, Date.UTC(2026, 9, 14));
  assert.deepEqual(current.participants, { after: true });
  assert.deepEqual(current.driverLocation, { latitude: 56 });
  assert.equal(deriveTourDateIndexUpdate(current), null);
  const deleted = await reconcileTourDateIndexes({ async transaction(update) {
    assert.equal(update(null), null);
    return { committed: true, snapshot: { val: () => null } };
  } });
  assert.equal(deleted.committed, false);
});

function pagingDatabase(records, orderedKeys, beforeTransaction = () => {}) {
  const state = structuredClone(records);
  const reads = [];
  let transactions = 0;
  return {
    state, reads,
    get transactions() { return transactions; },
    ref(path) {
      if (path !== 'tours') return { async transaction(update) {
        transactions += 1;
        const key = path.slice('tours/'.length);
        beforeTransaction(state, key);
        const next = update(state[key] ?? null);
        if (next !== undefined) { if (next === null) delete state[key]; else state[key] = next; }
        return { committed: next !== undefined, snapshot: { val: () => state[key] ?? null } };
      } };
      let afterKey = ''; let limit;
      const query = {
        orderByKey() { return query; },
        startAfter(key) { afterKey = key; return query; },
        limitToFirst(value) { limit = value; return query; },
        async once() {
          reads.push({ afterKey, limit });
          const start = afterKey ? orderedKeys.indexOf(afterKey) + 1 : 0;
          const keys = orderedKeys.slice(start).filter((key) => Object.hasOwn(state, key)).slice(0, limit);
          return { forEach(callback) { keys.forEach((key) => callback({ key, val: () => structuredClone(state[key]) })); } };
        },
      };
      return query;
    },
  };
}

test('key-ordered bounded dry-run and continuation include unchanged/invalid rows without mutation', async () => {
  const db = pagingDatabase({ '2': { startDate: '12/10/2026' }, '10': { startDate: 'invalid' }, A: { startDate: '14/10/2026' }, B: { startDate: '15/10/2026' } }, ['2', '10', 'A', 'B']);
  const initial = structuredClone(db.state);
  const first = await runBackfill({ database: db, options: parseArgs(['--page-size=1', '--limit=2']) });
  assert.equal(first.scanned, 2);
  assert.equal(first.invalid, 1);
  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, '10');
  const rest = await runBackfill({ database: db, options: parseArgs(['--page-size=1', '--limit=2', '--after-key=10']) });
  assert.equal(rest.scanned, 2);
  assert.equal(rest.complete, true);
  assert.equal(rest.nextCursor, null);
  assert.ok(db.reads.every(({ limit }) => limit === 2));
  assert.equal(db.transactions, 0);
  assert.deepEqual(db.state, initial);
});

test('apply rereads each latest tour transaction instead of committing a stale page plan', async () => {
  const db = pagingDatabase({ A: { startDate: '12/10/2026' }, B: { startDate: 'invalid', startDateEpochMs: 1, endDateEpochMs: 2 }, C: { startDate: '14/10/2026' } }, ['A', 'B', 'C'], (state, key) => {
    if (key === 'A') state.A = { ...state.A, startDate: '15/10/2026', participants: { active: true } };
    if (key === 'C') delete state.C;
  });
  const result = await runBackfill({ database: db, options: parseArgs(['--apply', '--page-size=2']) });
  assert.equal(result.indexed, 1);
  assert.equal(result.cleared, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.complete, true);
  assert.equal(db.state.A.startDateEpochMs, Date.UTC(2026, 9, 15));
  assert.deepEqual(db.state.A.participants, { active: true });
  assert.equal(db.state.B.startDateEpochMs, null);
  assert.equal(db.state.C, undefined);
});
