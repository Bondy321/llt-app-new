const test = require('node:test');
const assert = require('node:assert');
const { MANIFEST_STATUS } = require('../services/bookingServiceRealtime');
const { buildTourHomeActionPlan } = require('../utils/tourHomeActionPlanner');

test('prioritizes reconnect actions when marked no-show', () => {
  const plan = buildTourHomeActionPlan({
    manifestStatus: MANIFEST_STATUS.NO_SHOW,
    pickupCountdown: { mode: 'countdown', totalMinutesLeft: 30 },
    driverLocationActive: false,
  });

  assert.equal(plan.primaryActionId, 'Chat');
  assert.deepEqual(plan.orderedActionIds.slice(0, 2), ['Chat', 'Map']);
});

test('prioritizes map when pickup is within two hours', () => {
  const plan = buildTourHomeActionPlan({
    manifestStatus: MANIFEST_STATUS.PENDING,
    pickupCountdown: { mode: 'countdown', totalMinutesLeft: 90 },
    driverLocationActive: true,
  });

  assert.equal(plan.primaryActionId, 'Map');
  assert.equal(plan.orderedActionIds[0], 'Map');
});

test('defaults to itinerary-first plan when no urgent context exists', () => {
  const plan = buildTourHomeActionPlan({
    manifestStatus: MANIFEST_STATUS.PENDING,
    pickupCountdown: { mode: 'countdown', totalMinutesLeft: 500 },
    driverLocationActive: false,
  });

  assert.equal(plan.primaryActionId, 'Itinerary');
  assert.deepEqual(plan.orderedActionIds.slice(0, 3), ['Itinerary', 'Chat', 'Map']);
});
