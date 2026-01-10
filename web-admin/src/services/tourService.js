/**
 * Tour Service - Firebase Realtime Database Operations
 *
 * This service provides a clean API for managing tours in Firebase Realtime Database.
 * All operations are real-time and sync automatically across all connected clients.
 *
 * FIREBASE DATABASE STRUCTURE:
 * ============================
 * tours/
 * ├── {tourId}/                    # Unique tour identifier (e.g., "5100D_138")
 * │   ├── name                     # Tour display name
 * │   ├── description              # Tour description
 * │   ├── tourType                 # Type: 'scenic', 'adventure', 'city', 'custom'
 * │   ├── status                   # Status: 'scheduled', 'in_progress', 'completed', 'cancelled'
 * │   ├── driverName               # Assigned driver name or 'TBA'
 * │   ├── driverPhone              # Driver contact number
 * │   ├── driverId                 # Driver ID reference
 * │   ├── departureTime            # Scheduled departure time
 * │   ├── departureLocation        # Starting point
 * │   ├── arrivalLocation          # End point
 * │   ├── estimatedDuration        # Duration in minutes
 * │   ├── maxPassengers            # Maximum passenger capacity
 * │   ├── currentPassengers        # Current passenger count
 * │   ├── price                    # Tour price
 * │   ├── notes                    # Additional notes
 * │   ├── stops                    # Array of tour stops
 * │   ├── createdAt                # Creation timestamp
 * │   ├── updatedAt                # Last update timestamp
 * │   └── createdBy                # Admin who created the tour
 *
 * HOW TO ADD A NEW TOUR:
 * ======================
 * 1. Use createTour() function with tour data object
 * 2. The function generates a unique ID and writes to Firebase
 * 3. All connected clients receive the update in real-time
 *
 * Example:
 *   await createTour({
 *     name: 'Loch Lomond Scenic Tour',
 *     tourType: 'scenic',
 *     departureTime: '2024-01-15T09:00',
 *     departureLocation: 'Glasgow Central',
 *     maxPassengers: 45
 *   });
 */

import { ref, push, set, update, remove, get, onValue } from 'firebase/database';
import { db } from '../firebase';

// Tour type definitions for reference
export const TOUR_TYPES = {
  scenic: { label: 'Scenic Tour', color: 'green', icon: 'mountain' },
  adventure: { label: 'Adventure Tour', color: 'orange', icon: 'compass' },
  city: { label: 'City Tour', color: 'blue', icon: 'building' },
  historical: { label: 'Historical Tour', color: 'purple', icon: 'landmark' },
  wildlife: { label: 'Wildlife Tour', color: 'teal', icon: 'deer' },
  custom: { label: 'Custom Tour', color: 'gray', icon: 'map' },
};

// Tour status definitions
export const TOUR_STATUSES = {
  scheduled: { label: 'Scheduled', color: 'blue' },
  in_progress: { label: 'In Progress', color: 'orange' },
  completed: { label: 'Completed', color: 'green' },
  cancelled: { label: 'Cancelled', color: 'red' },
};

// Default tour template
export const DEFAULT_TOUR = {
  name: '',
  description: '',
  tourType: 'scenic',
  status: 'scheduled',
  driverName: 'TBA',
  driverPhone: '',
  driverId: null,
  departureTime: '',
  departureLocation: '',
  arrivalLocation: '',
  estimatedDuration: 120, // 2 hours default
  maxPassengers: 45,
  currentPassengers: 0,
  price: 0,
  notes: '',
  stops: [],
};

// Pre-defined tour templates for quick creation
export const TOUR_TEMPLATES = {
  lochLomond: {
    name: 'Loch Lomond Explorer',
    description: 'Discover the breathtaking beauty of Loch Lomond and the Trossachs National Park.',
    tourType: 'scenic',
    departureLocation: 'Glasgow Central Station',
    arrivalLocation: 'Glasgow Central Station',
    estimatedDuration: 480, // 8 hours
    maxPassengers: 45,
    price: 59,
    stops: ['Balloch', 'Luss Village', 'Tarbet', 'The Drovers Inn', 'Aberfoyle'],
  },
  highlands: {
    name: 'Scottish Highlands Day Trip',
    description: 'Journey through the stunning Scottish Highlands, visiting historic castles and scenic viewpoints.',
    tourType: 'adventure',
    departureLocation: 'Edinburgh Waverley',
    arrivalLocation: 'Edinburgh Waverley',
    estimatedDuration: 600, // 10 hours
    maxPassengers: 45,
    price: 75,
    stops: ['Stirling Castle', 'Glencoe', 'Fort William', 'Loch Ness', 'Pitlochry'],
  },
  edinburghCity: {
    name: 'Edinburgh City Tour',
    description: 'Explore the historic and cultural highlights of Scotland\'s capital city.',
    tourType: 'city',
    departureLocation: 'Royal Mile',
    arrivalLocation: 'Royal Mile',
    estimatedDuration: 180, // 3 hours
    maxPassengers: 20,
    price: 35,
    stops: ['Edinburgh Castle', 'Holyrood Palace', 'Arthur\'s Seat', 'Old Town', 'New Town'],
  },
  stirlingHistoric: {
    name: 'Stirling & Braveheart Country',
    description: 'Step back in time and explore the historic heart of Scotland.',
    tourType: 'historical',
    departureLocation: 'Glasgow Queen Street',
    arrivalLocation: 'Glasgow Queen Street',
    estimatedDuration: 360, // 6 hours
    maxPassengers: 45,
    price: 49,
    stops: ['Stirling Castle', 'Wallace Monument', 'Bannockburn', 'Doune Castle'],
  },
  wildlife: {
    name: 'Highland Wildlife Safari',
    description: 'Spot red deer, golden eagles, and other Scottish wildlife in their natural habitat.',
    tourType: 'wildlife',
    departureLocation: 'Inverness Bus Station',
    arrivalLocation: 'Inverness Bus Station',
    estimatedDuration: 420, // 7 hours
    maxPassengers: 16, // Smaller group for wildlife
    price: 85,
    stops: ['Cairngorms', 'Glen Affric', 'Black Isle', 'Loch Maree'],
  },
};

/**
 * Generate a unique tour ID
 * Format: {prefix}_{timestamp}_{random}
 */
export const generateTourId = (prefix = 'TOUR') => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}_${timestamp}_${random}`;
};

/**
 * Create a new tour in Firebase
 * @param {Object} tourData - Tour data to create
 * @param {string} createdBy - Email/ID of admin creating the tour
 * @returns {Promise<{id: string, tour: Object}>} - Created tour with ID
 */
export const createTour = async (tourData, createdBy = 'admin') => {
  const tourId = tourData.id || generateTourId();
  const now = new Date().toISOString();

  const newTour = {
    ...DEFAULT_TOUR,
    ...tourData,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };

  // Remove the id field from tour data if it was included
  delete newTour.id;

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

  return createTour({ ...template, ...overrides }, createdBy);
};

/**
 * Update an existing tour
 * @param {string} tourId - Tour ID to update
 * @param {Object} updates - Fields to update
 */
export const updateTour = async (tourId, updates) => {
  const updateData = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const tourRef = ref(db, `tours/${tourId}`);
  await update(tourRef, updateData);

  return { id: tourId, updates: updateData };
};

/**
 * Delete a tour
 * @param {string} tourId - Tour ID to delete
 */
export const deleteTour = async (tourId) => {
  // First, remove any driver assignments
  const tourRef = ref(db, `tours/${tourId}`);
  const snapshot = await get(tourRef);
  const tour = snapshot.val();

  if (tour?.driverId) {
    // Remove the tour from driver's assignments
    const driverAssignmentRef = ref(db, `drivers/${tour.driverId}/assignments/${tourId}`);
    await remove(driverAssignmentRef);
  }

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
    [`tours/${tourId}/driverId`]: driverId,
    [`tours/${tourId}/updatedAt`]: new Date().toISOString(),
    [`drivers/${driverId}/assignments/${tourId}`]: true,
  };

  await update(ref(db), updates);

  return { tourId, driverId, assigned: true };
};

/**
 * Unassign driver from a tour
 * @param {string} tourId - Tour ID
 * @param {string} driverId - Driver ID (optional, will find if not provided)
 */
export const unassignDriver = async (tourId, driverId = null) => {
  // Get the tour to find the driver if not provided
  if (!driverId) {
    const tourRef = ref(db, `tours/${tourId}`);
    const snapshot = await get(tourRef);
    const tour = snapshot.val();
    driverId = tour?.driverId;
  }

  const updates = {
    [`tours/${tourId}/driverName`]: 'TBA',
    [`tours/${tourId}/driverPhone`]: '',
    [`tours/${tourId}/driverId`]: null,
    [`tours/${tourId}/updatedAt`]: new Date().toISOString(),
  };

  if (driverId) {
    updates[`drivers/${driverId}/assignments/${tourId}`] = null;
  }

  await update(ref(db), updates);

  return { tourId, unassigned: true };
};

/**
 * Update tour status
 * @param {string} tourId - Tour ID
 * @param {string} status - New status
 */
export const updateTourStatus = async (tourId, status) => {
  if (!TOUR_STATUSES[status]) {
    throw new Error(`Invalid status "${status}"`);
  }

  return updateTour(tourId, { status });
};

/**
 * Bulk create tours from CSV data
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
    'Name',
    'Type',
    'Status',
    'Driver',
    'Departure Time',
    'Departure Location',
    'Arrival Location',
    'Duration (min)',
    'Max Passengers',
    'Current Passengers',
    'Price',
    'Notes',
  ];

  const rows = Object.entries(tours).map(([id, tour]) => [
    id,
    tour.name || '',
    tour.tourType || '',
    tour.status || '',
    tour.driverName || 'TBA',
    tour.departureTime || '',
    tour.departureLocation || '',
    tour.arrivalLocation || '',
    tour.estimatedDuration || '',
    tour.maxPassengers || '',
    tour.currentPassengers || '',
    tour.price || '',
    tour.notes || '',
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

    const tour = {};
    headers.forEach((header, index) => {
      const value = values[index] || '';
      switch (header) {
        case 'id':
          if (value) tour.id = value;
          break;
        case 'name':
          tour.name = value;
          break;
        case 'type':
        case 'tourtype':
          tour.tourType = value || 'custom';
          break;
        case 'status':
          tour.status = value || 'scheduled';
          break;
        case 'driver':
        case 'drivername':
          tour.driverName = value || 'TBA';
          break;
        case 'departure time':
        case 'departuretime':
          tour.departureTime = value;
          break;
        case 'departure location':
        case 'departurelocation':
          tour.departureLocation = value;
          break;
        case 'arrival location':
        case 'arrivallocation':
          tour.arrivalLocation = value;
          break;
        case 'duration (min)':
        case 'duration':
        case 'estimatedduration':
          tour.estimatedDuration = parseInt(value) || 120;
          break;
        case 'max passengers':
        case 'maxpassengers':
          tour.maxPassengers = parseInt(value) || 45;
          break;
        case 'current passengers':
        case 'currentpassengers':
          tour.currentPassengers = parseInt(value) || 0;
          break;
        case 'price':
          tour.price = parseFloat(value) || 0;
          break;
        case 'notes':
          tour.notes = value;
          break;
      }
    });

    if (tour.name) {
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

  const newTour = {
    ...existingTour,
    name: `${existingTour.name} (Copy)`,
    status: 'scheduled',
    driverName: 'TBA',
    driverPhone: '',
    driverId: null,
    currentPassengers: 0,
  };

  // Remove timestamps to get fresh ones
  delete newTour.createdAt;
  delete newTour.updatedAt;
  delete newTour.createdBy;

  return createTour(newTour, createdBy);
};
