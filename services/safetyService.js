import { realtimeDb } from '../firebase';
import logger from './loggerService';

export const SAFETY_CATEGORIES = {
  DELAY: 'delay',
  INCIDENT: 'incident',
  MEDICAL: 'medical',
  LOST_PASSENGER: 'lost_passenger',
  VEHICLE_ISSUE: 'vehicle_issue',
};

const buildPayload = ({
  userId,
  bookingId,
  tourId,
  role,
  category,
  message,
  coords,
}) => ({
  category,
  message,
  role,
  tourId: tourId || null,
  bookingId: bookingId || null,
  timestamp: new Date().toISOString(),
  coords: coords
    ? {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
      }
    : null,
  clientVersion: 'app',
  userId: userId || 'anonymous',
});

export async function logSafetyEvent(params) {
  const {
    userId,
    bookingId,
    tourId,
    role,
    category,
    message,
    coords = null,
  } = params;

  const sanitizedUserId = userId || 'anonymous';
  const payload = buildPayload({
    userId: sanitizedUserId,
    bookingId,
    tourId,
    role,
    category,
    message,
    coords,
  });

  try {
    const ref = realtimeDb.ref(`logs/${sanitizedUserId}/safety`).push();
    await ref.set(payload);
    await logger.warn('Safety', 'Safety event recorded', payload);
    return payload;
  } catch (error) {
    await logger.error('Safety', 'Failed to log safety event', { error: error.message });
    throw error;
  }
}
