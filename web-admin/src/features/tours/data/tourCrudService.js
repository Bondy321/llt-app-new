import {
  ref,
  update,
  get,
  onValue,
  runTransaction,
  db,
  postAdminAction,
  parseUKDateStrict,
  parseISODateStrict,
  formatDateToUK,
  DEFAULT_TOUR,
  TOUR_TEMPLATES,
  generateTourId,
  hasOwn,
  trimTourCode,
  buildTourCodeConflictMessage,
  assertTourCodeUnchanged,
  parseTourServiceDate,
  buildTourDateIndexFields,
  assertChronologicalTourDates,
  assertValidTourCapacity,
  assertTourCapacityUpdate,
  normalizeAssignmentTourId,
  formatDateToDDMMYYYY,
} from './tourServiceContext';

const SERVER_OWNED_ASSIGNMENT_FIELDS = new Set([
  'driverId',
  'driverName',
  'driverPhone',
  'driverAssignmentRevision',
]);

const stripServerOwnedAssignmentFields = (tourData = {}) => Object.fromEntries(
  Object.entries(tourData).filter(([field]) => !SERVER_OWNED_ASSIGNMENT_FIELDS.has(field)),
);

const assertNoServerOwnedAssignmentFields = (updates = {}) => {
  const reservedField = Object.keys(updates).find((field) => SERVER_OWNED_ASSIGNMENT_FIELDS.has(field));
  if (reservedField) {
    throw new Error(`${reservedField} is a server-owned driver assignment field. Use the assignment action instead.`);
  }
};

export const createTour = async (tourData, _createdBy = 'admin') => {
  const safeTourData = stripServerOwnedAssignmentFields(tourData);
  const tourCode = trimTourCode(safeTourData.tourCode);
  if (!tourCode) {
    throw new Error('Tour code is required to create a tour.');
  }

  const tourId = generateTourId(tourCode);
  assertChronologicalTourDates(safeTourData);
  assertValidTourCapacity({ ...DEFAULT_TOUR, ...safeTourData });
  const newTour = {
    ...DEFAULT_TOUR,
    ...safeTourData,
    tourCode,
    ...buildTourDateIndexFields(safeTourData),
    // Ensure itinerary structure is correct
    itinerary: safeTourData.itinerary || {
      title: safeTourData.name || '',
      days: []
    }
  };

  const tourRef = ref(db, `tours/${tourId}`);
  const creation = await runTransaction(
    tourRef,
    (existingTour) => (existingTour === null ? newTour : undefined),
    { applyLocally: false },
  );
  if (!creation.committed) {
    throw new Error(buildTourCodeConflictMessage(tourCode, tourId));
  }

  return { id: tourId, tour: newTour };
};

/**
 * Create a tour from a template
 * @param {string} templateKey - Key from TOUR_TEMPLATES
 * @param {Object} overrides - Additional data to override template
 * @param {string} createdBy - Email/ID of admin
 */
export const createTourFromTemplate = async (templateKey, overrides = {}, createdBy = 'admin') => {
  const template = TOUR_TEMPLATES[templateKey];
  if (!template) {
    throw new Error(`Template "${templateKey}" not found`);
  }

  // Generate dates if not provided
  const today = new Date();
  const startDate = overrides.startDate || formatDateToDDMMYYYY(today);

  const parsedUkStartDate = parseUKDateStrict(startDate);
  const parsedIsoStartDate = parsedUkStartDate.success ? null : parseISODateStrict(startDate);
  const dateAnchor = parsedUkStartDate.success
    ? parsedUkStartDate.date
    : parsedIsoStartDate.success
      ? parsedIsoStartDate.date
      : today;

  // Calculate end date based on days
  const endDateObj = new Date(dateAnchor);
  endDateObj.setDate(endDateObj.getDate() + (template.days - 1));
  const endDate = overrides.endDate || formatDateToDDMMYYYY(endDateObj);

  // Generate unique tour code
  const uniqueCode = `${template.tourCode}_${Date.now().toString(36).toUpperCase()}`;

  return createTour({
    ...template,
    ...overrides,
    tourCode: overrides.tourCode || uniqueCode,
    startDate,
    endDate
  }, createdBy);
};

/**
 * Update an existing tour
 * @param {string} tourId - Tour ID to update
 * @param {Object} updates - Fields to update
 */
export const updateTour = async (tourId, updates) => {
  assertNoServerOwnedAssignmentFields(updates);
  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  if (!snapshot?.exists?.()) {
    throw new Error(`Tour "${tourId}" no longer exists. Refresh the tour list before retrying.`);
  }
  const existingTour = snapshot.val() || {};
  if (hasOwn(updates, 'startDate') || hasOwn(updates, 'endDate')) {
    assertChronologicalTourDates({ ...existingTour, ...updates });
  }
  assertTourCapacityUpdate(existingTour, updates);
  assertTourCodeUnchanged(tourId, updates, existingTour);

  const indexedUpdates = {
    ...updates,
    ...buildTourDateIndexFields({ ...existingTour, ...updates }),
  };

  await update(tourRef, indexedUpdates);

  return { id: tourId, updates: indexedUpdates };
};

/**
 * Delete a tour
 * @param {string} tourId - Tour ID to delete
 */
export const deleteTour = async (tourId) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) throw new Error('A valid tour ID is required.');

  const result = await postAdminAction('deleteTourData', { tourId: normalizedTourId }, {
    configurationError: 'Safe tour deletion is not configured for this web admin deployment.',
    fallbackError: 'The tour could not be deleted safely. No deletion result was confirmed.',
    reasonMessages: {
      ORIGIN_NOT_ALLOWED: 'This admin portal address is not authorized for tour deletion. Contact an administrator before retrying.',
      INVALID_CREDENTIALS: 'Your admin session has expired. Sign in again and retry.',
      NOT_AUTHORIZED: 'This account is not authorized to delete tours.',
      INVALID_TOUR: 'The tour ID is invalid.',
      DELETE_IN_PROGRESS: 'This tour is already being deleted. Wait a moment and retry.',
      INTERNAL_ERROR: 'The tour could not be deleted safely. Retry before making further changes.',
    },
  });

  return {
    id: normalizedTourId,
    deleted: true,
    alreadyDeleted: Boolean(result.alreadyDeleted || result.summary?.alreadyDeleted),
    summary: result.summary || {},
  };
};

/**
 * Assign a driver to a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID
 * @param {Object} driverInfo - Driver info {name, phone}
 */
export const subscribeToTours = (callback, onError) => {
  const toursRef = ref(db, 'tours');
  return onValue(
    toursRef,
    (snapshot) => callback(snapshot.val() || {}),
    (error) => onError?.(error),
  );
};

/**
 * Get a single tour by ID
 * @param {string} tourId - Tour ID
 * @returns {Promise<Object|null>}
 */
export const getTour = async (tourId) => {
  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  return snapshot.val();
};

const getNextDuplicateTourCode = async (baseTourCode) => {
  const baseCode = trimTourCode(baseTourCode) || 'TOUR';

  for (let copyNumber = 1; copyNumber <= 100; copyNumber += 1) {
    const suffix = copyNumber === 1 ? '_COPY' : `_COPY_${copyNumber}`;
    const candidateCode = `${baseCode}${suffix}`;
    const candidateId = generateTourId(candidateCode);
    const candidateSnapshot = await get(ref(db, `tours/${candidateId}`));

    if (!candidateSnapshot?.exists?.()) {
      return candidateCode;
    }
  }

  throw new Error(`Could not find an available copy code for "${baseCode}".`);
};

/**
 * Duplicate an existing tour
 * @param {string} tourId - Tour ID to duplicate
 * @param {string} createdBy - Admin email/ID
 */
export const duplicateTour = async (tourId, createdBy = 'admin') => {
  const existingTour = await getTour(tourId);
  if (!existingTour) {
    throw new Error(`Tour "${tourId}" not found`);
  }

  // Generate new tour code
  const newTourCode = await getNextDuplicateTourCode(existingTour.tourCode || tourId);

  const definitionFields = [
    'name',
    'days',
    'startDate',
    'endDate',
    'isActive',
    'maxParticipants',
    'pickupPoints',
    'itinerary',
    'driver_itinerary',
  ];
  const newTour = definitionFields.reduce((copy, field) => {
    if (hasOwn(existingTour, field)) copy[field] = structuredClone(existingTour[field]);
    return copy;
  }, {});
  if (newTour.startDate && !newTour.endDate) {
    const startDate = parseTourServiceDate(newTour.startDate);
    if (startDate) {
      const durationDays = Number.isInteger(newTour.days) && newTour.days > 0 ? newTour.days : DEFAULT_TOUR.days;
      const derivedEndDate = new Date(startDate);
      derivedEndDate.setDate(derivedEndDate.getDate() + durationDays - 1);
      newTour.endDate = formatDateToUK(derivedEndDate);
    }
  } else if (newTour.endDate && !newTour.startDate) {
    delete newTour.endDate;
  }
  Object.assign(newTour, {
    name: `${existingTour.name || 'Tour'} (Copy)`,
    tourCode: newTourCode,
    currentParticipants: 0,
  });

  return createTour(newTour, createdBy);
};
