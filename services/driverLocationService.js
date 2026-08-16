import { normalizeTourId } from './tourIdentityService.js';
import { buildDriverLocationPayload, resolveDriverLocationMode } from '../utils/driverLocation.js';

const resolveLocationRef = (tourId, dbInstance) => {
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedTourId) throw new Error('A valid tour ID is required');
  if (!dbInstance?.ref) throw new Error('Realtime Database is unavailable');
  return dbInstance.ref(`tours/${normalizedTourId}/driverLocation`);
};

export const publishDriverLocation = async ({
  tourId,
  location,
  source = 'manual',
  address,
  updatedBy,
  dbInstance,
  now = Date.now,
}) => {
  const payload = buildDriverLocationPayload({
    ...location,
    source,
    address,
    updatedBy,
  });
  await resolveLocationRef(tourId, dbInstance).set(payload);
  return {
    ...payload,
    timestamp: now(),
  };
};

export const withdrawDriverLocation = async ({ tourId, dbInstance }) => {
  await resolveLocationRef(tourId, dbInstance).remove();
  return { success: true };
};

export const withdrawLiveDriverLocation = async ({ tourId, dbInstance }) => {
  const locationRef = resolveLocationRef(tourId, dbInstance);
  let removed = false;
  await locationRef.transaction((current) => {
    if (!current || resolveDriverLocationMode(current) !== 'live') return undefined;
    removed = true;
    return null;
  }, undefined, false);
  return { success: true, removed };
};
