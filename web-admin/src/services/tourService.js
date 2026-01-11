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

import { ref, push, set, update, remove, get, onValue } from 'firebase/database';
import { db } from '../firebase';

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
  return tourCode.replace(/\s+/g, '_');
};

/**
 * Format date to DD/MM/YYYY
 */
export const formatDateToDDMMYYYY = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return date; // Return as-is if already formatted
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * Parse DD/MM/YYYY to Date object
 */
export const parseDDMMYYYY = (dateStr) => {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  return new Date(year, parseInt(month) - 1, parseInt(day));
};

/**
 * Convert DD/MM/YYYY to YYYY-MM-DD for input fields
 */
export const ddmmyyyyToInputFormat = (dateStr) => {
  if (!dateStr) return '';
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;
  const [day, month, year] = parts;
  return `${year}-${month}-${day}`;
};

/**
 * Convert YYYY-MM-DD to DD/MM/YYYY
 */
export const inputFormatToDDMMYYYY = (dateStr) => {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [year, month, day] = parts;
  return `${day}/${month}/${year}`;
};

/**
 * Create a new tour in Firebase
 * @param {Object} tourData - Tour data to create
 * @param {string} createdBy - Email/ID of admin creating the tour
 * @returns {Promise<{id: string, tour: Object}>} - Created tour with ID
 */
export const createTour = async (tourData, createdBy = 'admin') => {
  const tourId = generateTourId(tourData.tourCode);

  const newTour = {
    ...DEFAULT_TOUR,
    ...tourData,
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

  // Calculate end date based on days
  const endDateObj = new Date(today);
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
  const tourRef = ref(db, `tours/${tourId}`);
  await update(tourRef, updates);

  return { id: tourId, updates };
};

/**
 * Delete a tour
 * @param {string} tourId - Tour ID to delete
 */
export const deleteTour = async (tourId) => {
  // First, get the tour to check for driver assignments
  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  const tour = snapshot.val();

  // If there's a driver assigned, we might want to clean up references
  // (depending on your data model)

  // Delete the tour
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
  const updates = {
    [`tours/${tourId}/driverName`]: driverInfo.name,
    [`tours/${tourId}/driverPhone`]: driverInfo.phone || '',
  };

  // Also update driver's assignments if that structure exists
  if (driverId) {
    updates[`drivers/${driverId}/assignments/${tourId}`] = true;
  }

  await update(ref(db), updates);

  return { tourId, driverId, assigned: true };
};

/**
 * Unassign driver from a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID (optional)
 */
export const unassignDriver = async (tourId, driverId = null) => {
  const updates = {
    [`tours/${tourId}/driverName`]: 'TBA',
    [`tours/${tourId}/driverPhone`]: '',
  };

  if (driverId) {
    updates[`drivers/${driverId}/assignments/${tourId}`] = null;
  }

  await update(ref(db), updates);

  return { tourId, unassigned: true };
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

/**
 * Parse CSV content to tour objects
 * @param {string} csvContent - CSV string
 * @returns {Array<Object>} - Array of tour objects
 */
export const parseCSVToTours = (csvContent) => {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const tours = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].match(/("([^"]*)"|[^,]*)/g)?.map(v => v.replace(/^"|"$/g, '').replace(/""/g, '"')) || [];

    const tour = { ...DEFAULT_TOUR };
    headers.forEach((header, index) => {
      const value = values[index] || '';
      switch (header) {
        case 'tour code':
        case 'tourcode':
          tour.tourCode = value;
          break;
        case 'name':
          tour.name = value;
          tour.itinerary = { title: value, days: [] };
          break;
        case 'days':
          tour.days = parseInt(value) || 1;
          break;
        case 'start date':
        case 'startdate':
          tour.startDate = value;
          break;
        case 'end date':
        case 'enddate':
          tour.endDate = value;
          break;
        case 'active':
        case 'isactive':
          tour.isActive = value.toLowerCase() === 'yes' || value === 'true';
          break;
        case 'driver':
        case 'drivername':
          tour.driverName = value || 'TBA';
          break;
        case 'driver phone':
        case 'driverphone':
          tour.driverPhone = value;
          break;
        case 'max participants':
        case 'maxparticipants':
          tour.maxParticipants = parseInt(value) || 53;
          break;
        case 'current participants':
        case 'currentparticipants':
          tour.currentParticipants = parseInt(value) || 0;
          break;
      }
    });

    if (tour.name || tour.tourCode) {
      tours.push(tour);
    }
  }

  return tours;
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
  const newTourCode = `${existingTour.tourCode || tourId}_COPY`;

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
