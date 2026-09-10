const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-trip-integration' });
const { createPassengerTripFixture } = require('./helpers/passengerTripFixture');
const { buildPassengerSessionRecord } = require('../functions/lib/appSession');
const { createPassengerTripSnapshotHandler } = require('../functions/src/domains/passenger-trip/passengerTripFunctions');
const { handlePassengerTripBookingSignal, handlePassengerTripTourSignal } = require('../functions/src/domains/passenger-trip/passengerTripSignals');
const { createPassengerTripController } = require('../services/passenger-trip/tripController');
const { createTripCache } = require('../services/passenger-trip/tripCache');
const { renderPassengerTripHome, renderPassengerTripItinerary } = require('./helpers/passengerTripRenderHarness');
const nativeMocks = require('./helpers/passengerTripNativeMocks');
require('@babel/register')({ extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const flush = async () => { for (let n = 0; n < 100; n += 1) await Promise.resolve(); };

test('synthetic source changes cross real active-session endpoint, shared controller and offline restart', async () => {
  const fixture = createPassengerTripFixture();
  const { db, scope, set, get, snapshot } = fixture;
  const now = Date.now();
  const session = buildPassengerSessionRecord({ authUid: scope.authUid, principalId: scope.principalId,
    tourId: scope.tourId, sessionId: scope.sessionId, nowMs: now, expiresAtMs: now + 60000 });
  set(`app_sessions/${scope.authUid}`, session);
  set(`users/${scope.authUid}`, { bookingRef: scope.bookingRef, stablePassengerId: scope.principalId,
    identityVersion: 'pax_v2', principalType: 'passenger' });
  set(`tours/${scope.tourId}/participants/${scope.authUid}`, { schemaVersion: 2, userId: scope.authUid,
    principalId: scope.principalId, sessionId: scope.sessionId, sessionExpiresAtMs: now + 60000 });
  // Only bearer/App Check verification is injected. Real active-session,
  // participant, profile, private binding and deletion-barrier checks run below.
  const handler = createPassengerTripSnapshotHandler({ dbFactory: () => db,
    authorizeRequest: async () => ({ uid: scope.authUid }), clock: () => now });
  const requests = []; const sizes = [];
  const request = async ({ parts, versions }) => {
    let status; let payload;
    const res = { set() {}, status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
    await handler({ method: 'POST', body: { expectedSessionId: scope.sessionId, parts, versions } }, res);
    requests.push(parts); sizes.push(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    if (status !== 200) throw Object.assign(new Error(payload.reason), { invalidSession: true });
    return payload;
  };
  const disk = new Map();
  const cache = createTripCache({ getItem: async (key) => disk.get(key) || null,
    setItem: async (key, value) => disk.set(key, value), removeItem: async (key) => disk.delete(key) });
  let signal; let timer; let attaches = 0; let detaches = 0;
  const makeController = () => createPassengerTripController({ scope, cache, request,
    subscribeSignals: (_scope, cb) => {
      signal = cb; attaches += 2;
      cb('booking', null); cb('tour', null); cb('itinerary', null);
      return () => { detaches += 2; };
    },
    schedule: (fn) => { timer = fn; return 1; }, cancel: () => { timer = null; } });
  const controller = makeController(); await controller.ready;
  controller.setAvailability(true);
  await controller.refresh('manual');
  nativeMocks.install();
  const { TourHomeScreen, ItineraryScreen } = nativeMocks.loadScreens();
  const displayProps = (owner, isConnected = true) => {
    const trip = { ...owner.getState(), nowMs: now, refresh: owner.refresh };
    return { passengerTrip: trip, bookingData: trip.parts.booking.data,
      tourData: { ...trip.parts.tour.data, itinerary: trip.parts.itinerary.data },
      tourCode: trip.parts.tour.data.tourCode, onNavigate() {}, onLogout() {}, isConnected };
  };
  const home = await renderPassengerTripHome(TourHomeScreen, displayProps(controller));
  assert.equal(controller.getState().parts.itinerary.persisted, true);
  const before = structuredClone(get(`bookings/${scope.bookingRef}`));
  const after = { ...before, pickupTime: '09:45', seatNumbers: ['14', '15'] };
  set(`bookings/${scope.bookingRef}`, after);
  await handlePassengerTripBookingSignal({ db, event: { params: { bookingRef: scope.bookingRef },
    data: { before: snapshot(before), after: snapshot(after) } } });
  signal('booking', get(`passenger_trip_signals/v1/bookings/${scope.bookingRef}/booking`));
  const scheduled = timer; timer = null; scheduled(); await flush();
  assert.equal(controller.getState().parts.booking.data.pickupTime, '09:45');
  await home.update(displayProps(controller));
  assert.match(home.text().join(' '), /09:45/u);
  assert.match(home.text().join(' '), /14/u);
  assert.deepEqual(requests[1], ['booking']);
  const oldPhone = get(`tours/${scope.tourId}/driverPhone`);
  set(`tours/${scope.tourId}/driverPhone`, '+44 7000 000099');
  set(`tours/${scope.tourId}/driverName`, 'Reassigned Driver');
  set(`tours/${scope.tourId}/driverAssignmentRevision`, 8);
  await handlePassengerTripTourSignal({ db, part: 'tour', event: { params: { tourId: scope.tourId },
    data: { before: snapshot(oldPhone), after: snapshot('+44 7000 000099') } } });
  const oldItinerary = get(`tours/${scope.tourId}/itinerary`);
  const newItinerary = { revision: 2, days: [{ day: 1, content: 'Revised published excursion' }] };
  set(`tours/${scope.tourId}/itinerary`, newItinerary);
  await handlePassengerTripTourSignal({ db, part: 'itinerary', event: { params: { tourId: scope.tourId },
    data: { before: snapshot(oldItinerary), after: snapshot(newItinerary) } } });
  signal('tour', get(`passenger_trip_signals/v1/tours/${scope.tourId}/tour`));
  signal('itinerary', get(`passenger_trip_signals/v1/tours/${scope.tourId}/itinerary`));
  const scheduledTour = timer; timer = null; scheduledTour(); await flush();
  const state = controller.getState();
  assert.equal(state.parts.tour.data.driverPhone, '+44 7000 000099');
  assert.equal(state.parts.itinerary.data.days[0].content, 'Revised published excursion');
  await home.update(displayProps(controller));
  assert.match(home.text().join(' '), /Revised published excursion/u);
  assert.deepEqual(requests[2], ['tour', 'itinerary']);
  assert.deepEqual(get(`app_sessions/${scope.authUid}`), session, 'content checks do not renew authentication');
  await home.unmount(); controller.stop();
  const restored = makeController(); await restored.ready;
  assert.equal(restored.getState().parts.itinerary.data.days[0].content, 'Revised published excursion');
  assert.equal(restored.getState().parts.booking.data.pickupTime, '09:45');
  assert.equal(restored.getState().parts.itinerary.status, 'saved');
  // First full-itinerary visit happens only after offline restoration.
  const offlineProps = displayProps(restored, false);
  const fullItinerary = await renderPassengerTripItinerary(ItineraryScreen, {
    passengerTrip: offlineProps.passengerTrip, tourId: scope.tourId, tourName: offlineProps.tourData.name,
    startDate: offlineProps.tourData.startDate, isDriver: false, offlineCacheOwnerId: scope.bookingRef, onBack() {},
  });
  assert.match(fullItinerary.text().join(' '), /Revised published excursion/u);
  assert.match(fullItinerary.text().join(' '), /Saved itinerary/u);
  assert.equal(nativeMocks.calls.itineraryFetch, 0); assert.equal(nativeMocks.calls.itineraryListener, 0);
  assert.equal(nativeMocks.calls.cacheWrite, 0);
  await fullItinerary.unmount(); nativeMocks.restore();
  // No new network request or subscription is needed for an offline screen visit.
  assert.equal(requests.length, 3); assert.equal(attaches, 2); assert.equal(detaches, 2);
  set(`users/${scope.authUid}/bookingRef`, 'OTHER');
  await assert.rejects(request({ parts: ['booking'], versions: {} }), /SESSION_SCOPE_MISMATCH/u);
  restored.stop();
  assert.ok(sizes[1] < sizes[0], 'booking-only response excludes the itinerary and summary');
  const rootReads = fixture.reads.filter((p) => ['bookings', 'tours', 'users', 'tour_manifests'].includes(p));
  assert.deepEqual(rootReads, []);
  console.log(JSON.stringify({ environment: 'in-process real domain handlers; synthetic DB; bearer injected',
    updateRequests: requests.slice(0, 3), responseBytes: sizes.slice(0, 3), signalAttaches: attaches, signalDetaches: detaches }));
});
