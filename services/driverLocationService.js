import { normalizeTourId } from './tourIdentityService.js';
import {
  buildDriverLocationSessionKey,
  buildDriverLocationSourcePayload,
} from '../utils/driverLocation.js';

// Serialize only the exact private leaf. Separate installations/sharing sessions
// remain independent, and settled queues release their references.
const liveOperations = new WeakMap();
const getLiveOperationState = (dbInstance, sessionKey) => {
  let queues = liveOperations.get(dbInstance);
  if (!queues) { queues = new Map(); liveOperations.set(dbInstance, queues); }
  let state = queues.get(sessionKey);
  if (!state) {
    state = { tail: Promise.resolve(), withdrawalRequested: false };
    queues.set(sessionKey, state);
  }
  return { queues, state };
};

const runLiveOperation = (dbInstance, sessionKey, operation, withdraw = false) => {
  const { queues, state } = getLiveOperationState(dbInstance, sessionKey);
  if (withdraw) state.withdrawalRequested = true;
  const result = state.tail.catch(() => {}).then(() => operation(state));
  state.tail = result;
  const release = () => {
    if (queues.get(sessionKey) === state && state.tail === result) queues.delete(sessionKey);
  };
  result.then(release, release);
  return result;
};

const removeLiveSource = async (locationRef) => {
  await locationRef.remove();
  let disconnectCancelled = false;
  try {
    const handler = locationRef.onDisconnect?.();
    if (typeof handler?.cancel === 'function') {
      await handler.cancel();
      disconnectCancelled = true;
    }
  } catch {
    // Deletion already has a server acknowledgement. A remaining disconnect
    // delete on this retired leaf is harmless; do not report a false failure.
  }
  return { success: true, removed: true, withdrawalAcknowledged: true, disconnectCancelled };
};

const skippedLivePublication = async (locationRef, reason) => {
  try {
    const cleanup = await removeLiveSource(locationRef);
    return { success: false, skipped: true, reason, withdrawalAcknowledged: cleanup.withdrawalAcknowledged };
  } catch {
    return { success: false, skipped: true, reason, withdrawalAcknowledged: false, cleanupPending: true };
  }
};

const estimatePublicationTime = async (dbInstance, now) => {
  let offset = null;
  try {
    // Built-in connection metadata is readable; private location sources are not.
    const snapshot = await dbInstance.ref('.info/serverTimeOffset').once('value');
    const value = snapshot?.val?.();
    if (typeof value === 'number' && Number.isFinite(value)) offset = value;
  } catch { /* A clock estimate is still available when metadata cannot be read. */ }
  return {
    timestamp: Math.trunc(now() + (offset ?? 0)),
    timestampSource: offset === null ? 'client_estimate' : 'server_estimate',
  };
};

export const createDriverLocationSessionId = (now = Date.now, random = Math.random) => (
  `loc_${Math.trunc(now()).toString(36)}_${random().toString(36).slice(2, 12)}`
);

const resolveTourScope = (tourId, dbInstance) => {
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedTourId) throw new Error('A valid tour ID is required');
  if (typeof dbInstance?.ref !== 'function') throw new Error('Realtime Database is unavailable');
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
  for (const [provided, expected] of [
    [appSessionId, scope.sessionId], [authUid, scope.authUid],
    [driverId, scope.cacheOwnerId || principalDriverId],
  ]) {
    if (provided && expected && provided !== expected) throw new Error('The location identity conflicts with its app session');
  }
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
  pickupMutation,
}) => {
  const normalizedTourId = resolveTourScope(tourId, dbInstance);
  const ownership = resolveSessionOwnership({
    sessionScope,
    appSessionId,
    authUid,
    driverId,
    tourId: normalizedTourId,
  });
  if (!isScopeCurrent()) {
    return {
      success: false,
      skipped: true,
      reason: 'DRIVER_LOCATION_SCOPE_REVOKED',
    };
  }
  if (source !== 'auto') {
    const publishedAtMs = now();
    const mutatePickup = pickupMutation
      || (await import('./driverLocationPickupApi.js')).mutateDriverLocationPickup;
    const result = await mutatePickup({
      operation: 'publish',
      tourId: normalizedTourId,
      location,
      address,
      sessionScope: { ...sessionScope, ...ownership },
    });
    const storedLocation = result.pickup || null;
    return {
      success: true,
      ...(storedLocation || {}),
      timestamp: storedLocation?.timestamp ?? publishedAtMs,
      storedLocation,
    };
  }
  const { locationRef, sessionKey } = resolveLiveLocationRef({
    appSessionId: ownership.appSessionId, liveSharingSessionId: sessionId, dbInstance,
  });
  return runLiveOperation(dbInstance, sessionKey, async (state) => {
    if (state.withdrawalRequested || !isScopeCurrent()) {
      return { success: false, skipped: true, reason: 'DRIVER_LOCATION_SCOPE_REVOKED' };
    }
    // Validate before arming any remote operation; refresh the lease after waits.
    buildDriverLocationSourcePayload({ ...location, source, address, updatedBy,
      liveSharingSessionId: sessionId, ...ownership, nowMs: now() });
    const disconnectHandler = locationRef.onDisconnect?.();
    if (typeof disconnectHandler?.remove !== 'function') throw new Error('Realtime disconnect cleanup is unavailable');
    await disconnectHandler.remove();
    if (state.withdrawalRequested || !isScopeCurrent()) {
      return skippedLivePublication(locationRef, 'DRIVER_LOCATION_SCOPE_REVOKED_BEFORE_WRITE');
    }
    const estimate = await estimatePublicationTime(dbInstance, now);
    if (state.withdrawalRequested || !isScopeCurrent()) {
      return skippedLivePublication(locationRef, 'DRIVER_LOCATION_SCOPE_REVOKED_BEFORE_WRITE');
    }
    const payload = buildDriverLocationSourcePayload({ ...location, source, address, updatedBy,
      liveSharingSessionId: sessionId, ...ownership, nowMs: estimate.timestamp });
    try {
      await locationRef.set(payload);
    } catch (error) {
      // A rejected write is rolled back by Firebase. Preserve an earlier good
      // publication and its disconnect cleanup unless the scope was stopped.
      if (state.withdrawalRequested || !isScopeCurrent()) {
        await skippedLivePublication(locationRef, 'DRIVER_LOCATION_SCOPE_REVOKED_AFTER_WRITE');
      }
      throw error;
    }
    if (state.withdrawalRequested || !isScopeCurrent()) {
      return skippedLivePublication(locationRef, 'DRIVER_LOCATION_SCOPE_REVOKED_AFTER_WRITE');
    }
    return { success: true, ...payload, sessionKey, timestamp: estimate.timestamp,
      timestampSource: estimate.timestampSource, publicationAcknowledged: true, storedLocation: null };
  });
};

export const withdrawDriverLocation = async ({ tourId, sessionScope, pickupMutation }) => {
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedTourId) throw new Error('A valid tour ID is required');
  const mutatePickup = pickupMutation
    || (await import('./driverLocationPickupApi.js')).mutateDriverLocationPickup;
  return mutatePickup({ operation: 'withdraw', tourId: normalizedTourId, sessionScope });
};

export const withdrawLiveDriverLocation = async ({
  tourId,
  appSessionId,
  sessionScope,
  dbInstance,
  expectedSessionId,
} = {}) => {
  resolveTourScope(tourId, dbInstance);
  const resolvedAppSessionId = appSessionId || sessionScope?.sessionId || '';
  const { locationRef, sessionKey } = resolveLiveLocationRef({
    appSessionId: resolvedAppSessionId,
    liveSharingSessionId: expectedSessionId,
    dbInstance,
  });
  // The canonical key and server rules bind ownership. A client transaction
  // would require forbidden reads and can falsely abort on an empty SDK cache.
  return runLiveOperation(dbInstance, sessionKey, () => removeLiveSource(locationRef), true);
};
