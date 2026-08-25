const {
  MANIFEST_STATUS,
  PASSENGER_IDENTITY_VERSION,
  fetchTourManifestFromFunction,
  isOpaquePassengerId,
  logBookingEvent,
  logger,
  maskIdentifier,
  normalizeTourId,
} = require('./bookingServiceContext');

const validateTourCode = (tourCode) => {
  if (!tourCode || typeof tourCode !== 'string' || tourCode.trim().length === 0) {
    throw new Error('Invalid tour code');
  }
  return tourCode.trim();
};

/**
 * Validates booking reference
 */
const validateBookingRef = (bookingRef) => {
  if (!bookingRef || typeof bookingRef !== 'string' || bookingRef.trim().length === 0) {
    throw new Error('Invalid booking reference');
  }
  return bookingRef.trim().toUpperCase();
};

const resolveVerifiedPassengerIdentity = ({ stablePassengerId, identityVersion } = {}) => {
  const normalizedIdentity = typeof stablePassengerId === 'string' ? stablePassengerId.trim() : '';
  if (!isOpaquePassengerId(normalizedIdentity) || identityVersion !== PASSENGER_IDENTITY_VERSION) {
    return { stablePassengerId: null, identityVersion: null };
  }

  return {
    stablePassengerId: normalizedIdentity,
    identityVersion: PASSENGER_IDENTITY_VERSION,
  };
};

/**
 * Validates driver ID
 */
const validateDriverId = (driverId) => {
  if (!driverId || typeof driverId !== 'string' || driverId.trim().length === 0) {
    throw new Error('Invalid driver ID');
  }
  return driverId.trim().toUpperCase();
};

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

/**
 * Validates passenger statuses array
 */
const validatePassengerStatuses = (statuses) => {
  if (!Array.isArray(statuses)) {
    throw new Error('Passenger statuses must be an array');
  }

  const validStatuses = Object.values(MANIFEST_STATUS);
  for (const status of statuses) {
    if (status && !validStatuses.includes(status)) {
      throw new Error(`Invalid passenger status: ${status}`);
    }
  }

  return statuses;
};

// --- HELPER: Sanitize Tour IDs (e.g., "5112D 8" -> "5112D_8") ---
const sanitizeTourId = (tourCode) => {
  return normalizeTourId(tourCode);
};

const normalizeTourIdentifier = (candidate) => {
  return normalizeTourId(candidate);
};

const isValidNormalizedTourId = (tourId) => {
  return typeof tourId === 'string' && /^[A-Z0-9][A-Z0-9_-]*$/.test(tourId);
};

const buildAssignedDriverCodePayload = ({ driverId, tourId, tourCode, assignedBy, assignedAt = new Date().toISOString() }) => ({
  driverId,
  tourId,
  tourCode,
  assignedAt,
  assignedBy,
});

const resolveVerifierTourId = (passengerVerification = {}) => {
  const verifierTourId = normalizeTourIdentifier(passengerVerification.tourId);
  if (isValidNormalizedTourId(verifierTourId)) {
    return verifierTourId;
  }

  return null;
};

// --- HELPERS: Manifest Status Derivation ---
const deriveParentStatusFromPassengers = (passengerStatuses = []) => {
  if (!Array.isArray(passengerStatuses) || passengerStatuses.length === 0) return MANIFEST_STATUS.PENDING;

  const normalized = passengerStatuses.map((status) => status || MANIFEST_STATUS.PENDING);
  const allBoarded = normalized.every((status) => status === MANIFEST_STATUS.BOARDED);
  const allNoShow = normalized.every((status) => status === MANIFEST_STATUS.NO_SHOW);
  const allPending = normalized.every((status) => status === MANIFEST_STATUS.PENDING);

  if (allBoarded) return MANIFEST_STATUS.BOARDED;
  if (allNoShow) return MANIFEST_STATUS.NO_SHOW;
  if (allPending) return MANIFEST_STATUS.PENDING;
  return MANIFEST_STATUS.PARTIAL;
};

const normalizePassengerStatuses = (passengerStatuses, totalPax) => {
  const baseStatuses = Array.isArray(passengerStatuses) ? passengerStatuses : [];
  const padded = [...baseStatuses];

  if (typeof totalPax === 'number' && totalPax > padded.length) {
    const missing = totalPax - padded.length;
    padded.push(...Array(missing).fill(MANIFEST_STATUS.PENDING));
  } else if (typeof totalPax === 'number' && totalPax > 0 && padded.length > totalPax) {
    padded.length = totalPax;
  }

  return padded.map((status) => status || MANIFEST_STATUS.PENDING);
};

const normalizeManifestPassengerRows = (bookingData = {}) => {
  const details = Array.isArray(bookingData.passengerDetails) ? bookingData.passengerDetails : [];
  const names = Array.isArray(bookingData.passengerNames)
    ? bookingData.passengerNames
    : (Array.isArray(bookingData.passengers) ? bookingData.passengers : []);
  const seatNumbers = Array.isArray(bookingData.seatNumbers) ? bookingData.seatNumbers : [];
  const seatLabels = Array.isArray(bookingData.seatLabels) ? bookingData.seatLabels : [];
  const rowCount = Math.max(details.length, names.length, seatNumbers.length, seatLabels.length);
  const strongIdentityRows = new Map();
  const rows = [];
  const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

  for (let index = 0; index < rowCount; index += 1) {
    const detail = details[index] && typeof details[index] === 'object' && !Array.isArray(details[index])
      ? details[index]
      : {};
    const name = toTrimmedString(detail.name) || toTrimmedString(names[index]) || 'Unknown Passenger';
    const rawSeatNumber = detail.seatNo ?? detail.seatNumber ?? seatNumbers[index] ?? null;
    const numericSeat = Number(rawSeatNumber);
    const hasNumericSeat = rawSeatNumber !== null
      && rawSeatNumber !== ''
      && Number.isInteger(numericSeat)
      && numericSeat >= 0;
    const seatNumber = hasNumericSeat ? numericSeat : rawSeatNumber;
    const seatLabel = toTrimmedString(detail.seatLabel) || toTrimmedString(seatLabels[index]);
    const labelSeatMatch = seatLabel.match(/^S?0*(\d+)$/i);
    const seatIdentity = hasNumericSeat
      ? `number:${numericSeat}`
      : (labelSeatMatch ? `number:${Number(labelSeatMatch[1])}` : (seatLabel ? `label:${seatLabel.toUpperCase()}` : null));
    const strongIdentity = seatIdentity
      ? `${name.replace(/\s+/g, ' ').trim().toLowerCase()}|${seatIdentity}`
      : null;

    if (strongIdentity && strongIdentityRows.has(strongIdentity)) {
      rows[strongIdentityRows.get(strongIdentity)].sourceIndexes.push(index);
      continue;
    }
    if (strongIdentity) strongIdentityRows.set(strongIdentity, rows.length);

    rows.push({
      sourceIndex: index,
      sourceIndexes: [index],
      name,
      seatNumber,
      seatLabel,
      detail: details.length > 0 ? { ...detail, name } : null,
    });
  }

  return {
    rows,
    duplicateCount: Math.max(0, rowCount - rows.length),
  };
};

const ensureBookingSchemaConsistency = async (bookingRef, bookingData) => {
  const { rows, duplicateCount } = normalizeManifestPassengerRows(bookingData);
  const passengerNames = rows.map((row) => row.name);
  const seatNumbers = rows.map((row) => row.seatNumber ?? 'TBA');
  const seatLabels = rows.map((row) => row.seatLabel || 'TBA');
  const passengerDetails = rows.map((row) => row.detail).filter(Boolean);

  if (passengerNames.length > seatNumbers.length) {
    const missingSeats = passengerNames.length - seatNumbers.length;
    seatNumbers.push(...Array(missingSeats).fill('TBA'));
  } else if (seatNumbers.length > passengerNames.length && passengerNames.length > 0) {
    seatNumbers.length = passengerNames.length;
  }

  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [];
  const firstPickup = pickupPoints[0] || {};

  return {
    normalizedBooking: {
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
    },
    passengerSourceIndexes: rows.map((row) => row.sourceIndexes),
    duplicatePassengerCount: duplicateCount,
    updated: false,
  };
};

// --- UPDATED: Fetch Full Manifest with NO SHOW stats ---
const getTourManifest = async (tourCodeOriginal) => {
  try {
    // Validate inputs
    const validatedTourCode = validateTourCode(tourCodeOriginal);
    logBookingEvent('info', 'Manifest fetch started', {
      tourCode: maskIdentifier(validatedTourCode),
    });

    const functionManifest = await fetchTourManifestFromFunction(validatedTourCode);
    logBookingEvent('info', 'Manifest fetch completed via function', {
      tourId: functionManifest.tourId,
      bookingCount: functionManifest.bookings.length,
      totalPax: functionManifest.stats?.totalPax || 0,
    });
    return functionManifest;

  } catch (error) {
    logger?.error?.('Manifest', 'Error fetching tour manifest', { tourCode: maskIdentifier(tourCodeOriginal), error: error?.message || String(error) });
    throw error;
  }
};

// --- UPDATED: Update Booking Status with Passenger-Level granularity ---

module.exports = {
  MANIFEST_STATUS,
  buildAssignedDriverCodePayload,
  deriveParentStatusFromPassengers,
  ensureBookingSchemaConsistency,
  getTourManifest,
  isValidNormalizedTourId,
  normalizeManifestPassengerRows,
  normalizePassengerStatuses,
  normalizeTourIdentifier,
  resolveVerifiedPassengerIdentity,
  resolveVerifierTourId,
  sanitizeTourId,
  validateBookingRef,
  validateDriverId,
  validatePassengerStatuses,
  validateTourCode,
  validateUserId,
};
