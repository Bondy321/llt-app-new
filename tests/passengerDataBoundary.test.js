const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePassengerBookingProjection,
  normalizePassengerTourPack,
  normalizePassengerTourProjection,
} = require('../services/passengerDataBoundary');

test('passenger tour projection drops driver-only and contract/service data recursively', () => {
  const projected = normalizePassengerTourProjection({
    id: '5112D_8',
    name: 'Highlands Escape',
    tourCode: '5112D 8',
    startDate: '24/08/2026',
    isActive: true,
    currentParticipants: 12,
    driverName: 'Jamie',
    itinerary: {
      title: 'Your itinerary',
      days: [{ day: 1, content: 'Welcome', contract: { ref: 'SECRET' } }],
      services: [{ supplier: 'SECRET' }],
    },
    driver_itinerary: 'Supplier-only instructions',
    services: [{ reference: 'SECRET' }],
    contracts: [{ price: 99 }],
    participants: { authUid: { email: 'hidden@example.com' } },
  }, '5112D_8');

  assert.deepEqual(Object.keys(projected).sort(), [
    'currentParticipants', 'driverName', 'id', 'isActive', 'itinerary', 'name', 'startDate', 'tourCode',
  ]);
  assert.deepEqual(projected.itinerary.days[0], { day: 1, content: 'Welcome' });
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
  assert.equal(JSON.stringify(projected).includes('example.com'), false);
});

test('passenger booking projection keeps only the travelling party, seats, and own pickup', () => {
  const projected = normalizePassengerBookingProjection({
    id: 'ABC123',
    tourId: '5112D_8',
    passengerNames: ['Alex', 'Sam'],
    seatNumbers: ['S12', 'S13'],
    pickupPoints: [{
      date: '24/08/2026',
      time: '08:00',
      location: 'Balloch Tourist Information Centre',
      address: 'Old Luss Road, Balloch',
      supplierPhone: '01234 567890',
    }],
    email: 'hidden@example.com',
    phone: '07123 456789',
    serviceContracts: [{ ref: 'SECRET' }],
  }, 'abc123');

  assert.deepEqual(projected.pickupPoints[0], {
    date: '24/08/2026',
    time: '08:00',
    location: 'Balloch Tourist Information Centre',
    address: 'Old Luss Road, Balloch',
  });
  assert.equal(JSON.stringify(projected).includes('example.com'), false);
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
  assert.equal(normalizePassengerBookingProjection(projected, 'DIFFERENT'), null);
});

test('passenger Tour Pack replacement drops every unknown top-level and nested field', () => {
  const pack = normalizePassengerTourPack({
    tour: { id: 'T_1', name: 'Safe tour', services: [{ supplier: 'Hidden' }] },
    booking: {
      id: 'ABC123',
      normalizedPassengerEmail: 'Passenger@Example.com',
      passengerNames: ['Alex'],
      contract: 'Hidden',
    },
    safety: { emergencyPhone: '01234 567890', internalEscalation: 'Hidden' },
    contracts: [{ supplier: 'Hidden' }],
  }, { expectedTourId: 'T_1', expectedBookingRef: 'ABC123' });

  assert.deepEqual(Object.keys(pack).sort(), ['booking', 'safety', 'tour']);
  assert.equal(pack.booking.normalizedPassengerEmail, 'passenger@example.com');
  assert.deepEqual(pack.safety, { emergencyPhone: '01234 567890' });
  assert.equal(JSON.stringify(pack).includes('Hidden'), false);
});
