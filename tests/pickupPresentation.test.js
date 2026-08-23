const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDestinationQuery, buildDirectionsUrls } = require('../utils/directions');
const { formatPickupDate, resolvePrimaryPickup } = require('../utils/pickupPresentation');

test('formats strict UK and ISO pickup dates and rejects ambiguous dates', () => {
  assert.match(formatPickupDate('24/08/2026'), /Mon, 24 Aug 2026/);
  assert.match(formatPickupDate('2026-08-24'), /Mon, 24 Aug 2026/);
  assert.equal(formatPickupDate('24-08-26'), '');
  assert.equal(formatPickupDate('31/02/2026'), '');
});

test('resolves the customer booking pickup without using unrelated tour fields', () => {
  const pickup = resolvePrimaryPickup({
    pickupDate: '24/08/2026',
    pickupPoints: [{
      time: '08:00',
      location: 'Balloch Tourist Information Centre',
      address: 'Old Luss Road, Balloch',
    }],
    services: [{ address: 'Supplier address must not be used' }],
  });

  assert.equal(pickup.date, '24/08/2026');
  assert.equal(pickup.destination, 'Balloch Tourist Information Centre, Old Luss Road, Balloch');
  assert.equal(pickup.destination.includes('Supplier'), false);
});

test('builds encoded native and web map directions with de-duplicated location parts', () => {
  const destination = buildDestinationQuery('The Hotel', '1 Main Street', 'G1 1AA', 'The Hotel');
  assert.equal(destination, 'The Hotel, 1 Main Street, G1 1AA');
  assert.deepEqual(buildDirectionsUrls(destination, 'ios'), {
    nativeUrl: 'maps://?daddr=The%20Hotel%2C%201%20Main%20Street%2C%20G1%201AA&dirflg=d',
    webUrl: 'https://www.google.com/maps/dir/?api=1&destination=The%20Hotel%2C%201%20Main%20Street%2C%20G1%201AA',
  });
  assert.equal(buildDirectionsUrls('', 'android'), null);
});
