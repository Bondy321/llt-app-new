const test = require('node:test');
const assert = require('node:assert');

const {
  buildAssignedDriverCodePayload,
  normalizeAssignedDriverCodeRecord,
} = require('../services/bookingServiceRealtime');

test('buildAssignedDriverCodePayload returns canonical keys and casing', () => {
  const payload = buildAssignedDriverCodePayload({
    tourId: '5112D_8',
    tourCode: '5112D 8',
    assignedAt: '2026-02-01T10:15:00.000Z',
    assignedBy: 'uid_mobile_1',
  });

  assert.deepEqual(payload, {
    tourId: '5112D_8',
    tourCode: '5112D 8',
    assignedAt: '2026-02-01T10:15:00.000Z',
    assignedBy: 'uid_mobile_1',
  });
});

test('normalizeAssignedDriverCodeRecord accepts canonical object payload', () => {
  const normalized = normalizeAssignedDriverCodeRecord({
    value: {
      tourId: '5112D_8',
      tourCode: '5112D 8',
      assignedAt: '2026-02-01T10:15:00.000Z',
      assignedBy: 'uid_mobile_1',
    },
    driverId: 'D-BONDY',
  });

  assert.equal(normalized.legacy, false);
  assert.equal(normalized.tourId, '5112D_8');
  assert.equal(normalized.tourCode, '5112D 8');
  assert.equal(normalized.assignedBy, 'uid_mobile_1');
});

test('normalizeAssignedDriverCodeRecord supports legacy string payloads temporarily', () => {
  const normalized = normalizeAssignedDriverCodeRecord({
    value: '5112D 8',
    driverId: 'D-BONDY',
  });

  assert.equal(normalized.legacy, true);
  assert.equal(normalized.tourId, '5112D_8');
  assert.equal(normalized.tourCode, '5112D 8');
});
