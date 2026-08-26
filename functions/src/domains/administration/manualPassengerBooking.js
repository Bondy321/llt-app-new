'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { normalizeBookingRef, normalizeEmail } = require('../../infrastructure/validation/passengerNormalization');

const MANIFEST_STATUS = Object.freeze({
  PENDING: 'PENDING', BOARDED: 'BOARDED', NO_SHOW: 'NO_SHOW', PARTIAL: 'PARTIAL',
});

/** @type {(...args: any[]) => any} */
const createManualPassengerError = (code, message) => {
  const error = /** @type {Error & { code?: string }} */ (new Error(message || code));
  error.code = code;
  return error;
};

/** @type {(...args: any[]) => any} */
const parseStrictDateOnly = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const ukMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const match = ukMatch || isoMatch;
  if (!match) return null;

  const year = Number(ukMatch ? match[3] : match[1]);
  const month = Number(match[2]);
  const day = Number(ukMatch ? match[1] : match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    date,
    iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    uk: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).padStart(4, '0')}`,
  };
};

/** @param {any} input */
const validateManualBookingIdentity = ({ tourId, tourCode, bookingRef, tourData }) => {
  if (!tourId || !isValidFirebaseKey(tourId)) {
    throw createManualPassengerError('INVALID_TOUR', 'Select a valid tour.');
  }
  if (!tourCode || normalizeTourKeyForComparison(tourCode) !== tourId) {
    throw createManualPassengerError('TOUR_IDENTITY_MISMATCH', 'The selected tour has inconsistent identity data.');
  }
  if (tourData.isActive === false) {
    throw createManualPassengerError('TOUR_INACTIVE', 'Passengers cannot be added to an inactive tour.');
  }
  if (!bookingRef || bookingRef.length > 64 || bookingRef.startsWith('D-')
    || !/^[A-Z0-9_-]+$/u.test(bookingRef) || !isValidFirebaseKey(bookingRef)) {
    throw createManualPassengerError(
      'INVALID_BOOKING_REFERENCE',
      'Booking reference must use letters, numbers, hyphens, or underscores.',
    );
  }
};

/** @param {any} input */
const validateManualPickupFields = ({ email, pickupDate, pickupTime, pickupLocation, rawPassengers }) => {
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw createManualPassengerError('INVALID_EMAIL', 'Enter a valid passenger email address.');
  }
  if (!pickupDate) throw createManualPassengerError('INVALID_PICKUP_DATE', 'Pickup date must be a valid date.');
  if (!pickupTime || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(pickupTime)) {
    throw createManualPassengerError('INVALID_PICKUP_TIME', 'Pickup time must use 24-hour HH:mm format.');
  }
  if (!pickupLocation || pickupLocation.length < 3 || pickupLocation.length > 250) {
    throw createManualPassengerError(
      'INVALID_PICKUP_LOCATION',
      'Pickup location must be between 3 and 250 characters.',
    );
  }
  if (rawPassengers.length < 1 || rawPassengers.length > 53) {
    throw createManualPassengerError('INVALID_PASSENGERS', 'A booking must contain between 1 and 53 passengers.');
  }
};

/** @param {any} input */
const validateManualPickupDateRange = ({ pickupDate, tourData }) => {
  const tourStart = parseStrictDateOnly(tourData.startDate);
  const tourEnd = parseStrictDateOnly(tourData.endDate || tourData.startDate);
  if (!tourStart || !tourEnd) {
    throw createManualPassengerError('TOUR_DATES_INVALID', 'The selected tour must have valid start and end dates.');
  }
  if (pickupDate.date.getTime() < tourStart.date.getTime()
    || pickupDate.date.getTime() > tourEnd.date.getTime()) {
    throw createManualPassengerError(
      'PICKUP_DATE_OUTSIDE_TOUR',
      'Pickup date must fall within the selected tour dates.',
    );
  }
};

/** @param {any} passenger @param {number} index @param {number} maxParticipants @param {Set<number>} seenSeats */
const normalizeManualPassenger = (passenger, index, maxParticipants, seenSeats) => {
  const name = resolveTrimmedString(passenger?.name);
  const phone = resolveTrimmedString(passenger?.phone);
  const seatNumber = Number(passenger?.seatNumber);
  if (!name || name.length < 2 || name.length > 120) {
    throw createManualPassengerError(
      'INVALID_PASSENGER_NAME',
      `Passenger ${index + 1} must have a full name between 2 and 120 characters.`,
    );
  }
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > maxParticipants) {
    throw createManualPassengerError(
      'INVALID_SEAT_NUMBER',
      `Passenger ${index + 1} must have a seat between 1 and ${maxParticipants}.`,
    );
  }
  if (seenSeats.has(seatNumber)) {
    throw createManualPassengerError(
      'DUPLICATE_SEAT_IN_BOOKING',
      `Seat ${seatNumber} is assigned more than once in this booking.`,
    );
  }
  if (!phone || phone.length > 40 || !/^[+()\d\s-]+$/u.test(phone)
    || (phone.match(/\d/gu) || []).length < 7) {
    throw createManualPassengerError(
      'INVALID_PHONE',
      `Passenger ${index + 1} must have a valid phone number.`,
    );
  }
  seenSeats.add(seatNumber);
  return { name, phone, seatNumber, seatLabel: `S${seatNumber}` };
};

/** @type {(...args: any[]) => any} */
const normalizeManualPassengerPayload = (payload = {}, tourData = {}) => {
  const tourId = normalizeTourKeyForComparison(payload.tourId);
  const tourCode = resolveTrimmedString(tourData.tourCode);
  const bookingRef = normalizeBookingRef(payload.bookingRef);
  const email = normalizeEmail(payload.email);
  const pickupDate = parseStrictDateOnly(payload.pickupDate);
  const pickupTime = resolveTrimmedString(payload.pickupTime);
  const pickupLocation = resolveTrimmedString(payload.pickupLocation);
  const rawPassengers = Array.isArray(payload.passengers) ? payload.passengers : [];

  validateManualBookingIdentity({ tourId, tourCode, bookingRef, tourData });
  validateManualPickupFields({ email, pickupDate, pickupTime, pickupLocation, rawPassengers });
  validateManualPickupDateRange({ pickupDate, tourData });

  const maxParticipants = Number.isInteger(tourData.maxParticipants) && tourData.maxParticipants > 0
    ? tourData.maxParticipants
    : 53;
  const seenSeats = new Set();
  const passengers = rawPassengers.map(/** @param {any} passenger @param {number} index */ (passenger, index) => (
    normalizeManualPassenger(passenger, index, maxParticipants, seenSeats)
  ));

  return {
    tourId,
    tourCode,
    bookingRef,
    email,
    pickupDate: pickupDate.uk,
    pickupDateISO: pickupDate.iso,
    pickupTime,
    pickupLocation,
    passengers,
  };
};

/** @type {(...args: any[]) => any} */
const getBookingPassengerCount = (booking = {}) => {
  if (Array.isArray(booking.passengerDetails)) return booking.passengerDetails.length;
  if (Array.isArray(booking.passengerNames)) return booking.passengerNames.length;
  if (Array.isArray(booking.passengers)) return booking.passengers.length;
  return 0;
};

/** @type {(...args: any[]) => any} */
const getBookingSeatNumbers = (booking = {}) => {
  const seats = new Set();
  if (Array.isArray(booking.seatNumbers)) {
    booking.seatNumbers.forEach(/** @param {unknown} seat */ (seat) => {
      const numericSeat = Number(seat);
      if (Number.isInteger(numericSeat) && numericSeat > 0) seats.add(numericSeat);
    });
  }
  if (Array.isArray(booking.passengerDetails)) {
    booking.passengerDetails.forEach(/** @param {any} passenger */ (passenger) => {
      const numericSeat = Number(passenger?.seatNo);
      if (Number.isInteger(numericSeat) && numericSeat > 0) seats.add(numericSeat);
    });
  }
  return seats;
};

/** @type {(...args: any[]) => any} */
const findManualPassengerSeatConflicts = (bookings = {}, requestedPassengers = []) => {
  const occupiedSeats = new Set();
  Object.values(bookings || {}).forEach((booking) => {
    getBookingSeatNumbers(booking).forEach(/** @param {number} seat */ (seat) => occupiedSeats.add(seat));
  });
  return requestedPassengers
    .map(/** @param {any} passenger */ (passenger) => passenger.seatNumber)
    .filter(/** @param {number} seatNumber */ (seatNumber) => occupiedSeats.has(seatNumber));
};

/** @type {(...args: any[]) => any} */
const mergePickupPoint = (existingPoints, pickupPoint) => {
  const points = Array.isArray(existingPoints)
    ? existingPoints.filter((point) => point && typeof point === 'object')
    : [];
  const alreadyExists = points.some((point) => (
    point.date === pickupPoint.date
    && point.time === pickupPoint.time
    && point.location === pickupPoint.location
  ));
  return alreadyExists ? points : [...points, pickupPoint];
};

/** @type {(...args: any[]) => any} */
const buildManualPassengerBookingUpdates = ({
  normalized,
  actorUid,
  tourData,
  existingTourBookings = {},
  existingTopLevelPickupPoints = [],
  nowIso = new Date().toISOString(),
  idempotencyKey = `manual-create:${randomUUID()}`,
}) => {
  const pickupPoint = {
    date: normalized.pickupDate,
    time: normalized.pickupTime,
    location: normalized.pickupLocation,
  };
  const passengerDetails = normalized.passengers.map(/** @param {any} passenger */ (passenger) => ({
    name: passenger.name,
    bookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    seatLabel: passenger.seatLabel,
    seatNo: passenger.seatNumber,
    pickupPoint,
    pickupDate: normalized.pickupDate,
    phone: passenger.phone,
  }));
  const passengerNames = normalized.passengers.map(/** @param {any} passenger */ (passenger) => passenger.name);
  const seatNumbers = normalized.passengers.map(/** @param {any} passenger */ (passenger) => passenger.seatNumber);
  const seatLabels = normalized.passengers.map(/** @param {any} passenger */ (passenger) => passenger.seatLabel);
  const existingPassengerCount = Object.values(existingTourBookings || {})
    .reduce((total, booking) => total + getBookingPassengerCount(booking), 0);
  const totalPassengerCount = existingPassengerCount + passengerNames.length;
  const maxParticipants = Number.isInteger(tourData?.maxParticipants) && tourData.maxParticipants > 0
    ? tourData.maxParticipants
    : 53;
  if (totalPassengerCount > maxParticipants) {
    throw createManualPassengerError(
      'TOUR_CAPACITY_EXCEEDED',
      `This booking would exceed the tour capacity of ${maxParticipants}.`,
    );
  }

  const booking = {
    bookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    passengerNames,
    passengers: passengerNames,
    passengerDetails,
    pickupPoints: [pickupPoint],
    seatNumbers,
    seatLabels,
    pickupDate: normalized.pickupDate,
    pickupTime: normalized.pickupTime,
    pickupLocation: normalized.pickupLocation,
    source: 'web-admin-manual',
    createdAt: nowIso,
    createdBy: actorUid,
  };
  const identity = {
    bookingRef: normalized.bookingRef,
    normalizedBookingRef: normalized.bookingRef,
    tourId: normalized.tourId,
    tourCode: normalized.tourCode,
    email: normalized.email,
    normalizedEmail: normalized.email,
  };
  const manifest = {
    status: MANIFEST_STATUS.PENDING,
    passengerStatus: passengerNames.map(() => MANIFEST_STATUS.PENDING),
    lastUpdated: nowIso,
    idempotencyKey,
  };

  return {
    booking,
    identity,
    manifest,
    totalPassengerCount,
    updates: {
      [`bookings/${normalized.bookingRef}`]: booking,
      [`booking_identities/${normalized.bookingRef}`]: identity,
      [`tour_manifests/${normalized.tourId}/bookings/${normalized.bookingRef}`]: manifest,
      [`tours/${normalized.tourId}/pickupPoints`]: mergePickupPoint(tourData.pickupPoints, pickupPoint),
      [`pickupPoints/${normalized.tourId}`]: mergePickupPoint(existingTopLevelPickupPoints, pickupPoint),
      [`tours/${normalized.tourId}/currentParticipants`]: totalPassengerCount,
      [`tours/${normalized.tourId}/bookedPassengerCount`]: totalPassengerCount,
      [`tours/${normalized.tourId}/manifestPassengerCount`]: totalPassengerCount,
    },
  };

};


module.exports = {
  buildManualPassengerBookingUpdates,
  createManualPassengerError,
  findManualPassengerSeatConflicts,
  getBookingPassengerCount,
  getBookingSeatNumbers,
  mergePickupPoint,
  normalizeBookingRef,
  normalizeEmail,
  normalizeManualPassengerPayload,
  parseStrictDateOnly,
};
