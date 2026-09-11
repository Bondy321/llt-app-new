const {
  normalizePassengerBookingProjection, normalizePassengerTourProjection, normalizePassengerItinerary,
} = require('../passengerDataBoundary');
const { validateContract } = require('../../src/shared/contracts/generated/passengerTrip');

const PARTS = Object.freeze(['booking', 'tour', 'itinerary']);
const SCOPE_FIELDS = ['authUid', 'principalId', 'bookingRef', 'tourId', 'sessionId'];
const normalizeScope = (input) => {
  if (!validateContract('PassengerTripScope', input).valid) return null;
  if (!input || SCOPE_FIELDS.some((key) => typeof input[key] !== 'string'
    || !input[key] || input[key].length > 160 || /[.#$\/\[\]\u0000-\u001f]/u.test(input[key]))) return null;
  if (!/^pax_v2_[a-f0-9]{32}$/u.test(input.principalId)
    || !/^sess_v1_[a-f0-9]{32}$/u.test(input.sessionId)) return null;
  return Object.fromEntries(SCOPE_FIELDS.map((key) => [key, input[key]]));
};
const scopeKey = (scope) => JSON.stringify(normalizeScope(scope));
const sameScope = (a, b) => Boolean(normalizeScope(a) && scopeKey(a) === scopeKey(b));
const normalizePart = (name, data, scope) => {
  if (name === 'booking') {
    if (data?.tourId !== scope.tourId) return null;
    return normalizePassengerBookingProjection(data, scope.bookingRef);
  }
  if (name === 'tour') {
    const tour = normalizePassengerTourProjection(data, scope.tourId);
    if (tour) {
      delete tour.itinerary;
      if (!Number.isSafeInteger(data.currentParticipants)) delete tour.currentParticipants;
      if (typeof data.isActive !== 'boolean') delete tour.isActive;
    }
    return tour;
  }
  return normalizePassengerItinerary(data);
};
const versionValid = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const normalizeEnvelope = (value, scope) => {
  if (!validateContract('PassengerTripCache', value).valid || !sameScope(value.scope, scope)) return null;
  const parts = {};
  for (const name of PARTS) {
    const part = value.parts?.[name];
    if (!part) continue;
    if (part.data === undefined) continue;
    const data = normalizePart(name, part.data, scope);
    if (!data && !(name === 'itinerary' && part.data === null)) return null;
    parts[name] = { data, version: versionValid(part.version) ? part.version : null,
      checkedAtMs: Number.isSafeInteger(part.checkedAtMs) && part.checkedAtMs > 0 ? part.checkedAtMs : null };
  }
  return { schemaVersion: 1, scope: normalizeScope(scope), parts };
};
const seedEnvelope = (scope, booking, tour) => normalizeEnvelope({
  schemaVersion: 1, scope, parts: {
    booking: { data: { ...booking, tourId: scope.tourId } },
    tour: { data: tour }, itinerary: { data: normalizePassengerItinerary(tour?.itinerary) },
  },
}, scope);

module.exports = { PARTS, normalizeScope, scopeKey, sameScope, normalizePart, normalizeEnvelope, seedEnvelope, versionValid };
