const { normalizeTourId } = require('./tourIdentityService');

const MAX_PICKUPS = 20;
const MAX_PASSENGERS = 100;
const MAX_ITINERARY_DAYS = 60;

const cleanString = (value, maxLength = 500) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

const cleanFiniteNumber = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const cleanStringOrNumber = (value, maxLength = 80) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return cleanString(value, maxLength);
};

const compact = (value) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
);

const normalizePassengerItinerary = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const daysInput = Array.isArray(value.days)
    ? value.days
    : (value.days && typeof value.days === 'object' ? Object.values(value.days) : []);
  const days = daysInput.slice(0, MAX_ITINERARY_DAYS).map((day, index) => {
    const activitiesInput = Array.isArray(day?.activities)
      ? day.activities
      : (day?.activities && typeof day.activities === 'object' ? Object.values(day.activities) : []);
    const activities = activitiesInput.slice(0, 50).map((activity) => compact({
      time: cleanString(activity?.time, 40),
      description: cleanString(activity?.description, 1000),
    })).filter((activity) => activity.description);

    return compact({
      day: Number.isInteger(day?.day) && day.day > 0 ? day.day : index + 1,
      title: cleanString(day?.title, 200),
      content: cleanString(day?.content, 12000),
      activities: activities.length ? activities : undefined,
    });
  });
  const warningsInput = Array.isArray(value.warnings)
    ? value.warnings
    : (value.warnings && typeof value.warnings === 'object' ? Object.values(value.warnings) : []);
  const warnings = warningsInput.slice(0, 20).map((warning) => cleanString(warning, 1000)).filter(Boolean);

  const itinerary = compact({
    title: cleanString(value.title, 200),
    days: days.length ? days : undefined,
    warnings: warnings.length ? warnings : undefined,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 1 ? value.revision : undefined,
    updatedAt: cleanFiniteNumber(value.updatedAt),
  });
  return Object.keys(itinerary).length ? itinerary : null;
};

const normalizePassengerPickup = (pickup, fallback = {}) => {
  if (!pickup || typeof pickup !== 'object' || Array.isArray(pickup)) return null;
  const normalized = compact({
    date: cleanString(pickup.date || pickup.pickupDate || fallback.date, 40),
    time: cleanString(pickup.time || pickup.pickupTime || fallback.time, 40),
    location: cleanString(pickup.location || pickup.pickupLocation || fallback.location, 250),
    address: cleanString(pickup.address || pickup.pickupAddress || fallback.address, 500),
  });
  return normalized.location || normalized.address || normalized.time || normalized.date ? normalized : null;
};

const normalizePassengerBookingProjection = (value, expectedBookingRef = '') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = cleanString(value.id || value.bookingRef, 100).toUpperCase();
  const expected = cleanString(expectedBookingRef, 100).toUpperCase();
  if (!id || (expected && id !== expected)) return null;

  const fallbackPickup = {
    date: value.pickupDate,
    time: value.pickupTime,
    location: value.pickupLocation,
    address: value.pickupAddress,
  };
  const pickupInput = Array.isArray(value.pickupPoints)
    ? value.pickupPoints
    : (value.pickupPoints && typeof value.pickupPoints === 'object' ? Object.values(value.pickupPoints) : []);
  const pickupPoints = pickupInput
    .slice(0, MAX_PICKUPS)
    .map((pickup) => normalizePassengerPickup(pickup, fallbackPickup))
    .filter(Boolean);
  if (!pickupPoints.length) {
    const fallback = normalizePassengerPickup(fallbackPickup, {});
    if (fallback) pickupPoints.push(fallback);
  }

  const passengerNames = (Array.isArray(value.passengerNames) ? value.passengerNames : [])
    .slice(0, MAX_PASSENGERS)
    .map((name) => cleanString(name, 160))
    .filter(Boolean);
  const seatNumbers = (Array.isArray(value.seatNumbers) ? value.seatNumbers : [])
    .slice(0, MAX_PASSENGERS)
    .map((seat) => cleanStringOrNumber(seat, 40))
    .filter((seat) => seat !== '');
  const primaryPickup = pickupPoints[0] || {};

  return compact({
    id,
    tourId: normalizeTourId(value.tourId) || undefined,
    tourCode: cleanString(value.tourCode, 100),
    passengerNames,
    seatNumbers,
    pickupPoints,
    pickupDate: cleanString(value.pickupDate || primaryPickup.date, 40),
    pickupTime: cleanString(value.pickupTime || primaryPickup.time, 40),
    pickupLocation: cleanString(value.pickupLocation || primaryPickup.location || primaryPickup.address, 250),
    totalPax: Number.isSafeInteger(value.totalPax) && value.totalPax >= 0
      ? value.totalPax
      : passengerNames.length,
  });
};

const normalizePassengerIdentityProjection = (value, expectedBookingRef = '') => {
  const booking = normalizePassengerBookingProjection(value, expectedBookingRef);
  if (!booking) return null;

  return compact({
    ...booking,
    normalizedPassengerEmail: cleanString(value.normalizedPassengerEmail, 320).toLowerCase(),
    stablePassengerId: cleanString(value.stablePassengerId, 500),
    identityVersion: cleanString(value.identityVersion, 80),
  });
};

const normalizePassengerTourProjection = (value, expectedTourId = '') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeTourId(value.id || value.tourId);
  const expected = normalizeTourId(expectedTourId);
  if (!id || (expected && id !== expected)) return null;

  return compact({
    id,
    name: cleanString(value.name, 200),
    tourCode: cleanString(value.tourCode, 100),
    destination: cleanString(value.destination, 200),
    startDate: cleanString(value.startDate, 40),
    endDate: cleanString(value.endDate, 40),
    duration: cleanStringOrNumber(value.duration, 40),
    isActive: value.isActive !== false,
    currentParticipants: Number.isSafeInteger(value.currentParticipants) && value.currentParticipants >= 0
      ? value.currentParticipants
      : 0,
    maxParticipants: Number.isSafeInteger(value.maxParticipants) && value.maxParticipants >= 0
      ? value.maxParticipants
      : undefined,
    driverName: cleanString(value.driverName, 160),
    driverPhone: cleanString(value.driverPhone, 80),
    itinerary: normalizePassengerItinerary(value.itinerary),
  });
};

const normalizePassengerTourPack = (value, { expectedTourId = '', expectedBookingRef = '' } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const tour = normalizePassengerTourProjection(value.tour, expectedTourId);
  const booking = normalizePassengerIdentityProjection(value.booking, expectedBookingRef);
  if (!tour || !booking) return null;

  const emergencyPhone = cleanString(value.safety?.emergencyPhone, 80);
  return compact({
    tour,
    booking,
    itinerary: normalizePassengerItinerary(value.itinerary),
    safety: emergencyPhone ? { emergencyPhone } : undefined,
    fetchedAt: cleanString(value.fetchedAt, 80),
    sourceVersion: cleanStringOrNumber(value.sourceVersion, 80),
  });
};

module.exports = {
  normalizePassengerBookingProjection,
  normalizePassengerIdentityProjection,
  normalizePassengerItinerary,
  normalizePassengerPickup,
  normalizePassengerTourPack,
  normalizePassengerTourProjection,
};
