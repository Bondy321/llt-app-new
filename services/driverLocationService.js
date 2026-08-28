import { normalizeTourId } from './tourIdentityService.js';
import {
  buildDriverLocationSessionKey,
  buildDriverLocationSourcePayload,
  resolveDriverLocationMode,
} from '../utils/driverLocation.js';

export const createDriverLocationSessionId = (now = Date.now, random = Math.random) => (
  `loc_${Math.trunc(now()).toString(36)}_${random().toString(36).slice(2, 12)}`
);

const resolveTourScope = (tourId, dbInstance) => {
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedTourId) throw new Error('A valid tour ID is required');
  if (!dbInstance?.ref) throw new Error('Realtime Database is unavailable');
  return normalizedTourId;
};

const resolveSessionOwnership = ({ sessionScope, appSessionId, authUid, driverId, tourId }) => {
  const scope = sessionScope && typeof sessionScope === 'object' ? sessionScope : {};
  const normalizedTourId = normalizeTourId(tourId);
  const scopeTourId = normalizeTourId(scope.tourId);
  const scopePrincipalId = typeof scope.principalId === 'string' ? scope.principalId.trim() : '';
  const principalDriverId = scopePrincipalId.startsWith('driver:')
    ? scopePrincipalId.slice('driver:'.length)
    : scopePrincipalId.startsWith('D-') ? scopePrincipalId : '';
  const resolved = {
    appSessionId: appSessionId || scope.sessionId || '',
    authUid: authUid || scope.authUid || '',
    driverId: driverId || scope.cacheOwnerId || principalDriverId,
    tourId: normalizedTourId,
  };
  if (scopeTourId && scopeTourId !== normalizedTourId) {
    throw new Error('The app session does not own this tour');
  }
  if (scope.role && scope.role !== 'driver') throw new Error('An active driver app session is required');
  return resolved;
};

const resolveLiveLocationRef = ({ appSessionId, liveSharingSessionId, dbInstance }) => {
  if (!dbInstance?.ref) throw new Error('Realtime Database is unavailable');
  const sessionKey = buildDriverLocationSessionKey(appSessionId, liveSharingSessionId);
  return {
    locationRef: dbInstance.ref(`driver_location_sessions/${sessionKey}`),
    sessionKey,
  };
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
  sessionScope,
  appSessionId,
  authUid,
  driverId,
}) => {
  const publishedAtMs = now();
  const normalizedTourId = resolveTourScope(tourId, dbInstance);
  const ownership = resolveSessionOwnership({
    sessionScope,
    appSessionId,
    authUid,
    driverId,
    tourId: normalizedTourId,
  });
  const payload = buildDriverLocationSourcePayload({
    ...location,
    source,
    address,
    updatedBy,
    liveSharingSessionId: sessionId,
    ...ownership,
    nowMs: publishedAtMs,
  });
  if (!isScopeCurrent()) {
    return {
      success: false,
      skipped: true,
      reason: 'DRIVER_LOCATION_SCOPE_REVOKED',
    };
  }
  const isLive = source === 'auto';
  const { locationRef, sessionKey = null } = isLive
    ? resolveLiveLocationRef({
      appSessionId: ownership.appSessionId,
      liveSharingSessionId: sessionId,
      dbInstance,
    })
    : { locationRef: dbInstance.ref(`driver_location_pickups/${normalizedTourId}`) };
  const disconnectHandler = isLive ? locationRef.onDisconnect?.() : null;
  if (source === 'auto') {
    try {
      if (typeof disconnectHandler?.remove !== 'function') throw new Error('Realtime disconnect cleanup is unavailable');
      // Arm the exact source leaf before publishing so a failed registration
      // can never leave an unowned live-location record behind.
      await disconnectHandler.remove();
      await locationRef.set(payload);
    } catch (error) {
      await withdrawLiveDriverLocation({
        tourId: normalizedTourId,
        appSessionId: ownership.appSessionId,
        dbInstance,
        expectedSessionId: payload.liveSharingSessionId,
      }).catch(() => {});
      throw error;
    }
  } else {
    // A fixed pickup point is a separate durable source and is never targeted
    // by a live session's disconnect registration.
    await locationRef.set(payload);
  }

  if (!isScopeCurrent()) {
    if (source === 'auto') {
      await withdrawLiveDriverLocation({
        tourId: normalizedTourId,
        appSessionId: ownership.appSessionId,
        dbInstance,
        expectedSessionId: payload.liveSharingSessionId,
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
    sessionKey,
    timestamp: storedLocation?.timestamp ?? publishedAtMs,
    storedLocation,
  };
};

export const withdrawDriverLocation = async ({ tourId, dbInstance }) => {
  const normalizedTourId = resolveTourScope(tourId, dbInstance);
  const locationRef = dbInstance.ref(`driver_location_pickups/${normalizedTourId}`);
  await locationRef.remove();
  return { success: true };
};

export const withdrawLiveDriverLocation = async ({
  tourId,
  appSessionId,
  sessionScope,
  dbInstance,
  expectedSessionId,
} = {}) => {
  const normalizedTourId = resolveTourScope(tourId, dbInstance);
  const resolvedAppSessionId = appSessionId || sessionScope?.sessionId || '';
  const { locationRef } = resolveLiveLocationRef({
    appSessionId: resolvedAppSessionId,
    liveSharingSessionId: expectedSessionId,
    dbInstance,
  });
  const transactionResult = await locationRef.transaction((current) => {
    if (!current || resolveDriverLocationMode(current) !== 'live') return undefined;
    if (current.appSessionId !== resolvedAppSessionId) return undefined;
    if (current.liveSharingSessionId !== expectedSessionId) return undefined;
    if (normalizeTourId(current.tourId) !== normalizedTourId) return undefined;
    return null;
  }, undefined, false);
  const removed = transactionResult?.committed === true;
  if (removed) await locationRef.onDisconnect?.().cancel?.();
  return { success: true, removed };
};
