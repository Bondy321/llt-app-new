'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDistributedRequestLimit, getTrustedRequestNetworkKey } = require('../../functions/src/infrastructure/rate-limit/distributedRequestLimiter');
const { createNotificationRetentionMemoryDb } = require('../helpers/notificationRetentionMemoryDb');
const req = { headers: { 'x-forwarded-for': 'forged, 203.0.113.9, 10.0.0.1' } };
test('independent workers share UID quota even when callers rotate spoofable dimensions', async () => {
  const db = createNotificationRetentionMemoryDb({});
  const results = [];
  for (let index = 0; index < 5; index += 1) results.push(await checkDistributedRequestLimit({ db,
    req: { headers: { ...req.headers, 'x-client-id': `change-${index}`, 'user-agent': `change-${index}` } },
    authUid: 'synthetic-driver', action: 'manifest', maxRequests: 3,
  }));
  assert.deepEqual(results, [true, true, true, false, false]);
});
test('trusted network quota survives rotated installation UIDs; shared coach use remains admitted', async () => {
  const db = createNotificationRetentionMemoryDb({});
  for (let index = 0; index < 75; index += 1) assert.equal(await checkDistributedRequestLimit({
    db, req, authUid: `phone-${index}`, action: 'manifest', maxRequests: 30, networkMaxRequests: 100,
  }), true);
  for (let index = 75; index < 100; index += 1) await checkDistributedRequestLimit({
    db, req, authUid: `phone-${index}`, action: 'manifest', networkMaxRequests: 100,
  });
  assert.equal(await checkDistributedRequestLimit({ db, req, authUid: 'rotated', action: 'manifest', networkMaxRequests: 100 }), false);
  assert.equal(getTrustedRequestNetworkKey(req), '203.0.113.9');
});
test('quota outages deny rather than falling back to a process-local allowance', async () => {
  assert.equal(await checkDistributedRequestLimit({ db: {}, req, authUid: 'phone', action: 'manifest',
    limiter: async () => { throw new Error('synthetic outage'); } }), false);
});
