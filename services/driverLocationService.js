import { normalizeTourId } from './tourIdentityService.js';
import {
  buildDriverLocationPayload,
  getDriverPickupFallback,
  resolveDriverLocationMode,
} from '../utils/driverLocation.js';

export const createDriverLocationSessionId = (now = Date.now, random = Math.random) => (
  `loc_${Math.trunc(now()).toString(36)}_${random().toString(36).slice(2, 12)}`
);

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
  isScopeCurrent = () => true,
  sessionId,
}) => {
  const publishedAtMs = now();
  const payload = buildDriverLocationPayload({
    ...location,
    source,
    address,
    updatedBy,
    sessionId,
    nowMs: publishedAtMs,
  });
  if (!isScopeCurrent()) {
    return {
      success: false,
      skipped: true,
      reason: 'DRIVER_LOCATION_SCOPE_REVOKED',
    };
  }
  const locationRef = resolveLocationRef(tourId, dbInstance);
  const disconnectHandler = locationRef.onDisconnect?.();
  let writeSnapshot = null;
  if (source === 'auto') {
    const writeResult = await locationRef.transaction((current) => {
      const fallbackPickup = getDriverPickupFallback(current);
      return fallbackPickup ? { ...payload, fallbackPickup } : payload;
    }, undefined, false);
    if (writeResult?.committed !== true) throw new Error('Live location publication was not committed');
    writeSnapshot = writeResult.snapshot?.val?.() || null;
    try {
      const fallbackPickup = getDriverPickupFallback(writeSnapshot);
      if (fallbackPickup) {
        if (typeof disconnectHandler?.set !== 'function') {
          throw new Error('Realtime disconnect fallback is unavailable');
        }
        await disconnectHandler.set(fallbackPickup);
      } else if (typeof disconnectHandler?.remove === 'function') {
        await disconnectHandler.remove();
      } else {
        throw new Error('Realtime disconnect cleanup is unavailable');
      }
    } catch (error) {
      await withdrawLiveDriverLocation({
        tourId,
        dbInstance,
        expectedSessionId: payload.sessionId,
      }).catch(() => {});
      throw error;
    }
  } else {
    // A fixed pickup point is deliberately durable; an earlier live-session
    // disconnect hook must never remove it.
    if (typeof disconnectHandler?.cancel !== 'function') {
      throw new Error('Realtime disconnect cleanup is unavailable');
    }
    await disconnectHandler.cancel();
    await locationRef.set(payload);
  }

  if (!isScopeCurrent()) {
    if (source === 'auto') {
      await withdrawLiveDriverLocation({
        tourId,
        dbInstance,
        expectedSessionId: payload.sessionId,
      });
    }
    return {
      success: false,
      skipped: true,
      reason: 'DRIVER_LOCATION_SCOPE_REVOKED_AFTER_WRITE',
    };
  }

  let storedLocation = null;
  if (typeof locationRef.once === 'function') {
    const snapshot = await locationRef.once('value');
    storedLocation = snapshot?.val?.() || null;
  }
  return {
    success: true,
    ...payload,
    timestamp: storedLocation?.timestamp ?? publishedAtMs,
    storedLocation,
  };
};

export const withdrawDriverLocation = async ({ tourId, dbInstance }) => {
  const locationRef = resolveLocationRef(tourId, dbInstance);
  await locationRef.remove();
  await locationRef.onDisconnect?.().cancel?.();
  return { success: true };
};

export const withdrawLiveDriverLocation = async ({ tourId, dbInstance, expectedSessionId } = {}) => {
  const locationRef = resolveLocationRef(tourId, dbInstance);
  const transactionResult = await locationRef.transaction((current) => {
    if (!current || resolveDriverLocationMode(current) !== 'live') return undefined;
    if (expectedSessionId && current.sessionId !== expectedSessionId) return undefined;
    return getDriverPickupFallback(current);
  }, undefined, false);
  const removed = transactionResult?.committed === true;
  if (removed) await locationRef.onDisconnect?.().cancel?.();
  return { success: true, removed };
};
