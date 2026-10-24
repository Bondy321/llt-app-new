'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTourMutation } = require('../functions/src/domains/administration/tourMutation');
const { validatePublicationPaths } = require('../functions/src/domains/administration/tourPublication');
const existing = { name: 'Synthetic tour', tourCode: 'A', startDate: '01/11/2026', endDate: '02/11/2026',
  days: 2, isActive: true, maxParticipants: 53, currentParticipants: 30, manualPassengerCount: 2,
  pickupPoints: [{ location: 'Town', time: '09:00', importedStopCode: 'SOURCE' }],
  itinerary: { sourceFormat: 'preserved' }, sourceLifecycle: { status: 'active', managedDisable: true } };
test('editing a name preserves imported shapes and recomputes strict date indexes', () => {
  const changes = validateTourMutation({ tourId: 'A', existing, values: { name: 'Updated' } });
  assert.deepEqual(changes, { name: 'Updated', startDate: '01/11/2026', endDate: '02/11/2026',
    startDateEpochMs: Date.UTC(2026, 10, 1), endDateEpochMs: Date.UTC(2026, 10, 2) });
  assert.equal(existing.pickupPoints[0].importedStopCode, 'SOURCE');
});
test('browser mutation cannot replace runtime, identity, lifecycle or arbitrary children', () => {
  for (const values of [{ assignedDriverId: 'X' }, { rosterSync: {} }, { 'name/child': 'X' },
    { driverLocationEpoch: 0 }, { sourceLifecycle: { status: 'active' } }, { name: 'x'.repeat(301) }]) {
    assert.throws(() => validateTourMutation({ tourId: 'A', existing, values }));
  }
});
test('changed pickups and itinerary receive bounded nested validation', () => {
  for (const values of [{ pickupPoints: [{ location: 'Town', time: '09:00', extra: true }] },
    { pickupPoints: Array(101).fill({ location: 'Town', time: '' }) },
    { itinerary: { title: 'x', days: [{ day: 1, title: 'x', activities: [{ description: 'x', time: 'x', script: 'x' }] }] } }]) {
    assert.throws(() => validateTourMutation({ tourId: 'A', existing, values }));
  }
});
test('invalid dates, path manipulation, changed code and undersized capacity fail closed', () => {
  for (const values of [{ startDate: '31/11/2026' }, { endDate: '01/10/2026' },
    { maxParticipants: 31 }, { tourCode: 'B' }, { days: 1.5 }, { isActive: 'true' }]) {
    assert.throws(() => validateTourMutation({ tourId: 'A', existing, values }));
  }
  assert.throws(() => validateTourMutation({ tourId: '../A', existing, values: {} }));
});

test('tour publication limits booking roots and leaf transfers to explicit captured scope', () => {
  const scope = { tourIds: ['A', 'B'], bookingRefs: ['BOOK'] };
  for (const updates of [{ 'bookings/BOOK/tourId': 'OUTSIDE' }, { 'bookings/BOOK': { tourId: 'OUTSIDE' } },
    { 'bookings/OTHER': null }, { 'booking_identities/OTHER': null },
    { 'manual_booking_creation_locks/bookings/OTHER': null }, { 'passenger_trip_signals/v1/bookings/OTHER': null }]) {
    assert.throws(() => validatePublicationPaths({ ...scope, updates }));
  }
  validatePublicationPaths({ ...scope, updates: { 'bookings/BOOK/tourId': 'B', 'booking_identities/BOOK': null,
    'manual_booking_creation_locks/bookings/BOOK': null, 'passenger_trip_signals/v1/bookings/BOOK': null } });
});
