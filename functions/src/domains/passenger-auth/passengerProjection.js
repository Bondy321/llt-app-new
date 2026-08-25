'use strict';

// @ts-check

const { normalizeManifestBooking } = require('../manifests/manifestDomain');
const { normalizeTourKeyForComparison } = require('../notifications/notificationPolicy');
const { cleanPassengerString } = require('./passengerSanitizer');

/** @type {(...args: any[]) => any} */
const compactDefined = (value = {}) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
);

/** @type {(...args: any[]) => any} */
const buildPassengerSafeItinerary = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceDays = Array.isArray(value.days)
    ? value.days
    : (value.days && typeof value.days === 'object' ? Object.values(value.days) : []);
  const days = sourceDays.slice(0, 60).map(/** @param {any} day @param {number} index */ (day, index) => {
    const sourceActivities = Array.isArray(day?.activities)
      ? day.activities
      : (day?.activities && typeof day.activities === 'object' ? Object.values(day.activities) : []);
    const activities = sourceActivities.slice(0, 50).map(/** @param {any} activity */ (activity) => compactDefined({
      time: cleanPassengerString(activity?.time, 40),
      description: cleanPassengerString(activity?.description, 1000),
    })).filter(/** @param {any} activity */ (activity) => activity.description);
    return compactDefined({
      day: Number.isInteger(day?.day) && day.day > 0 ? day.day : index + 1,
      title: cleanPassengerString(day?.title, 200),
      content: cleanPassengerString(day?.content, 12000),
      activities: activities.length ? activities : undefined,
    });
  });
  const sourceWarnings = Array.isArray(value.warnings)
    ? value.warnings
    : (value.warnings && typeof value.warnings === 'object' ? Object.values(value.warnings) : []);
  const warnings = sourceWarnings.slice(0, 20)
    .map(/** @param {unknown} warning */ (warning) => cleanPassengerString(warning, 1000))
    .filter(Boolean);

  const itinerary = compactDefined({
    title: cleanPassengerString(value.title, 200),
    days: days.length ? days : undefined,
    warnings: warnings.length ? warnings : undefined,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 1 ? value.revision : undefined,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : undefined,
  });
  return Object.keys(itinerary).length ? itinerary : null;
};

/** @type {(...args: any[]) => any} */
const buildPassengerSafePickup = (value = {}, fallback = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pickup = compactDefined({
    date: cleanPassengerString(value.date || value.pickupDate || fallback.date, 40),
    time: cleanPassengerString(value.time || value.pickupTime || fallback.time, 40),
    location: cleanPassengerString(value.location || value.pickupLocation || fallback.location, 250),
    address: cleanPassengerString(value.address || value.pickupAddress || fallback.address, 500),
  });
  return pickup.location || pickup.address || pickup.time || pickup.date ? pickup : null;
};

/** @type {(...args: any[]) => any} */
const buildPassengerSafeBooking = (bookingRef, bookingData = {}, tourId = '') => {
  const normalized = normalizeManifestBooking(bookingRef, bookingData);
  const fallbackPickup = {
    date: bookingData.pickupDate,
    time: bookingData.pickupTime,
    location: bookingData.pickupLocation,
    address: bookingData.pickupAddress,
  };
  const pickupPoints = (Array.isArray(normalized.pickupPoints) ? normalized.pickupPoints : [])
    .slice(0, 20)
    .map(/** @param {any} pickup */ (pickup) => buildPassengerSafePickup(pickup, fallbackPickup))
    .filter(Boolean);
  if (!pickupPoints.length) {
    const fallback = buildPassengerSafePickup(fallbackPickup);
    if (fallback) pickupPoints.push(fallback);
  }
  const passengerNames = normalized.passengerNames.slice(0, 100)
    .map(/** @param {unknown} name */ (name) => cleanPassengerString(name, 160))
    .filter(Boolean);
  const seatNumbers = normalized.seatNumbers.slice(0, 100).map(/** @param {unknown} seat */ (seat) => (
    typeof seat === 'number' && Number.isFinite(seat)
      ? seat
      : cleanPassengerString(seat, 40)
  )).filter(/** @param {unknown} seat */ (seat) => seat !== '');
  const primaryPickup = pickupPoints[0] || {};

  return compactDefined({
    id: bookingRef,
    tourId: normalizeTourKeyForComparison(tourId || bookingData.tourId) || undefined,
    tourCode: cleanPassengerString(bookingData.tourCode, 100),
    passengerNames,
    seatNumbers,
    pickupPoints,
    pickupDate: cleanPassengerString(bookingData.pickupDate || primaryPickup.date, 40),
    pickupTime: cleanPassengerString(bookingData.pickupTime || primaryPickup.time, 40),
    pickupLocation: cleanPassengerString(
      bookingData.pickupLocation || primaryPickup.location || primaryPickup.address,
      250,
    ),
    totalPax: Number.isSafeInteger(bookingData.totalPax) && bookingData.totalPax >= 0
      ? bookingData.totalPax
      : passengerNames.length,
  });
};

/** @type {(...args: any[]) => any} */
const buildPassengerSafeTour = (tourId, tourData = {}) => {
  const participantCount = Number.isSafeInteger(tourData.currentParticipants) && tourData.currentParticipants >= 0
    ? tourData.currentParticipants
    : Object.keys(tourData.participants || {}).length;
  return compactDefined({
    id: normalizeTourKeyForComparison(tourId),
    name: cleanPassengerString(tourData.name, 200),
    tourCode: cleanPassengerString(tourData.tourCode, 100),
    destination: cleanPassengerString(tourData.destination, 200),
    startDate: cleanPassengerString(tourData.startDate, 40),
    endDate: cleanPassengerString(tourData.endDate, 40),
    duration: typeof tourData.duration === 'number' && Number.isFinite(tourData.duration)
      ? tourData.duration
      : cleanPassengerString(tourData.duration, 40),
    isActive: tourData.isActive !== false,
    currentParticipants: participantCount,
    maxParticipants: Number.isSafeInteger(tourData.maxParticipants) && tourData.maxParticipants >= 0
      ? tourData.maxParticipants
      : undefined,
    driverName: cleanPassengerString(tourData.driverName, 160),
    driverPhone: cleanPassengerString(tourData.driverPhone, 80),
    itinerary: buildPassengerSafeItinerary(tourData.itinerary),
  });
};


module.exports = {
  buildPassengerSafeBooking,
  buildPassengerSafeItinerary,
  buildPassengerSafePickup,
  buildPassengerSafeTour,
  cleanPassengerString,
  compactDefined,
};
