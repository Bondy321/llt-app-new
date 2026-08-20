'use strict';

const { createHash } = require('crypto');

const DRIVER_TOUR_PACK_SCHEMA_VERSION = 1;
const DRIVER_TOUR_PACK_CONTRACT_ID = 'driver-tour-pack/v1/2026-08-20';
const DRIVER_TOUR_PACK_READABLE_SCHEMA_VERSIONS = Object.freeze([1]);
const DRIVER_TOUR_PACK_STATUSES = Object.freeze(['active', 'cancelled', 'withdrawn']);
const DRIVER_TOUR_PACK_LIMITS = Object.freeze({
  maxPassengers: 100,
  maxSeats: 120,
  maxPickups: 60,
  maxTimelineEvents: 250,
  maxHotels: 30,
  maxServices: 150,
  maxCoachDetails: 20,
  maxBookingLeadContacts: 100,
  maxOperationalContacts: 100,
  maxItineraryStringLength: 24_000,
});

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'departureKey', 'tourId', 'tourCode', 'dateISO', 'status',
  'sourceSnapshotDate', 'generatedAtMs', 'publishedAtMs', 'revision',
  'contentFingerprint', 'expiresAtMs', 'coverage', 'quality', 'tour',
  'pickups', 'passengers', 'seats', 'timeline', 'hotels', 'services',
  'coach', 'contacts', 'itineraries',
]);
const COVERAGE_KEYS = Object.freeze([
  'tourSummary', 'paxByDepPoint', 'tourPax', 'tourContract', 'hotelInfo', 'tourItinerary',
]);
const QUALITY_KEYS = Object.freeze([
  'state', 'matched', 'tourPaxOnly', 'paxOnly', 'conflicts',
  'duplicateTourPaxSeats', 'duplicatePaxSeats', 'unseated', 'layoutAnomalies',
  'missingReports', 'suppressSeatMap', 'pickupManifestPublishable',
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_FIELD_PATTERN = /(?:^|_)(?:email|sales?|profit|margin|price|gmail|message_id|attachment_id|raw_metadata|internal_notes?)(?:_|$)/i;
const EMAIL_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

class DriverTourPackValidationError extends Error {
  constructor(errors) {
    super(`Driver Tour Pack validation failed: ${errors.join('; ')}`);
    this.name = 'DriverTourPackValidationError';
    this.code = 'DRIVER_TOUR_PACK_INVALID';
    this.errors = errors;
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, '$'));
}

function computeDriverTourPackContentFingerprint(pack) {
  const content = selectOperationalContent(pack);
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}

function validateDriverTourPack(pack) {
  const errors = [];
  exactObject(pack, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS, '$', errors);
  if (!isObject(pack)) return { valid: false, errors };

  equal(pack.schemaVersion, DRIVER_TOUR_PACK_SCHEMA_VERSION, '$.schemaVersion', errors);
  firebaseKey(pack.departureKey, '$.departureKey', 180, errors);
  firebaseKey(pack.tourId, '$.tourId', 100, errors);
  boundedString(pack.tourCode, '$.tourCode', 100, errors, true);
  dateString(pack.dateISO, '$.dateISO', errors);
  if (`${pack.dateISO}::${pack.tourId}` !== pack.departureKey) {
    errors.push('$.departureKey must equal dateISO::tourId.');
  }
  enumValue(pack.status, DRIVER_TOUR_PACK_STATUSES, '$.status', errors);
  dateString(pack.sourceSnapshotDate, '$.sourceSnapshotDate', errors);
  nonNegativeInteger(pack.generatedAtMs, '$.generatedAtMs', errors);
  nonNegativeInteger(pack.publishedAtMs, '$.publishedAtMs', errors);
  positiveInteger(pack.revision, '$.revision', errors);
  boundedString(pack.contentFingerprint, '$.contentFingerprint', 71, errors, true);
  if (typeof pack.contentFingerprint === 'string' && !FINGERPRINT_PATTERN.test(pack.contentFingerprint)) {
    errors.push('$.contentFingerprint must be a lowercase SHA-256 fingerprint.');
  }
  nonNegativeInteger(pack.expiresAtMs, '$.expiresAtMs', errors);
  validateCoverage(pack.coverage, errors);
  validateQuality(pack.quality, errors);
  validateTour(pack.tour, pack.status, errors);
  validateRecord(pack.pickups, DRIVER_TOUR_PACK_LIMITS.maxPickups, '$.pickups', errors, validatePickup);
  validateRecord(pack.passengers, DRIVER_TOUR_PACK_LIMITS.maxPassengers, '$.passengers', errors, validatePassenger);
  validateRecord(pack.seats, DRIVER_TOUR_PACK_LIMITS.maxSeats, '$.seats', errors, validateSeat);
  validateRecord(pack.timeline, DRIVER_TOUR_PACK_LIMITS.maxTimelineEvents, '$.timeline', errors, validateTimelineEvent);
  validateRecord(pack.hotels, DRIVER_TOUR_PACK_LIMITS.maxHotels, '$.hotels', errors, validateHotel);
  validateRecord(pack.services, DRIVER_TOUR_PACK_LIMITS.maxServices, '$.services', errors, validateService);
  validateCoach(pack.coach, errors);
  validateContacts(pack.contacts, errors);
  validateItineraries(pack.itineraries, errors);
  validateRelationships(pack, errors);

  if (pack.status !== 'active') {
    ['pickups', 'passengers', 'seats', 'timeline', 'hotels', 'services'].forEach((field) => {
      if (isObject(pack[field]) && Object.keys(pack[field]).length) {
        errors.push(`$.${field} must be empty for a tombstone.`);
      }
    });
  }
  inspectPrivacy(pack, '$', errors);
  if (FINGERPRINT_PATTERN.test(String(pack.contentFingerprint || ''))) {
    try {
      if (pack.contentFingerprint !== computeDriverTourPackContentFingerprint(pack)) {
        errors.push('$.contentFingerprint does not match operational content.');
      }
    } catch (error) {
      errors.push(`$.contentFingerprint could not be recomputed: ${error.message}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateRelationships(pack, errors) {
  if (![pack.pickups, pack.passengers, pack.seats, pack.coach, pack.contacts].every(isObject)) return;
  const bookingLeads = isObject(pack.contacts.bookingLeads) ? pack.contacts.bookingLeads : {};
  const pickupPassengerCounts = new Map();
  const pickupBookingRefs = new Map();

  Object.entries(pack.passengers).forEach(([passengerKey, passenger]) => {
    if (!isObject(passenger)) return;
    if (passenger.pickupId) {
      if (!Object.hasOwn(pack.pickups, passenger.pickupId)) {
        errors.push(`$.passengers.${passengerKey}.pickupId does not reference an existing pickup.`);
      } else {
        pickupPassengerCounts.set(passenger.pickupId, (pickupPassengerCounts.get(passenger.pickupId) || 0) + 1);
        if (passenger.bookingRef) {
          if (!pickupBookingRefs.has(passenger.pickupId)) pickupBookingRefs.set(passenger.pickupId, new Set());
          pickupBookingRefs.get(passenger.pickupId).add(passenger.bookingRef);
        }
      }
    }
    if (passenger.bookingLeadContactId) {
      const contact = bookingLeads[passenger.bookingLeadContactId];
      if (!isObject(contact)) {
        errors.push(`$.passengers.${passengerKey}.bookingLeadContactId does not reference an existing booking lead.`);
      } else if (contact.bookingRef !== passenger.bookingRef) {
        errors.push(`$.passengers.${passengerKey}.bookingLeadContactId references a different booking.`);
      }
    }
  });

  Object.entries(pack.pickups).forEach(([pickupId, pickup]) => {
    if (!isObject(pickup)) return;
    const passengerCount = pickupPassengerCounts.get(pickupId) || 0;
    const bookingCount = pickupBookingRefs.get(pickupId)?.size || 0;
    if (pickup.passengerCount !== passengerCount) errors.push(`$.pickups.${pickupId}.passengerCount does not match referenced passengers.`);
    if (pickup.bookingCount !== bookingCount) errors.push(`$.pickups.${pickupId}.bookingCount does not match referenced bookings.`);
  });

  Object.entries(pack.seats).forEach(([seatId, seat]) => {
    if (!isObject(seat)) return;
    const passenger = seat.passengerKey ? pack.passengers[seat.passengerKey] : null;
    if (seat.passengerKey && !isObject(passenger)) {
      errors.push(`$.seats.${seatId}.passengerKey does not reference an existing passenger.`);
    }
    if (isObject(passenger) && passenger.seatLabel !== seat.label) {
      errors.push(`$.seats.${seatId}.passengerKey references a passenger with a different seat label.`);
    }
    if (['empty', 'blocked'].includes(seat.state) && seat.passengerKey) {
      errors.push(`$.seats.${seatId}.passengerKey must be empty for a ${seat.state} seat.`);
    }
  });

  if (Number.isSafeInteger(pack.coach.layoutSeatCount) && pack.coach.layoutSeatCount !== Object.keys(pack.seats).length) {
    errors.push('$.coach.layoutSeatCount must equal the number of projected seats.');
  }
  if (pack.coach.seatMapAvailable === false && Object.keys(pack.seats).length) {
    errors.push('$.seats must be empty when the seat map is unavailable.');
  }
  if (pack.coach.seatMapAvailable === true && pack.quality?.suppressSeatMap === true) {
    errors.push('$.coach.seatMapAvailable must be false when quality suppresses the seat map.');
  }
}

function assertValidDriverTourPack(pack) {
  const result = validateDriverTourPack(pack);
  if (!result.valid) throw new DriverTourPackValidationError(result.errors);
  return pack;
}

function validateCoverage(value, errors) {
  exactObject(value, COVERAGE_KEYS, COVERAGE_KEYS, '$.coverage', errors);
  if (isObject(value)) COVERAGE_KEYS.forEach((key) => booleanValue(value[key], `$.coverage.${key}`, errors));
}

function validateQuality(value, errors) {
  exactObject(value, QUALITY_KEYS, QUALITY_KEYS, '$.quality', errors);
  if (!isObject(value)) return;
  enumValue(value.state, ['complete', 'degraded'], '$.quality.state', errors);
  QUALITY_KEYS.filter((key) => !['state', 'suppressSeatMap', 'pickupManifestPublishable'].includes(key))
    .forEach((key) => nonNegativeInteger(value[key], `$.quality.${key}`, errors));
  booleanValue(value.suppressSeatMap, '$.quality.suppressSeatMap', errors);
  booleanValue(value.pickupManifestPublishable, '$.quality.pickupManifestPublishable', errors);
}

function validateTour(value, status, errors) {
  const keys = ['name', 'destination', 'routeCode', 'endDateISO', 'days', 'status'];
  exactObject(value, keys, keys, '$.tour', errors);
  if (!isObject(value)) return;
  boundedString(value.name, '$.tour.name', 240, errors);
  boundedString(value.destination, '$.tour.destination', 240, errors);
  boundedString(value.routeCode, '$.tour.routeCode', 120, errors);
  dateString(value.endDateISO, '$.tour.endDateISO', errors);
  positiveInteger(value.days, '$.tour.days', errors);
  equal(value.status, status, '$.tour.status', errors);
}

function validatePickup(value, key, path, errors) {
  const keys = ['pickupId', 'dateISO', 'time', 'name', 'address', 'passengerCount', 'bookingCount', 'sequence'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.pickupId, key, `${path}.pickupId`, errors);
  dateString(value.dateISO, `${path}.dateISO`, errors);
  boundedString(value.time, `${path}.time`, 40, errors);
  boundedString(value.name, `${path}.name`, 300, errors, true);
  boundedString(value.address, `${path}.address`, 600, errors);
  nonNegativeInteger(value.passengerCount, `${path}.passengerCount`, errors);
  nonNegativeInteger(value.bookingCount, `${path}.bookingCount`, errors);
  nonNegativeInteger(value.sequence, `${path}.sequence`, errors);
}

function validatePassenger(value, key, path, errors) {
  const keys = ['passengerKey', 'name', 'bookingRef', 'seatLabel', 'pickupId', 'bookingLeadContactId', 'sourceState', 'note'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.passengerKey, key, `${path}.passengerKey`, errors);
  boundedString(value.name, `${path}.name`, 200, errors, true);
  boundedString(value.bookingRef, `${path}.bookingRef`, 100, errors);
  boundedString(value.seatLabel, `${path}.seatLabel`, 40, errors);
  boundedString(value.pickupId, `${path}.pickupId`, 80, errors);
  boundedString(value.bookingLeadContactId, `${path}.bookingLeadContactId`, 80, errors);
  enumValue(value.sourceState, ['MATCHED', 'TOUR_PAX_ONLY_OCCUPIED', 'PAX_ONLY', 'OCCUPANT_CONFLICT', 'UNSEATED_PAX'], `${path}.sourceState`, errors);
  boundedString(value.note, `${path}.note`, 300, errors);
}

function validateSeat(value, key, path, errors) {
  const keys = ['seatId', 'label', 'state', 'passengerKey'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.seatId, key, `${path}.seatId`, errors);
  boundedString(value.label, `${path}.label`, 40, errors, true);
  enumValue(value.state, ['empty', 'occupied', 'unmatched', 'blocked', 'conflict'], `${path}.state`, errors);
  boundedString(value.passengerKey, `${path}.passengerKey`, 80, errors);
}

function validateTimelineEvent(value, key, path, errors) {
  const keys = ['eventId', 'type', 'dateISO', 'time', 'title', 'subtitle', 'reference', 'notes', 'sequence'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.eventId, key, `${path}.eventId`, errors);
  enumValue(value.type, ['pickup', 'hotel', 'service', 'coach'], `${path}.type`, errors);
  dateString(value.dateISO, `${path}.dateISO`, errors);
  boundedString(value.time, `${path}.time`, 40, errors);
  boundedString(value.title, `${path}.title`, 300, errors, true);
  boundedString(value.subtitle, `${path}.subtitle`, 600, errors);
  boundedString(value.reference, `${path}.reference`, 160, errors);
  boundedString(value.notes, `${path}.notes`, 2_000, errors);
  nonNegativeInteger(value.sequence, `${path}.sequence`, errors);
}

function validateHotel(value, key, path, errors) {
  const keys = ['hotelId', 'name', 'address', 'postcode', 'phone', 'nights', 'boardBasis', 'isPlaceholder', 'arrivalDateISO'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.hotelId, key, `${path}.hotelId`, errors);
  boundedString(value.name, `${path}.name`, 300, errors, true);
  boundedString(value.address, `${path}.address`, 800, errors);
  boundedString(value.postcode, `${path}.postcode`, 40, errors);
  boundedString(value.phone, `${path}.phone`, 80, errors);
  boundedString(value.nights, `${path}.nights`, 20, errors);
  boundedString(value.boardBasis, `${path}.boardBasis`, 120, errors);
  booleanValue(value.isPlaceholder, `${path}.isPlaceholder`, errors);
  dateString(value.arrivalDateISO, `${path}.arrivalDateISO`, errors);
}

function validateService(value, key, path, errors) {
  const keys = ['serviceId', 'type', 'description', 'supplier', 'dateISO', 'time', 'bookingRef', 'notes', 'quantity'];
  exactObject(value, keys, keys, path, errors);
  if (!isObject(value)) return;
  equal(value.serviceId, key, `${path}.serviceId`, errors);
  boundedString(value.type, `${path}.type`, 160, errors);
  boundedString(value.description, `${path}.description`, 600, errors, true);
  boundedString(value.supplier, `${path}.supplier`, 300, errors);
  dateString(value.dateISO, `${path}.dateISO`, errors);
  boundedString(value.time, `${path}.time`, 40, errors);
  boundedString(value.bookingRef, `${path}.bookingRef`, 160, errors);
  boundedString(value.notes, `${path}.notes`, 2_000, errors);
  nonNegativeNumber(value.quantity, `${path}.quantity`, errors);
}

function validateCoach(value, errors) {
  const keys = ['seatMapAvailable', 'layoutSeatCount', 'details'];
  exactObject(value, keys, keys, '$.coach', errors);
  if (!isObject(value)) return;
  booleanValue(value.seatMapAvailable, '$.coach.seatMapAvailable', errors);
  nonNegativeInteger(value.layoutSeatCount, '$.coach.layoutSeatCount', errors);
  validateRecord(value.details, DRIVER_TOUR_PACK_LIMITS.maxCoachDetails, '$.coach.details', errors, (item, key, path, nestedErrors) => {
    const detailKeys = ['coachDetailId', 'company', 'driverName', 'phone', 'notes'];
    exactObject(item, detailKeys, detailKeys, path, nestedErrors);
    if (!isObject(item)) return;
    equal(item.coachDetailId, key, `${path}.coachDetailId`, nestedErrors);
    boundedString(item.company, `${path}.company`, 300, nestedErrors);
    boundedString(item.driverName, `${path}.driverName`, 200, nestedErrors);
    boundedString(item.phone, `${path}.phone`, 80, nestedErrors);
    boundedString(item.notes, `${path}.notes`, 2_000, nestedErrors);
  });
}

function validateContacts(value, errors) {
  exactObject(value, ['bookingLeads', 'operational'], ['bookingLeads', 'operational'], '$.contacts', errors);
  if (!isObject(value)) return;
  validateRecord(value.bookingLeads, DRIVER_TOUR_PACK_LIMITS.maxBookingLeadContacts, '$.contacts.bookingLeads', errors, (item, key, path, nestedErrors) => {
    const contactKeys = ['contactId', 'bookingRef', 'phone'];
    exactObject(item, contactKeys, contactKeys, path, nestedErrors);
    if (!isObject(item)) return;
    equal(item.contactId, key, `${path}.contactId`, nestedErrors);
    boundedString(item.bookingRef, `${path}.bookingRef`, 100, nestedErrors, true);
    boundedString(item.phone, `${path}.phone`, 80, nestedErrors, true);
  });
  validateRecord(value.operational, DRIVER_TOUR_PACK_LIMITS.maxOperationalContacts, '$.contacts.operational', errors, (item, key, path, nestedErrors) => {
    const contactKeys = ['contactId', 'type', 'name', 'phone', 'reference'];
    exactObject(item, contactKeys, contactKeys, path, nestedErrors);
    if (!isObject(item)) return;
    equal(item.contactId, key, `${path}.contactId`, nestedErrors);
    enumValue(item.type, ['hotel', 'coach', 'supplier'], `${path}.type`, nestedErrors);
    boundedString(item.name, `${path}.name`, 300, nestedErrors, true);
    boundedString(item.phone, `${path}.phone`, 80, nestedErrors);
    boundedString(item.reference, `${path}.reference`, 160, nestedErrors);
  });
}

function validateItineraries(value, errors) {
  exactObject(value, ['client', 'driver'], ['client', 'driver'], '$.itineraries', errors);
  if (!isObject(value)) return;
  ['client', 'driver'].forEach((key) => {
    const path = `$.itineraries.${key}`;
    exactObject(value[key], ['title', 'text'], ['title', 'text'], path, errors);
    if (!isObject(value[key])) return;
    boundedString(value[key].title, `${path}.title`, 300, errors);
    boundedString(value[key].text, `${path}.text`, DRIVER_TOUR_PACK_LIMITS.maxItineraryStringLength, errors);
  });
}

function validateRecord(value, limit, path, errors, itemValidator) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > limit) errors.push(`${path} exceeds ${limit} entries.`);
  entries.forEach(([key, item]) => {
    firebaseKey(key, `${path} key`, 100, errors);
    itemValidator(item, key, `${path}.${key}`, errors);
  });
}

function selectOperationalContent(pack) {
  if (!isObject(pack)) throw new TypeError('Pack must be an object.');
  return {
    schemaVersion: pack.schemaVersion,
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    tourCode: pack.tourCode,
    dateISO: pack.dateISO,
    status: pack.status,
    expiresAtMs: pack.expiresAtMs,
    coverage: pack.coverage,
    quality: pack.quality,
    tour: pack.tour,
    pickups: pack.pickups,
    passengers: pack.passengers,
    seats: pack.seats,
    timeline: pack.timeline,
    hotels: pack.hotels,
    services: pack.services,
    coach: pack.coach,
    contacts: pack.contacts,
    itineraries: pack.itineraries,
  };
}

function canonicalize(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (!isObject(value)) throw new TypeError(`${path} contains an unsupported value.`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], `${path}.${key}`)]));
}

function inspectPrivacy(value, path, errors) {
  if (typeof value === 'string') {
    if (EMAIL_VALUE_PATTERN.test(value)) errors.push(`${path} contains prohibited email data.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPrivacy(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_FIELD_PATTERN.test(key)) errors.push(`${path}.${key} is not privacy-allowlisted.`);
    inspectPrivacy(item, `${path}.${key}`, errors);
  });
}

function exactObject(value, allowed, required, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const allowedSet = new Set(allowed);
  Object.keys(value).forEach((key) => {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is unknown.`);
  });
  required.forEach((key) => {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
  });
}

function boundedString(value, path, maxLength, errors, required = false) {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string.`);
    return;
  }
  if (required && !value.trim()) errors.push(`${path} must not be empty.`);
  if (value.length > maxLength) errors.push(`${path} exceeds ${maxLength} characters.`);
}

function firebaseKey(value, path, maxLength, errors) {
  boundedString(value, path, maxLength, errors, true);
  if (typeof value === 'string' && !isFirebaseKeyText(value)) errors.push(`${path} is not a safe Firebase key.`);
}

function dateString(value, path, errors) {
  boundedString(value, path, 10, errors, true);
  if (typeof value !== 'string') return;
  if (!DATE_PATTERN.test(value)) {
    errors.push(`${path} must use YYYY-MM-DD.`);
    return;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    errors.push(`${path} must be a real calendar date.`);
  }
}

function enumValue(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(`${path} must be one of ${allowed.join(', ')}.`);
}

function equal(value, expected, path, errors) {
  if (value !== expected) errors.push(`${path} must equal ${String(expected)}.`);
}

function booleanValue(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean.`);
}

function nonNegativeInteger(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 0) errors.push(`${path} must be a non-negative safe integer.`);
}

function positiveInteger(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${path} must be a positive safe integer.`);
}

function nonNegativeNumber(value, path, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) errors.push(`${path} must be a non-negative finite number.`);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFirebaseKeyText(value) {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint > 31 && codePoint !== 127 && !'.#$/[]'.includes(character);
  });
}

module.exports = {
  DRIVER_TOUR_PACK_SCHEMA_VERSION,
  DRIVER_TOUR_PACK_CONTRACT_ID,
  DRIVER_TOUR_PACK_READABLE_SCHEMA_VERSIONS,
  DRIVER_TOUR_PACK_STATUSES,
  DRIVER_TOUR_PACK_LIMITS,
  DriverTourPackValidationError,
  canonicalJson,
  computeDriverTourPackContentFingerprint,
  validateDriverTourPack,
  assertValidDriverTourPack,
};
