'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupExpiredStaffEnrolments, STAFF_PROOF_RETENTION_MS } = require('../functions/src/domains/driver-auth/staffEnrolmentRetention');

test('staff proof retention uses a bounded expiry query, retries cold transactions and preserves changed proofs', async () => {
  const nowMs = STAFF_PROOF_RETENTION_MS + 1000;
  const old = 'a'.repeat(64); const changed = 'b'.repeat(64);
  const state = { [old]: { schemaVersion: 1, state: 'redeemed', expiresAtMs: 900 },
    [changed]: { schemaVersion: 1, state: 'issued', expiresAtMs: 901 } };
  const snapshot = value => ({ val: () => structuredClone(value ?? null) });
  const query = {};
  const db = { ref(path) {
    if (path === 'driver_enrolments') {
      const ref = { orderByChild(value) { query.order = value; return ref; },
        startAt(value) { query.start = value; return ref; }, endAt(value) { query.end = value; return ref; },
        limitToFirst(value) { query.limit = value; return ref; }, async once() { return snapshot(state); } };
      return ref;
    }
    const key = path.split('/')[1];
    return { async transaction(update) {
      assert.equal(update(null), null, 'cold-cache callback must reach server');
      if (key === changed) state[key].state = 'revoked';
      const next = update(structuredClone(state[key]));
      if (next === undefined) return { committed: false, snapshot: snapshot(state[key]) };
      delete state[key]; return { committed: true, snapshot: snapshot(null) };
    } };
  } };
  const result = await cleanupExpiredStaffEnrolments({ db, nowMs, limit: 2 });
  assert.deepEqual(query, { order: 'expiresAtMs', start: 1, end: 1000, limit: 2 });
  assert.deepEqual(result, { scanned: 2, removed: 1, hasMore: true });
  assert.equal(state[old], undefined); assert.equal(state[changed].state, 'revoked');
});
