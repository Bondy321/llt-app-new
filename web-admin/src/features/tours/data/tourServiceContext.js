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

import { ref, update, get, onValue, runTransaction } from 'firebase/database';
import { db } from '../../../firebase';
import { validateTourCsvRows } from '../../../services/tourCsvService';
import { postAdminAction } from '../../../services/adminActionService';
import {
  parseUKDateStrict,
  parseISODateStrict,
  formatDateToUK,
  formatDateToISO,
  nowAsISOString,
} from '../../../utils/dateUtils';
export { parseUKDateStrict, parseISODateStrict } from '../../../utils/dateUtils';

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

export const hasOwn = (value, property) => Object.prototype.hasOwnProperty.call(value || {}, property);

export const trimTourCode = (tourCode) => (typeof tourCode === 'string' ? tourCode.trim() : '');

export const tourCodesReferToSameKey = (left, right) => {
  const leftCode = trimTourCode(left);
  const rightCode = trimTourCode(right);
  if (!leftCode || !rightCode) return false;
  return generateTourId(leftCode) === generateTourId(rightCode);
};

export const buildTourCodeConflictMessage = (tourCode, tourId) => (
  `Tour code "${tourCode}" already exists at tours/${tourId}. Choose a unique tour code.`
);

export const assertTourCodeUnchanged = (tourId, updates, existingTour = {}) => {
  if (!hasOwn(updates, 'tourCode')) return;

  const nextTourCode = trimTourCode(updates.tourCode);
  if (!nextTourCode) {
    throw new Error('Tour code cannot be cleared after creation.');
  }

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

export const parseTourServiceDate = (value) => {
  const uk = parseUKDateStrict(value);
  if (uk.success) return uk.date;
  const iso = parseISODateStrict(value);
  return iso.success ? iso.date : null;
};

export const toUtcDateOnlyMs = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());

export const buildTourDateIndexFields = (tourData = {}) => {
  const hasStartDate = typeof tourData.startDate === 'string' && tourData.startDate.trim();
  const hasEndDate = typeof tourData.endDate === 'string' && tourData.endDate.trim();
  if (!hasStartDate && !hasEndDate) return {};
  const startDate = parseTourServiceDate(tourData.startDate);
  const endDate = parseTourServiceDate(tourData.endDate || tourData.startDate);
  if (!startDate || !endDate) {
    throw new Error('Tour start and end dates must be valid before their admin query indexes can be written.');
  }
  return {
    startDateEpochMs: toUtcDateOnlyMs(startDate),
    endDateEpochMs: toUtcDateOnlyMs(endDate),
  };
};

export const assertChronologicalTourDates = (tourData = {}) => {
  const hasStartDate = hasOwn(tourData, 'startDate') && String(tourData.startDate || '').trim();
  const hasEndDate = hasOwn(tourData, 'endDate') && String(tourData.endDate || '').trim();
  if (!hasStartDate && !hasEndDate) return;
  if (!hasStartDate || !hasEndDate) {
    throw new Error('Tour start and end dates must be provided together.');
  }
  const startDate = parseTourServiceDate(tourData.startDate);
  const endDate = parseTourServiceDate(tourData.endDate);
  if (!startDate || !endDate) {
    throw new Error('Tour start and end dates must be valid calendar dates.');
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error('Tour end date cannot be before its start date.');
  }
};

export const assertValidTourCapacity = (tourData = {}) => {
  const maxParticipants = Number(tourData.maxParticipants);
  const currentParticipants = Number(tourData.currentParticipants);
  if (!Number.isInteger(maxParticipants) || maxParticipants < 1 || maxParticipants > 500) {
    throw new Error('Tour capacity must be a whole number between 1 and 500.');
  }
  if (!Number.isInteger(currentParticipants) || currentParticipants < 0) {
    throw new Error('Booked participant count must be a non-negative whole number.');
  }
  if (currentParticipants > maxParticipants) {
    throw new Error('Tour capacity cannot be lower than the booked participant count.');
  }
};

export const assertTourCapacityUpdate = (existingTour, updates) => {
  if (!hasOwn(updates, 'maxParticipants') && !hasOwn(updates, 'currentParticipants')) return;
  assertValidTourCapacity({ ...DEFAULT_TOUR, ...existingTour, ...updates });
};

export const normalizeAssignmentTourId = (tourId) => {
  if (typeof tourId !== 'string') return '';
  return tourId
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$[\]/]/g, '')
    .replace(/^_+|_+$/g, '');
};

export const resolveAssignmentTourId = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeAssignmentTourId(candidate);
    if (normalized) return normalized;
  }

  return '';
};

export const getDriverSnapshotValue = async (driverId) => {
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
export { db, formatDateToISO, formatDateToUK, get, nowAsISOString, onValue, postAdminAction, ref, runTransaction, update, validateTourCsvRows };
