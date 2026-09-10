'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const {
  buildPassengerSafeBooking,
  buildPassengerSafeItinerary,
  buildPassengerSafeTour,
} = require('../passenger-auth/public');
const { buildPassengerTripPart, PASSENGER_TRIP_SCHEMA_VERSION } = require('./passengerTripContract');

const TOUR_SUMMARY_LEAVES = Object.freeze([
  'name',
  'tourCode',
  'destination',
  'startDate',
  'endDate',
  'duration',
  'isActive',
  'currentParticipants',
  'maxParticipants',
  'driverName',
  'driverPhone',
  'driverAssignmentRevision',
]);

/** @param {string} code */
const passengerTripError = (code) => {
  const error = /** @type {Error & { code?: string }} */ (new Error(code));
  error.code = code;
  return error;
};

/** @param {any} db @param {string} path */
const readValue = async (db, path) => (await db.ref(path).once('value')).val();

/** @param {any} db @param {string} tourId */
const readTourSummaryLeaves = async (db, tourId) => {
  const values = await Promise.all(TOUR_SUMMARY_LEAVES.map((leaf) => readValue(db, `tours/${tourId}/${leaf}`)));
  return Object.fromEntries(TOUR_SUMMARY_LEAVES.map((leaf, index) => [leaf, values[index]]));
};

/** @param {any} tour */
const hasValidTourDates = (tour, parseDateOnly) => {
  const start = parseDateOnly(tour.startDate);
  const end = parseDateOnly(tour.endDate || tour.startDate);
  return start !== null && end !== null && end >= start;
};

/** @param {string} tourId @param {any} source */
const buildPassengerTripTour = (tourId, source) => {
  const projection = buildPassengerSafeTour(tourId, source);
  delete projection.itinerary;
  if (!Number.isSafeInteger(source.currentParticipants) || source.currentParticipants < 0) {
    delete projection.currentParticipants;
  }
  if (typeof source.isActive !== 'boolean') delete projection.isActive;
  return projection;
};

/**
 * Read assignment fields twice around the bounded public leaves. A revision
 * change means the contact could belong to two different assignments.
 */
const readConsistentTourSummary = async ({ db, tourId, parseDateOnly }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revisionBefore = await readValue(db, `tours/${tourId}/driverAssignmentRevision`);
    const source = await readTourSummaryLeaves(db, tourId);
    const revisionAfter = await readValue(db, `tours/${tourId}/driverAssignmentRevision`);
    if (revisionBefore !== revisionAfter || source.driverAssignmentRevision !== revisionAfter) continue;
    if (!hasValidTourDates(source, parseDateOnly)) throw passengerTripError('TOUR_DATES_INVALID');
    return buildPassengerTripTour(tourId, source);
  }
  throw passengerTripError('TOUR_ASSIGNMENT_UNAVAILABLE');
};

/**
 * Establish the immutable passenger scope before any conditional response.
 * The booking comes only from the server-owned profile, never from the body.
 */
const resolvePassengerTripAuthority = async ({
  db,
  authUid,
  access,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
}) => {
  await ensureNoActiveAccountDeletion({ db, authUid });
  const bookingRef = resolveTrimmedString(await readValue(db, `users/${authUid}/bookingRef`));
  if (!bookingRef || bookingRef.length > 160 || !isValidFirebaseKey(bookingRef)) {
    throw passengerTripError('SESSION_SCOPE_MISMATCH');
  }
  await ensureNoActivePassengerAccountDeletion({ db, bookingRef });

  const [authorizedAuthUid, passengerPrincipalId, identityVersion, loginLocked, booking] = await Promise.all([
    readValue(db, `passenger_identity_security/${bookingRef}/authorizedAuthUid`),
    readValue(db, `passenger_identity_security/${bookingRef}/passengerPrincipalId`),
    readValue(db, `passenger_identity_security/${bookingRef}/passengerIdentityVersion`),
    readValue(db, `passenger_identity_security/${bookingRef}/loginLocked`),
    readValue(db, `bookings/${bookingRef}`),
  ]);
  if (authorizedAuthUid !== authUid || passengerPrincipalId !== access.principalId
    || identityVersion !== 'pax_v2' || loginLocked === true) {
    throw passengerTripError('SESSION_SCOPE_MISMATCH');
  }
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) {
    throw passengerTripError('TRIP_SOURCE_MISSING');
  }
  const tourId = normalizeTourKeyForComparison(access.tourId);
  if (!tourId || normalizeTourKeyForComparison(booking.tourId) !== tourId) {
    throw passengerTripError('SESSION_SCOPE_MISMATCH');
  }
  const tourCode = await readValue(db, `tours/${tourId}/tourCode`);
  if (!tourCode || normalizeTourKeyForComparison(tourCode) !== tourId) {
    throw passengerTripError('TRIP_SOURCE_MISSING');
  }

  await Promise.all([
    ensureNoActiveAccountDeletion({ db, authUid }),
    ensureNoActivePassengerAccountDeletion({ db, bookingRef }),
  ]);
  return {
    booking,
    scope: {
      authUid,
      principalId: access.principalId,
      bookingRef,
      tourId,
      sessionId: access.session.sessionId,
    },
  };
};

const ensurePassengerTripAuthorityStillCurrent = async ({
  db,
  authUid,
  scope,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
}) => {
  const [profileBookingRef, authorizedAuthUid, passengerPrincipalId, identityVersion,
    loginLocked, bookingTourId, tourCode] = await Promise.all([
    readValue(db, `users/${authUid}/bookingRef`),
    readValue(db, `passenger_identity_security/${scope.bookingRef}/authorizedAuthUid`),
    readValue(db, `passenger_identity_security/${scope.bookingRef}/passengerPrincipalId`),
    readValue(db, `passenger_identity_security/${scope.bookingRef}/passengerIdentityVersion`),
    readValue(db, `passenger_identity_security/${scope.bookingRef}/loginLocked`),
    readValue(db, `bookings/${scope.bookingRef}/tourId`),
    readValue(db, `tours/${scope.tourId}/tourCode`),
    ensureNoActiveAccountDeletion({ db, authUid }),
    ensureNoActivePassengerAccountDeletion({ db, bookingRef: scope.bookingRef }),
  ]);
  if (profileBookingRef !== scope.bookingRef || authorizedAuthUid !== authUid
    || passengerPrincipalId !== scope.principalId || identityVersion !== 'pax_v2'
    || loginLocked === true || normalizeTourKeyForComparison(bookingTourId) !== scope.tourId) {
    throw passengerTripError('SESSION_SCOPE_MISMATCH');
  }
  if (!tourCode || normalizeTourKeyForComparison(tourCode) !== scope.tourId) {
    throw passengerTripError('TRIP_SOURCE_MISSING');
  }
};

const readPassengerTripSnapshot = async ({
  db,
  authUid,
  access,
  request,
  nowMs,
  parseDateOnly,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
}) => {
  const authority = await resolvePassengerTripAuthority({
    db,
    authUid,
    access,
    ensureNoActiveAccountDeletion,
    ensureNoActivePassengerAccountDeletion,
  });
  const { booking, scope } = authority;
  const reads = request.parts.map(async (part) => {
    if (part === 'booking') return buildPassengerSafeBooking(scope.bookingRef, booking, scope.tourId);
    if (part === 'tour') return readConsistentTourSummary({ db, tourId: scope.tourId, parseDateOnly });
    const itinerary = await readValue(db, `tours/${scope.tourId}/itinerary`);
    return buildPassengerSafeItinerary(itinerary);
  });
  const settled = await Promise.allSettled(reads);
  const parts = {};
  request.parts.forEach((part, index) => {
    const result = settled[index];
    parts[part] = result.status === 'fulfilled'
      ? buildPassengerTripPart(part, result.value, request.versions)
      : { status: 'unavailable' };
  });
  await ensurePassengerTripAuthorityStillCurrent({
    db,
    authUid,
    scope,
    ensureNoActiveAccountDeletion,
    ensureNoActivePassengerAccountDeletion,
  });
  return {
    schemaVersion: PASSENGER_TRIP_SCHEMA_VERSION,
    scope,
    checkedAtMs: nowMs,
    parts,
  };
};

module.exports = {
  TOUR_SUMMARY_LEAVES,
  buildPassengerTripTour,
  hasValidTourDates,
  ensurePassengerTripAuthorityStillCurrent,
  passengerTripError,
  readConsistentTourSummary,
  readPassengerTripSnapshot,
  readTourSummaryLeaves,
  resolvePassengerTripAuthority,
};
