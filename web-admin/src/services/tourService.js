/**
 * Tour Service - Firebase Realtime Database Operations
 *
 * This service provides a clean API for managing tours in Firebase Realtime Database.
 * All operations are real-time and sync automatically across all connected clients.
 *
 * FIREBASE DATABASE STRUCTURE:
 * ============================
 * tours/
 * ├── {tourId}/                    # Unique tour identifier (e.g., "5100D_138", "5209L_16")
 * │   ├── name                     # Tour display name
 * │   ├── tourCode                 # Tour code (e.g., "5209L 16")
 * │   ├── days                     # Number of days for the tour
 * │   ├── startDate                # Start date (DD/MM/YYYY format)
 * │   ├── endDate                  # End date (DD/MM/YYYY format)
 * │   ├── isActive                 # Whether tour is currently active
 * │   ├── driverName               # Assigned driver name or 'TBA'
 * │   ├── driverPhone              # Driver contact number
 * │   ├── maxParticipants          # Maximum passenger capacity
 * │   ├── currentParticipants      # Current passenger count
 * │   ├── pickupPoints             # Array of pickup locations
 * │   │   └── [{location, time}]
 * │   └── itinerary                # Tour itinerary
 * │       ├── title                # Itinerary title
 * │       └── days                 # Array of day activities
 * │           └── [{day, title, activities: [{description, time}]}]
 *
 * HOW TO ADD A NEW TOUR:
 * ======================
 * 1. Use createTour() function with tour data object
 * 2. The function uses the tourCode as the ID (with underscore replacing space)
 * 3. All connected clients receive the update in real-time
 *
 * Example:
 *   await createTour({
 *     name: 'Loch Lomond Scenic Tour',
 *     tourCode: '5500L 1',
 *     days: 1,
 *     startDate: '15/01/2025',
 *     endDate: '15/01/2025',
 *     maxParticipants: 53
 *   });
 */

import { ref, set, update, remove, get, onValue } from 'firebase/database';
import { db } from '../firebase';
import { validateTourCsvRows } from './tourCsvService';
import {
  parseUKDateStrict,
  parseISODateStrict,
  formatDateToUK,
  formatDateToISO,
  nowAsISOString,
} from '../utils/dateUtils';
export { parseUKDateStrict, parseISODateStrict } from '../utils/dateUtils';

// Default tour template matching the existing Firebase structure
export const DEFAULT_TOUR = {
  name: '',
  tourCode: '',
  days: 1,
  startDate: '',
  endDate: '',
  isActive: true,
  driverName: 'TBA',
  driverPhone: '',
  maxParticipants: 53,
  currentParticipants: 0,
  pickupPoints: [],
  itinerary: {
    title: '',
    days: []
  }
};

// Default pickup point structure
export const DEFAULT_PICKUP_POINT = {
  location: '',
  time: ''
};

// Default activity structure
export const DEFAULT_ACTIVITY = {
  description: '',
  time: ''
};

// Default day structure for itinerary
export const DEFAULT_ITINERARY_DAY = {
  day: 1,
  title: '',
  activities: []
};

// Pre-defined tour templates for quick creation
export const TOUR_TEMPLATES = {
  lochLomond: {
    name: 'Loch Lomond Explorer',
    tourCode: 'LL01',
    days: 1,
    maxParticipants: 53,
    isActive: true,
    pickupPoints: [
      { location: 'Glasgow - Buchanan Bus Station, Stances 23-32', time: '08:00' },
      { location: 'Balloch - Tourist Information Centre', time: '09:00' }
    ],
    itinerary: {
      title: 'Loch Lomond Explorer',
      days: [
        {
          day: 1,
          title: 'Loch Lomond Day Trip',
          activities: [
            { description: 'Depart Glasgow and travel to Balloch', time: '08:00' },
            { description: 'Visit Loch Lomond Shores - allow 1.5 hours free time', time: '09:30' },
            { description: 'Travel to Luss Village - allow 1 hour', time: '11:30' },
            { description: 'Scenic drive along the loch to Tarbet', time: '13:00' },
            { description: 'Stop at The Drovers Inn for refreshments', time: '14:00' },
            { description: 'Return journey to Glasgow', time: '16:00' }
          ]
        }
      ]
    }
  },
  highlands: {
    name: 'Scottish Highlands Adventure',
    tourCode: 'HL02',
    days: 2,
    maxParticipants: 53,
    isActive: true,
    pickupPoints: [
      { location: 'Edinburgh - Waterloo Place', time: '07:30' },
      { location: 'Glasgow - Buchanan Bus Station', time: '09:00' }
    ],
    itinerary: {
      title: 'Scottish Highlands Adventure',
      days: [
        {
          day: 1,
          title: 'Journey to the Highlands',
          activities: [
            { description: 'Depart and travel north via Stirling', time: '08:00' },
            { description: 'Photo stop at Stirling Castle viewpoint', time: '09:30' },
            { description: 'Continue through Glencoe - comfort stop', time: '12:00' },
            { description: 'Arrive Fort William - free time for lunch', time: '13:30' },
            { description: 'Check in to hotel', time: '16:00' },
            { description: 'Dinner at hotel', time: '18:30' }
          ]
        },
        {
          day: 2,
          title: 'Loch Ness & Return',
          activities: [
            { description: 'Breakfast at hotel', time: '08:00' },
            { description: 'Depart for Loch Ness', time: '09:30' },
            { description: 'Visit Urquhart Castle - allow 1.5 hours', time: '10:30' },
            { description: 'Free time in Inverness for lunch', time: '13:00' },
            { description: 'Begin return journey south', time: '15:00' },
            { description: 'Arrive back at pickup points', time: '19:00' }
          ]
        }
      ]
    }
  },
  edinburghCity: {
    name: 'Edinburgh City Tour',
    tourCode: 'ED01',
    days: 1,
    maxParticipants: 45,
    isActive: true,
    pickupPoints: [
      { location: 'Glasgow - Buchanan Bus Station', time: '09:00' },
      { location: 'Falkirk - Behind the Steeple', time: '09:45' }
    ],
    itinerary: {
      title: 'Edinburgh City Tour',
      days: [
        {
          day: 1,
          title: 'Discover Edinburgh',
          activities: [
            { description: 'Arrive Edinburgh and drop off at Royal Mile', time: '10:30' },
            { description: 'Free time to explore Old Town, Edinburgh Castle (entry not included)', time: '10:30' },
            { description: 'Lunch break - various options available', time: '13:00' },
            { description: 'Optional walk to Holyrood Palace', time: '14:30' },
            { description: 'Meet at bus for departure', time: '17:00' },
            { description: 'Return to pickup points', time: '18:30' }
          ]
        }
      ]
    }
  }
};

/**
 * Generate a tour ID from tour code
 * Replaces spaces with underscores
 */
export const generateTourId = (tourCode) => {
  if (!tourCode) {
    // Generate a random ID if no tour code provided
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `TOUR_${timestamp}_${random}`;
  }

  const normalized = String(tourCode)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$[\]/]/g, '');

  const collapsed = normalized.replace(/^_+|_+$/g, '');

  if (!collapsed) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `TOUR_${timestamp}_${random}`;
  }

  return collapsed;
};

const hasOwn = (value, property) => Object.prototype.hasOwnProperty.call(value || {}, property);

const trimTourCode = (tourCode) => (typeof tourCode === 'string' ? tourCode.trim() : '');

const tourCodesReferToSameKey = (left, right) => {
  const leftCode = trimTourCode(left);
  const rightCode = trimTourCode(right);
  if (!leftCode || !rightCode) return false;
  return generateTourId(leftCode) === generateTourId(rightCode);
};

const buildTourCodeConflictMessage = (tourCode, tourId) => (
  `Tour code "${tourCode}" already exists at tours/${tourId}. Choose a unique tour code.`
);

const assertTourCodeCanBeCreated = async (tourId, tourCode) => {
  const existingSnapshot = await get(ref(db, `tours/${tourId}`));
  if (existingSnapshot?.exists?.()) {
    throw new Error(buildTourCodeConflictMessage(tourCode, tourId));
  }
};

const assertTourCodeUnchanged = async (tourId, updates) => {
  if (!hasOwn(updates, 'tourCode')) return;

  const nextTourCode = trimTourCode(updates.tourCode);
  if (!nextTourCode) {
    throw new Error('Tour code cannot be cleared after creation.');
  }

  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  const existingTour = snapshot?.val?.() || null;
  const existingTourCode = trimTourCode(existingTour?.tourCode);

  if (existingTourCode) {
    if (!tourCodesReferToSameKey(existingTourCode, nextTourCode)) {
      throw new Error('Tour code cannot be changed after creation. Create a new tour if the code needs to change.');
    }
    updates.tourCode = existingTourCode;
    return;
  }

  if (generateTourId(nextTourCode) !== tourId) {
    throw new Error('Tour code must match the Firebase tour ID when setting it for the first time.');
  }
  updates.tourCode = nextTourCode;
};

const normalizeAssignmentTourId = (tourId) => {
  if (typeof tourId !== 'string') return '';
  return tourId
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$[\]/]/g, '')
    .replace(/^_+|_+$/g, '');
};

const resolveAssignmentTourId = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeAssignmentTourId(candidate);
    if (normalized) return normalized;
  }

  return '';
};

const getDriverSnapshotValue = async (driverId) => {
  if (!driverId) return {};
  const snapshot = await get(ref(db, `drivers/${driverId}`));
  return snapshot.val() || {};
};

/**
 * Format date to DD/MM/YYYY
 */
export const formatDateToDDMMYYYY = (date) => {
  if (!date) return '';

  if (date instanceof Date) {
    return formatDateToUK(date);
  }

  const ukParsed = parseUKDateStrict(date);
  if (ukParsed.success) return formatDateToUK(ukParsed.date);

  const isoParsed = parseISODateStrict(date);
  if (isoParsed.success) return formatDateToUK(isoParsed.date);

  return '';
};

/**
 * Parse DD/MM/YYYY to Date object
 */
export const parseDDMMYYYY = (dateStr) => {
  const parsed = parseUKDateStrict(dateStr);
  return parsed.success ? parsed.date : null;
};

/**
 * Convert DD/MM/YYYY to YYYY-MM-DD for input fields
 */
export const ddmmyyyyToInputFormat = (dateStr) => {
  if (!dateStr) return '';
  const parsed = parseUKDateStrict(dateStr);
  if (!parsed.success) return '';
  return formatDateToISO(parsed.date);
};

/**
 * Convert YYYY-MM-DD to DD/MM/YYYY
 */
export const inputFormatToDDMMYYYY = (dateStr) => {
  if (!dateStr) return '';
  const parsed = parseISODateStrict(dateStr);
  if (!parsed.success) return '';
  return formatDateToUK(parsed.date);
};

/**
 * Create a new tour in Firebase
 * @param {Object} tourData - Tour data to create
 * @param {string} createdBy - Email/ID of admin creating the tour
 * @returns {Promise<{id: string, tour: Object}>} - Created tour with ID
 */
export const createTour = async (tourData, _createdBy = 'admin') => {
  const tourCode = trimTourCode(tourData?.tourCode);
  if (!tourCode) {
    throw new Error('Tour code is required to create a tour.');
  }

  const tourId = generateTourId(tourCode);
  await assertTourCodeCanBeCreated(tourId, tourCode);

  const newTour = {
    ...DEFAULT_TOUR,
    ...tourData,
    tourCode,
    // Ensure itinerary structure is correct
    itinerary: tourData.itinerary || {
      title: tourData.name || '',
      days: []
    }
  };

  const tourRef = ref(db, `tours/${tourId}`);
  await set(tourRef, newTour);

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
  await assertTourCodeUnchanged(tourId, updates);

  const tourRef = ref(db, `tours/${tourId}`);
  await update(tourRef, updates);

  return { id: tourId, updates };
};

/**
 * Delete a tour
 * @param {string} tourId - Tour ID to delete
 */
export const deleteTour = async (tourId) => {
  const tourRef = ref(db, `tours/${tourId}`);
  await remove(tourRef);

  return { id: tourId, deleted: true };
};

/**
 * Assign a driver to a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID
 * @param {Object} driverInfo - Driver info {name, phone}
 */
export const assignDriver = async (tourId, driverId, driverInfo) => {
  await applyDriverAssignmentMutation({
    tourId,
    driverId,
    driverCode: driverId,
    driverInfo,
    isAssigned: true,
  });

  return { tourId, driverId, assigned: true };
};

/**
 * Unassign driver from a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID (optional)
 */
export const unassignDriver = async (tourId, driverId = null) => {
  await applyDriverAssignmentMutation({
    tourId,
    driverId,
    driverCode: driverId,
    driverInfo: { name: 'TBA', phone: '' },
    isAssigned: false,
  });

  return { tourId, unassigned: true };
};

const getDriverAssignmentContext = async (tourId, explicitDriverId = null) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  const [tourSnapshot, manifestSnapshot] = await Promise.all([
    get(ref(db, `tours/${normalizedTourId}`)),
    get(ref(db, `tour_manifests/${normalizedTourId}`)),
  ]);

  const tour = tourSnapshot.val() || {};
  const manifest = manifestSnapshot.val() || {};
  const manifestDrivers = manifest.assigned_drivers || {};
  const manifestDriverIds = Object.keys(manifestDrivers);
  const resolvedDriverId = explicitDriverId || manifestDriverIds[0] || null;

  const driver = await getDriverSnapshotValue(resolvedDriverId);
  const currentTourId = resolveAssignmentTourId(driver.currentTourId);
  const assignments = driver.assignments || {};
  const tourCode = trimTourCode(tour?.tourCode);
  if (!tourCode) {
    throw new Error('Tour code is required for driver assignment');
  }

  const knownTourIds = new Set([
    ...Object.keys(assignments).map(normalizeAssignmentTourId).filter(Boolean),
    ...(currentTourId ? [currentTourId] : []),
  ]);

  const staleManifestDriverProfiles = {};
  await Promise.all(
    manifestDriverIds
      .filter((manifestDriverId) => manifestDriverId !== resolvedDriverId)
      .map(async (manifestDriverId) => {
        staleManifestDriverProfiles[manifestDriverId] = await getDriverSnapshotValue(manifestDriverId);
      })
  );

  return {
    tourId: normalizedTourId,
    tourCode,
    driverId: resolvedDriverId,
    driverCode: resolvedDriverId,
    driverAuthUid: driver.authUid || null,
    manifestDriverIds,
    staleManifestDriverProfiles,
    currentTourId,
    assignments,
    knownTourIds,
  };
};

/**
 * Build canonical multi-path updates for driver assignment mutations.
 * Mirrors mobile assignDriverToTour() contract for cross-platform consistency.
 */
export const buildDriverAssignmentUpdates = ({
  tourId,
  driverId,
  driverCode: _driverCode,
  tourCode,
  driverInfo,
  isAssigned,
  actorId = 'web-admin',
  assignedAt = nowAsISOString(),
}) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) {
    throw new Error('Tour ID is required for driver assignment');
  }
  const normalizedTourCode = trimTourCode(tourCode);
  if (isAssigned && !normalizedTourCode) {
    throw new Error('Tour code is required for driver assignment');
  }

  const updates = {
    [`tours/${normalizedTourId}/driverName`]: isAssigned ? driverInfo.name : 'TBA',
    [`tours/${normalizedTourId}/driverPhone`]: isAssigned ? (driverInfo.phone || '') : '',
  };

  if (!driverId) {
    return updates;
  }

  updates[`drivers/${driverId}/currentTourId`] = isAssigned ? normalizedTourId : null;
  updates[`drivers/${driverId}/currentTourCode`] = isAssigned ? normalizedTourCode : null;
  updates[`drivers/${driverId}/assignments/${normalizedTourId}`] = isAssigned ? true : null;

  const driverAuthUid = typeof driverInfo?.authUid === 'string' ? driverInfo.authUid.trim() : '';
  if (driverAuthUid) {
    updates[`users/${driverAuthUid}/driverId`] = driverId;
    updates[`users/${driverAuthUid}/driverPrincipalId`] = `driver:${driverId}`;
    updates[`users/${driverAuthUid}/driverAssignedTourId`] = isAssigned ? normalizedTourId : null;
    updates[`users/${driverAuthUid}/principalType`] = 'driver';
    updates[`users/${driverAuthUid}/lastUpdated`] = Date.now();
  }

  updates[`tour_manifests/${normalizedTourId}/assigned_drivers/${driverId}`] = isAssigned ? true : null;
  updates[`tour_manifests/${normalizedTourId}/assigned_driver_codes/${driverId}`] = isAssigned
    ? {
        driverId,
        tourId: normalizedTourId,
        tourCode: normalizedTourCode,
        assignedAt,
        assignedBy: actorId,
      }
    : null;

  return updates;
};

export const applyDriverAssignmentMutation = async ({
  tourId,
  driverId,
  driverCode,
  driverInfo,
  isAssigned,
  actorId,
  driverProfileUpdates,
}) => {
  const normalizedTourId = normalizeAssignmentTourId(tourId);
  if (!normalizedTourId) {
    throw new Error('Tour ID is required for driver assignment');
  }

  const assignment = await getDriverAssignmentContext(normalizedTourId, driverId);
  const resolvedDriverId = driverId || assignment.driverId;
  const resolvedDriverCode = driverCode || assignment.driverCode;

  const updates = {
    [`tours/${normalizedTourId}/driverName`]: isAssigned ? driverInfo.name : 'TBA',
    [`tours/${normalizedTourId}/driverPhone`]: isAssigned ? (driverInfo.phone || '') : '',
  };

  if (!resolvedDriverId) {
    await update(ref(db), updates);
    return;
  }

  const nextProfileName = typeof driverProfileUpdates?.name === 'string'
    ? driverProfileUpdates.name.trim()
    : '';
  const nextProfilePhone = typeof driverProfileUpdates?.phone === 'string'
    ? driverProfileUpdates.phone.trim()
    : null;
  if (nextProfileName) {
    updates[`drivers/${resolvedDriverId}/name`] = nextProfileName;
  }
  if (nextProfilePhone !== null) {
    updates[`drivers/${resolvedDriverId}/phone`] = nextProfilePhone;
  }

  const cleanupTourIds = new Set(assignment.knownTourIds || []);
  cleanupTourIds.delete(normalizedTourId);

  for (const oldTourId of cleanupTourIds) {
    updates[`drivers/${resolvedDriverId}/assignments/${oldTourId}`] = null;
    updates[`tour_manifests/${oldTourId}/assigned_drivers/${resolvedDriverId}`] = null;
    updates[`tour_manifests/${oldTourId}/assigned_driver_codes/${resolvedDriverId}`] = null;
    updates[`tours/${oldTourId}/driverName`] = 'TBA';
    updates[`tours/${oldTourId}/driverPhone`] = '';
  }

  // Explicit single-driver policy per tour: clear stale links for other drivers in target manifest.
  for (const existingDriverId of assignment.manifestDriverIds || []) {
    if (existingDriverId === resolvedDriverId) continue;
    const staleProfile = assignment.staleManifestDriverProfiles?.[existingDriverId] || {};
    const staleCurrentTourId = resolveAssignmentTourId(staleProfile.currentTourId);

    updates[`drivers/${existingDriverId}/assignments/${normalizedTourId}`] = null;
    updates[`tour_manifests/${normalizedTourId}/assigned_drivers/${existingDriverId}`] = null;
    updates[`tour_manifests/${normalizedTourId}/assigned_driver_codes/${existingDriverId}`] = null;

    if (!staleCurrentTourId || staleCurrentTourId === normalizedTourId) {
      updates[`drivers/${existingDriverId}/currentTourId`] = null;
      updates[`drivers/${existingDriverId}/currentTourCode`] = null;
    }

    const staleAuthUid = typeof staleProfile.authUid === 'string' ? staleProfile.authUid.trim() : '';
    if (staleAuthUid) {
      updates[`users/${staleAuthUid}/driverAssignedTourId`] = null;
      updates[`users/${staleAuthUid}/lastUpdated`] = Date.now();
    }
  }

  Object.assign(
    updates,
    buildDriverAssignmentUpdates({
      tourId: normalizedTourId,
      driverId: resolvedDriverId,
      driverCode: resolvedDriverCode,
      tourCode: assignment.tourCode,
      driverInfo: {
        ...driverInfo,
        authUid: driverInfo?.authUid || assignment.driverAuthUid || null,
      },
      isAssigned,
      actorId,
    }),
  );

  await update(ref(db), updates);
};

/**
 * Update tour active status
 * @param {string} tourId - Tour ID
 * @param {boolean} isActive - Active status
 */
export const updateTourStatus = async (tourId, isActive) => {
  return updateTour(tourId, { isActive });
};

/**
 * Add a pickup point to a tour
 * @param {string} tourId - Tour ID
 * @param {Object} pickupPoint - {location, time}
 */
export const addPickupPoint = async (tourId, pickupPoint) => {
  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  const tour = snapshot.val();

  const pickupPoints = tour.pickupPoints || [];
  pickupPoints.push(pickupPoint);

  await update(tourRef, { pickupPoints });
  return { tourId, pickupPoints };
};

/**
 * Update pickup points for a tour
 * @param {string} tourId - Tour ID
 * @param {Array} pickupPoints - Array of pickup points
 */
export const updatePickupPoints = async (tourId, pickupPoints) => {
  return updateTour(tourId, { pickupPoints });
};

/**
 * Update itinerary for a tour
 * @param {string} tourId - Tour ID
 * @param {Object} itinerary - Itinerary object
 */
export const updateItinerary = async (tourId, itinerary) => {
  return updateTour(tourId, { itinerary });
};

/**
 * Bulk create tours from data
 * @param {Array<Object>} toursData - Array of tour objects
 * @param {string} createdBy - Email/ID of admin
 */
export const bulkCreateTours = async (toursData, createdBy = 'admin') => {
  const results = [];
  const errors = [];

  for (const tourData of toursData) {
    try {
      const result = await createTour(tourData, createdBy);
      results.push(result);
    } catch (error) {
      errors.push({ tourData, error: error.message });
    }
  }

  return { created: results, errors };
};

/**
 * Export tours to CSV format
 * @param {Object} tours - Tours object from Firebase
 * @returns {string} - CSV string
 */
export const exportToursToCSV = (tours) => {
  const headers = [
    'ID',
    'Tour Code',
    'Name',
    'Days',
    'Start Date',
    'End Date',
    'Active',
    'Driver',
    'Driver Phone',
    'Max Participants',
    'Current Participants',
    'Pickup Points',
  ];

  const rows = Object.entries(tours).map(([id, tour]) => [
    id,
    tour.tourCode || '',
    tour.name || '',
    tour.days || 1,
    tour.startDate || '',
    tour.endDate || '',
    tour.isActive ? 'Yes' : 'No',
    tour.driverName || 'TBA',
    tour.driverPhone || '',
    tour.maxParticipants || 53,
    tour.currentParticipants || 0,
    (tour.pickupPoints || []).map(p => `${p.time} - ${p.location}`).join('; '),
  ]);

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
  const snapshot = await get(ref(db, 'tours'));
  const tours = snapshot.exists() ? snapshot.val() : {};
  const existingIndex = getExistingTourCodeIndex(tours);

  return validateTourCsvRows(csvContent, {
    mode,
    ...existingIndex,
  });
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

    try {
      if (mode === 'create-only' || row.action === 'create') {
        const createdTour = await createTour(row.tour, createdBy);
        created.push(createdTour);
        continue;
      }

      if (mode === 'update-existing' || row.action === 'update') {
        const tourId = row.existingTourId || generateTourId(row.tour.tourCode);
        await updateTour(tourId, row.tour);
        updated.push({ id: tourId, tour: row.tour });
      }
    } catch (error) {
      errors.push({ rowNumber: row.rowNumber, error: error.message });
    }
  }

  return { created, updated, errors, attempted: rowsToImport.length };
};

/**
 * Subscribe to tours in real-time
 * @param {Function} callback - Callback function (tours) => void
 * @returns {Function} - Unsubscribe function
 */
export const subscribeToTours = (callback) => {
  const toursRef = ref(db, 'tours');
  return onValue(toursRef, (snapshot) => {
    callback(snapshot.val() || {});
  });
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

  const newTour = {
    ...existingTour,
    name: `${existingTour.name} (Copy)`,
    tourCode: newTourCode,
    driverName: 'TBA',
    driverPhone: '',
    currentParticipants: 0,
  };

  return createTour(newTour, createdBy);
};
