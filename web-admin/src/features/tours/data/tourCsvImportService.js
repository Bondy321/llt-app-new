import {
  ref,
  get,
  db,
  validateTourCsvRows,
  generateTourId,
  normalizeAssignmentTourId,
} from './tourServiceContext';

import { createTour, updateTour } from './tourCrudService';
import {
  applyDriverAssignmentMutation,
  unassignDriver,
} from './tourDriverAssignmentService';

const valueOr = (value, fallback) => (value === null || value === undefined || value === '' ? fallback : value);

const buildTourCsvRow = (id, tour, drivers, driverByTourId) => {
  const resolvedDriverId = valueOr(tour.driverId, driverByTourId.get(normalizeAssignmentTourId(id)) || '');
  const driver = drivers[resolvedDriverId] || {};
  const driverName = resolvedDriverId ? valueOr(tour.driverName, valueOr(driver.name, 'TBA')) : 'TBA';
  const driverPhone = resolvedDriverId ? valueOr(tour.driverPhone, valueOr(driver.phone, '')) : '';
  return [
    id,
    valueOr(tour.tourCode, ''),
    valueOr(tour.name, ''),
    valueOr(tour.days, 1),
    valueOr(tour.startDate, ''),
    valueOr(tour.endDate, ''),
    tour.isActive ? 'Yes' : 'No',
    driverName,
    resolvedDriverId,
    driverPhone,
    valueOr(tour.maxParticipants, 53),
    valueOr(tour.currentParticipants, 0),
    JSON.stringify(Array.isArray(tour.pickupPoints) ? tour.pickupPoints : []),
  ];
};

export const exportToursToCSV = (tours, { drivers = {} } = {}) => {
  const headers = [
    'ID',
    'Tour Code',
    'Name',
    'Days',
    'Start Date',
    'End Date',
    'Active',
    'Driver',
    'Driver ID',
    'Driver Phone',
    'Max Participants',
    'Current Participants',
    'Pickup Points',
  ];

  const driverByTourId = new Map();
  Object.entries(drivers || {}).forEach(([driverId, driver]) => {
    const currentTourId = normalizeAssignmentTourId(driver?.currentTourId);
    if (currentTourId) driverByTourId.set(currentTourId, driverId);
  });

  const rows = Object.entries(tours).map(([id, tour]) => (
    buildTourCsvRow(id, tour, drivers, driverByTourId)
  ));

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');

  return csvContent;
};

const getExistingTourCodeIndex = (tours = {}) => {
  const existingTourCodes = new Set();
  // Keep a single map for normalized tour code -> tour id lookups.
  const existingTourCodeToId = new Map();

  Object.entries(tours || {}).forEach(([id, tour]) => {
    const normalizedCode = (tour?.tourCode || '').trim().toUpperCase();
    if (!normalizedCode) return;
    existingTourCodes.add(normalizedCode);
    existingTourCodeToId.set(normalizedCode, id);
  });

  return { existingTourCodes, existingTourCodeToId };
};

/**
 * Parse CSV content to tour objects
 * @param {string} csvContent - CSV string
 * @returns {Array<Object>} - Array of tour objects
 */
export const parseCSVToTours = (csvContent) => {
  const result = validateTourCsvRows(csvContent, { mode: 'upsert' });
  return result.rows.filter((row) => row.isValid).map((row) => row.tour);
};

export const previewTourCSVImport = async (csvContent, { mode = 'upsert' } = {}) => {
  const [snapshot, driversSnapshot] = await Promise.all([
    get(ref(db, 'tours')),
    get(ref(db, 'drivers')),
  ]);
  const tours = snapshot.exists() ? snapshot.val() : {};
  const drivers = driversSnapshot.exists() ? driversSnapshot.val() : {};
  const existingIndex = getExistingTourCodeIndex(tours);

  return validateTourCsvRows(csvContent, {
    mode,
    ...existingIndex,
    existingDrivers: new Map(Object.entries(drivers)),
  });
};

const applyImportAssignment = async (tourId, assignment, actorId) => {
  if (assignment?.action === 'unassign') {
    await unassignDriver(tourId);
    return;
  }
  if (!assignment?.driverId) return;
  await applyDriverAssignmentMutation({
    tourId,
    driverId: assignment.driverId,
    driverInfo: assignment.driverInfo,
    isAssigned: true,
    actorId,
  });
};

const importCreatedTourRow = async (row, createdBy, created) => {
  const createdTour = await createTour(row.tour, createdBy);
  created.push(createdTour);
  try {
    await applyImportAssignment(createdTour.id, row.assignment, createdBy);
  } catch (error) {
    error.baseMutationApplied = true;
    throw error;
  }
};

const importUpdatedTourRow = async (row, createdBy, updated) => {
  const tourId = row.existingTourId || generateTourId(row.tour.tourCode);
  const updates = row.updates || {};
  const fieldsChanged = Object.keys(updates).length > 0;
  if (fieldsChanged) await updateTour(tourId, updates);
  updated.push({ id: tourId, updates, assignment: row.assignment || null });
  try {
    await applyImportAssignment(tourId, row.assignment, createdBy);
  } catch (error) {
    error.baseMutationApplied = fieldsChanged;
    throw error;
  }
  return fieldsChanged;
};

export const executeTourCSVImport = async (previewRows, options = {}) => {
  const {
    mode = 'upsert',
    importValidOnly = true,
    createdBy = 'import',
  } = options;

  const rowsToImport = importValidOnly
    ? previewRows.filter((row) => row.isValid)
    : previewRows;

  const created = [];
  const updated = [];
  const errors = [];

  for (const row of rowsToImport) {
    if (!row.isValid) {
      errors.push({ rowNumber: row.rowNumber, error: row.errors.join(' ') });
      continue;
    }

    let baseMutationApplied = false;
    try {
      if (mode === 'create-only' || row.action === 'create') {
        await importCreatedTourRow(row, createdBy, created);
        baseMutationApplied = true;
        continue;
      }

      if (mode === 'update-existing' || row.action === 'update') {
        baseMutationApplied = await importUpdatedTourRow(row, createdBy, updated);
      }
    } catch (error) {
      baseMutationApplied = baseMutationApplied || error.baseMutationApplied === true;
      errors.push({
        rowNumber: row.rowNumber,
        error: baseMutationApplied
          ? `${error.message} The tour fields were saved, but the assignment step did not complete.`
          : error.message,
        partial: baseMutationApplied,
      });
    }
  }

  return { created, updated, errors, attempted: rowsToImport.length };
};

/**
 * Subscribe to tours in real-time
 * @param {Function} callback - Callback function (tours) => void
 * @returns {Function} - Unsubscribe function
 */
