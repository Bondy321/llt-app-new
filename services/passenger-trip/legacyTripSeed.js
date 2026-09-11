const { normalizePassengerTourPack, normalizePassengerItinerary } = require('../passengerDataBoundary');
const { normalizeEnvelope } = require('./tripBoundary');

// Old screen and login writers could disagree. Comparable published revisions
// choose content; neither a local migration time nor a pack timestamp proves it current.
const chooseLegacyItinerary = (nested, topLevel) => {
  const nestedSafe = normalizePassengerItinerary(nested);
  const topSafe = normalizePassengerItinerary(topLevel);
  if (!nestedSafe) return topSafe;
  if (!topSafe) return nestedSafe;
  if (Number.isSafeInteger(nestedSafe.revision) && Number.isSafeInteger(topSafe.revision)
    && topSafe.revision > nestedSafe.revision) return topSafe;
  return nestedSafe;
};
const migrateLegacyTripSeed = (scope, seed, legacy) => {
  const safeSeed = normalizeEnvelope(seed, scope);
  if (!safeSeed || legacy?.booking?.stablePassengerId !== scope.principalId) return safeSeed;
  const pack = normalizePassengerTourPack(legacy, { expectedTourId: scope.tourId, expectedBookingRef: scope.bookingRef });
  if (!pack || (pack.booking.tourId && pack.booking.tourId !== scope.tourId)) return safeSeed;
  const candidate = chooseLegacyItinerary(pack.tour.itinerary, pack.itinerary);
  const data = chooseLegacyItinerary(safeSeed.parts.itinerary?.data, candidate);
  return { ...safeSeed, parts: { ...safeSeed.parts, itinerary: { data, version: null, checkedAtMs: null } } };
};
const readLegacyTripSeed = async (scope, seed) => {
  const offline = require('../offlineSyncService');
  const result = await offline.getTourPack(scope.tourId, 'passenger', { ownerId: scope.bookingRef });
  return migrateLegacyTripSeed(scope, seed, result?.success ? result.data : null);
};
module.exports = { chooseLegacyItinerary, migrateLegacyTripSeed, readLegacyTripSeed };
