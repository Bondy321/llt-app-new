'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { cleanPassengerString } = require('../../infrastructure/validation/passengerNormalization');
const { normalizeManifestPassengerRows } = loadLegacyLibrary('manifestPassengers');

const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const MANIFEST_STATUS = Object.freeze({
  PENDING: 'PENDING', BOARDED: 'BOARDED', NO_SHOW: 'NO_SHOW', PARTIAL: 'PARTIAL',
});
/** @type {Set<string>} */
const MANIFEST_STATUS_VALUES = new Set(Object.values(MANIFEST_STATUS));

/** @type {(...args: any[]) => any} */
const normalizePassengerStatuses = (passengerStatuses, totalPax) => {
  const baseStatuses = Array.isArray(passengerStatuses) ? passengerStatuses : [];
  const padded = [...baseStatuses];

  if (typeof totalPax === 'number' && totalPax > padded.length) {
    padded.push(...Array(totalPax - padded.length).fill(MANIFEST_STATUS.PENDING));
  } else if (typeof totalPax === 'number' && totalPax > 0 && padded.length > totalPax) {
    padded.length = totalPax;
  }

  return padded.map((status) => (
    MANIFEST_STATUS_VALUES.has(status) ? status : MANIFEST_STATUS.PENDING
  ));
};

/** @type {(...args: any[]) => any} */
const deriveParentStatusFromPassengers = (passengerStatuses = []) => {
  if (!Array.isArray(passengerStatuses) || passengerStatuses.length === 0) return MANIFEST_STATUS.PENDING;

  const normalized = passengerStatuses.map((status) => status || MANIFEST_STATUS.PENDING);
  if (normalized.every((status) => status === MANIFEST_STATUS.BOARDED)) return MANIFEST_STATUS.BOARDED;
  if (normalized.every((status) => status === MANIFEST_STATUS.NO_SHOW)) return MANIFEST_STATUS.NO_SHOW;
  if (normalized.every((status) => status === MANIFEST_STATUS.PENDING)) return MANIFEST_STATUS.PENDING;
  return MANIFEST_STATUS.PARTIAL;
};

/** @type {(...args: any[]) => any} */
const normalizeManifestBooking = (bookingRef, bookingData = {}) => {
  const { rows: rawRows, duplicateCount } = normalizeManifestPassengerRows(bookingData);
  const rows = /** @type {any[]} */ (rawRows);
  const passengerNames = rows.map((row) => row.name);
  const seatNumbers = rows.map((row) => row.seatNumber ?? 'TBA');
  const seatLabels = rows.map((row) => row.seatLabel || 'TBA');
  const passengerDetails = rows.map((row) => row.detail).filter(Boolean);

  if (passengerNames.length > seatNumbers.length) {
    seatNumbers.push(...Array(passengerNames.length - seatNumbers.length).fill('TBA'));
  } else if (seatNumbers.length > passengerNames.length && passengerNames.length > 0) {
    seatNumbers.length = passengerNames.length;
  }

  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [];
  const firstPickup = pickupPoints[0] || {};

  const normalizedBooking = {
    id: bookingRef,
    ...bookingData,
    passengerNames,
    passengers: passengerNames,
    ...(Array.isArray(bookingData.passengerDetails) ? { passengerDetails } : {}),
    seatNumbers,
    seatLabels,
    pickupPoints,
    pickupDate: firstPickup.date || bookingData.pickupDate || 'TBA',
    pickupTime: firstPickup.time || bookingData.pickupTime || 'TBA',
    pickupLocation: firstPickup.location || bookingData.pickupLocation || bookingData.pickupAddress || 'To be confirmed',
  };
  Object.defineProperty(normalizedBooking, '_manifestPassengerSourceIndexes', {
    value: rows.map((row) => row.sourceIndexes),
    enumerable: false,
  });
  Object.defineProperty(normalizedBooking, '_manifestDuplicatePassengerCount', {
    value: duplicateCount,
    enumerable: false,
  });
  return normalizedBooking;
};

// The full booking record is needed while the Function reconciles duplicated
// passenger rows, but the driver manifest only renders this bounded operational
// subset. Keeping the projection here prevents contact, payment, service and
// contract fields from crossing the backend boundary or entering offline cache.
/** @type {(...args: any[]) => any} */
const buildDriverManifestBooking = ({ bookingRef, normalizedBooking, passengerStatus, status }) => ({
  id: cleanPassengerString(bookingRef, 120),
  passengerNames: normalizedBooking.passengerNames.map((/** @type {any} */ name) => (
    cleanPassengerString(name, 180) || 'Unknown Passenger'
  )),
  seatNumbers: normalizedBooking.passengerNames.map((/** @type {any} */ _, /** @type {number} */ index) => {
    const seat = normalizedBooking.seatNumbers?.[index];
    return typeof seat === 'number' && Number.isFinite(seat)
      ? seat
      : (cleanPassengerString(String(seat ?? ''), 40) || 'TBA');
  }),
  seatLabels: normalizedBooking.passengerNames.map((/** @type {any} */ _, /** @type {number} */ index) => (
    cleanPassengerString(normalizedBooking.seatLabels?.[index], 80) || 'TBA'
  )),
  passengerStatus,
  hasPassengerStatuses: true,
  status,
  pickupDate: cleanPassengerString(normalizedBooking.pickupDate, 40) || 'TBA',
  pickupLocation: cleanPassengerString(normalizedBooking.pickupLocation, 250) || 'To be confirmed',
  pickupTime: cleanPassengerString(normalizedBooking.pickupTime, 40) || 'TBA',
});

/** @type {(...args: any[]) => Promise<any>} */
const verifyTourManifestAccess = async ({ authUid, tourId, db = admin.database() }) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(tourId)) {
    return { allowed: false, reason: 'INVALID_INPUT' };
  }

  if (authUid === OPERATIONS_ADMIN_UID) {
    return { allowed: true, role: 'admin' };
  }

  const [adminSnapshot, userSnapshot] = await Promise.all([
    db.ref(`admin_users/${authUid}`).once('value'),
    db.ref(`users/${authUid}`).once('value'),
  ]);

  if (adminSnapshot.val() === true) {
    return { allowed: true, role: 'admin' };
  }

  const userProfile = userSnapshot.val() || {};
  const driverId = resolveTrimmedString(userProfile.driverId);
  if (!driverId || !isValidFirebaseKey(driverId)) {
    return { allowed: false, reason: 'NOT_TOUR_MEMBER' };
  }

  const [driverSnapshot, assignedDriverSnapshot] = await Promise.all([
    db.ref(`drivers/${driverId}/authUid`).once('value'),
    db.ref(`tour_manifests/${tourId}/assigned_drivers/${driverId}`).once('value'),
  ]);

  if (driverSnapshot.val() === authUid && assignedDriverSnapshot.val() === true) {
    return { allowed: true, role: 'assigned_driver', driverId };
  }

  return { allowed: false, reason: 'NOT_TOUR_MEMBER' };
};

/** @type {(...args: any[]) => Promise<any>} */
const buildTourManifestPayload = async ({ tourId, requestedTourCode = null, db = admin.database() }) => {
  const canonicalTourId = normalizeTourKeyForComparison(tourId || requestedTourCode);
  if (!canonicalTourId || !isValidFirebaseKey(canonicalTourId)) {
    throw new Error('Invalid tour id');
  }

  const [tourSnapshot, bookingsByTourIdSnapshot, manifestSnapshot] = await Promise.all([
    db.ref(`tours/${canonicalTourId}`).once('value'),
    db.ref('bookings').orderByChild('tourId').equalTo(canonicalTourId).once('value'),
    db.ref(`tour_manifests/${canonicalTourId}`).once('value'),
  ]);
  if (!tourSnapshot.exists()) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Tour not found'));
    error.code = 'TOUR_NOT_FOUND';
    throw error;
  }

  const tourData = tourSnapshot.val() || {};
  const tourCode = resolveTrimmedString(tourData.tourCode)
    || resolveTrimmedString(requestedTourCode)
    || canonicalTourId.replace(/_/g, ' ');

  const rawBookings = bookingsByTourIdSnapshot.val() || {};
  const manifestData = manifestSnapshot.val() || {};
  const bookingStatuses = manifestData.bookings || {};
  const bookings = Object.entries(rawBookings).map(([bookingRef, bookingData]) => {
    const normalizedBooking = normalizeManifestBooking(bookingRef, bookingData || {});
    const liveStatus = bookingStatuses[bookingRef] || {};
    const totalPax = normalizedBooking.passengerNames.length;
    const hasPassengerStatuses = Array.isArray(liveStatus.passengerStatus);
    const legacyParentStatus = MANIFEST_STATUS_VALUES.has(liveStatus.status)
      ? liveStatus.status
      : MANIFEST_STATUS.PENDING;
    const rawPassengerStatuses = hasPassengerStatuses
      ? normalizedBooking._manifestPassengerSourceIndexes.map((/** @type {number[]} */ indexes) => {
        const statuses = indexes
          .map((/** @type {number} */ index) => liveStatus.passengerStatus[index])
          .filter((/** @type {string} */ status) => MANIFEST_STATUS_VALUES.has(status));
        const resolved = statuses.find((/** @type {string} */ status) => status !== MANIFEST_STATUS.PENDING);
        return resolved || statuses[0] || MANIFEST_STATUS.PENDING;
      })
      : Array(totalPax).fill(legacyParentStatus);
    const passengerStatus = normalizePassengerStatuses(rawPassengerStatuses, totalPax);
    const status = deriveParentStatusFromPassengers(passengerStatus);

    return buildDriverManifestBooking({
      bookingRef,
      normalizedBooking,
      passengerStatus,
      status,
    });
  });

  const stats = bookings.reduce((acc, booking) => {
    const paxCount = booking.passengerNames.length;
    acc.totalPax += paxCount;

    if (booking.hasPassengerStatuses && Array.isArray(booking.passengerStatus) && booking.passengerStatus.length > 0) {
      booking.passengerStatus.forEach((/** @type {string} */ status) => {
        if (status === MANIFEST_STATUS.BOARDED) acc.checkedIn += 1;
        if (status === MANIFEST_STATUS.NO_SHOW) acc.noShows += 1;
      });
    } else if (booking.status === MANIFEST_STATUS.BOARDED) {
      acc.checkedIn += paxCount;
    } else if (booking.status === MANIFEST_STATUS.NO_SHOW) {
      acc.noShows += paxCount;
    }

    return acc;
  }, { totalBookings: bookings.length, totalPax: 0, checkedIn: 0, noShows: 0 });

  return {
    schemaVersion: 1,
    complete: true,
    tourId: canonicalTourId,
    tourCode,
    bookings,
    stats,
  };
};


module.exports = {
  buildDriverManifestBooking,
  buildTourManifestPayload,
  deriveParentStatusFromPassengers,
  normalizeManifestBooking,
  normalizePassengerStatuses,
  verifyTourManifestAccess,
};
