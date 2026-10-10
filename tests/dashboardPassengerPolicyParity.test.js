'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePassengerCount } = require('../functions/src/domains/admin-dashboard/dashboardProjection');

test('dashboard browser and server use the same passenger count authority and validation', async () => {
  const { resolveTourPassengerCount } = await import('../web-admin/src/utils/tourPassengerCounts.js');
  const invalid = [null, undefined, '', ' ', ' 12 ', true, false, -1, 1.5, NaN, Infinity, 'x', Number.MAX_SAFE_INTEGER + 1];
  const fixtures = [
    { tour: { sold: 32, bookedPassengerCount: 30, currentParticipants: 0 } },
    { tour: { sold: 1, bookedPassengerCount: 1, manifestPassengerCount: 1, manualPassengerCount: 2 } },
    { tour: { sold: 0, bookedPassengerCount: 3, manualPassengerCount: 2 } },
    { tour: { currentParticipants: 4, manualPassengerCount: 2 } },
    { tour: { sold: 0, currentParticipants: 20 } },
    { tour: { bookedPassengerCount: '12', manifestPassengerCount: 8, currentParticipants: 0 } },
    { tour: { manifestPassengerCount: 0, currentParticipants: 20 } },
    { tour: { currentParticipants: 0 }, manifestPassengerCount: 7 },
    { tour: { participants: { a: true, b: true } }, participantCount: 2 },
    { tour: {} },
    ...invalid.map(value => ({ tour: { sold: value, bookedPassengerCount: value,
      manifestPassengerCount: 7, currentParticipants: 0 } })),
    ...invalid.map(value => ({ tour: { sold: 3, manualPassengerCount: value } })),
  ];
  for (const fixture of fixtures) {
    const browser = resolveTourPassengerCount(fixture.tour, fixture);
    const backend = resolvePassengerCount(fixture);
    assert.deepEqual(browser, { count: backend.passengerCount, source: backend.passengerCountSource });
  }
});
