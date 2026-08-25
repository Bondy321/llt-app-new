import {
  ref,
  update,
  get,
  db,
} from './tourServiceContext';
import { createTour, updateTour } from './tourCrudService';

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
