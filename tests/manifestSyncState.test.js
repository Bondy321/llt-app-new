const test = require('node:test');
const assert = require('node:assert');
const { normalizeSyncState, getBookingSyncState } = require('../utils/manifestSyncState');

test('normalizes valid sync states and defaults unexpected values to synced', () => {
  assert.equal(normalizeSyncState('queued'), 'queued');
  assert.equal(normalizeSyncState('SYNCING'), 'syncing');
  assert.equal(normalizeSyncState(' failed '), 'failed');
  assert.equal(normalizeSyncState('weird-status'), 'synced');
  assert.equal(normalizeSyncState(undefined), 'synced');
});

test('returns queued sync state for queued booking ids and synced fallback for others', () => {
  const bookingSyncState = {
    ABC123: 'queued',
    DEF456: 'syncing',
  };

  assert.equal(getBookingSyncState(bookingSyncState, 'ABC123'), 'queued');
  assert.notEqual(getBookingSyncState(bookingSyncState, 'ABC123'), 'synced');
  assert.equal(getBookingSyncState(bookingSyncState, 'DEF456'), 'syncing');
  assert.equal(getBookingSyncState(bookingSyncState, 'MISSING'), 'synced');
});
