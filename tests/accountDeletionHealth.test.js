'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readAccountDeletionHealth } = require('../functions/src/domains/account-deletion/accountDeletionFunctions');

test('scheduled deletion health distinguishes completed requests from bounded work and exposes no identifiers', async () => {
  const query = [];
  const ref = { orderByChild: value => { query.push(['orderByChild', value]); return ref; },
    limitToFirst: value => { query.push(['limitToFirst', value]); return ref; },
    once: async () => ({ val: () => ({ privateReceipt: { dueAtMs: 100, deletionId: 'private-id' } }) }) };
  const health = await readAccountDeletionHealth({ db: { ref: path => {
    assert.equal(path, 'account_deletion_queue/v1'); return ref;
  } }, nowMs: 1000, outcomes: [
    { processed: true, phaseAdvanced: false, completed: false },
    { processed: true, phaseAdvanced: true, completed: false },
    { processed: true, phaseAdvanced: true, completed: true },
    { processed: false, errorCode: 'PRIVATE_INTERNAL_REASON' },
    { processed: false, reason: 'QUEUE_NOT_CLAIMED' },
  ] });
  assert.deepEqual(query, [['orderByChild', 'dueAtMs'], ['limitToFirst', 1]]);
  assert.deepEqual(health, { event: 'account_deletion_queue_health', oldestDueAgeMs: 900,
    hasQueuedWork: true, phaseAdvances: 2, succeeded: 1, failed: 1 });
  const alerts = require('../config/first-launch/monitoring-plan.json').logAlerts;
  const deletionAlert = alerts.find(alert => alert.displayName === 'LLT account deletion delayed or failed');
  assert.ok(deletionAlert.filter.includes(`jsonPayload.event="${health.event}"`));
  assert.ok(deletionAlert.filter.includes('jsonPayload.oldestDueAgeMs>'));
  assert.ok(deletionAlert.filter.includes('jsonPayload.failed>0'));
});
