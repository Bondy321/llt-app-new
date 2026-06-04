const test = require('node:test');
const assert = require('node:assert');

const {
  buildAssignedDriverCodePayload,
} = require('../services/bookingServiceRealtime');
const { normalizeTourId, resolveTourId } = require('../services/tourIdentityService');

test('buildAssignedDriverCodePayload returns canonical keys and casing', () => {
  const payload = buildAssignedDriverCodePayload({
    driverId: 'D-BONDY',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    assignedAt: '2026-02-01T10:15:00.000Z',
    assignedBy: 'uid_mobile_1',
  });

  assert.deepEqual(payload, {
    driverId: 'D-BONDY',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    assignedAt: '2026-02-01T10:15:00.000Z',
    assignedBy: 'uid_mobile_1',
  });
});

test('normalizeTourId matches admin tour key normalization for usable tour codes', () => {
  assert.equal(normalizeTourId(' 5112d 8 '), '5112D_8');
  assert.equal(normalizeTourId('ops.#$[]/ tour'), 'OPS_TOUR');
  assert.equal(normalizeTourId(' ///  ###  '), null);
});

test('resolveTourId skips invalid candidates before falling back', () => {
  assert.equal(resolveTourId(' ///  ###  ', ' 5112d 8 '), '5112D_8');
});
