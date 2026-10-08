import { buildDriverLocationSessionKey } from '../../utils/driverLocation.js';
import { trackingFencePayload } from './trackingIntent.js';
import { withTrackingTimeout } from './withTrackingTimeout.js';

// HTTP writes cannot replay Firebase's offline queue. Never expose URLs/tokens
// in errors or logs, including errors thrown by an injected/native fetch.
export const createTrackingRestRepository = ({ database, auth, baseUrl, retireEndpoint,
  fetchFn = (...args) => fetch(...args), timeoutMs = 10_000 }) => {
  const bounded = operation => withTrackingTimeout(operation, timeoutMs);
  const publicationGuards = new Map();
  const request = async (path, payload, expectedUid, endpoint = null, isScopeCurrent = () => true) => {
    let token;
    try {
      if (!isScopeCurrent()) throw new Error('START_INTERRUPTED');
      await bounded(() => auth.authStateReady?.());
      const currentUser = auth.currentUser;
      if (!currentUser || (expectedUid && currentUser.uid !== expectedUid)) throw new Error('AUTH_UID_CHANGED');
      token = await bounded(() => currentUser.getIdToken());
      if (auth.currentUser?.uid !== currentUser.uid) throw new Error('AUTH_UID_CHANGED');
      // Token restoration can take seconds. Recheck Stop, session identity and
      // sample freshness immediately before dispatch, not just before auth.
      if (!isScopeCurrent()) throw new Error('START_INTERRUPTED');
    } catch (error) {
      if (error.message === 'AUTH_UID_CHANGED' || error.message === 'START_INTERRUPTED') throw error;
      throw new Error('TRACKING_NETWORK_ERROR');
    }
    const controller = new AbortController();
    let timer;
    try {
      let url;
      if (endpoint) url = endpoint;
      else {
        const target = new URL(baseUrl);
        target.pathname = `/${path.split('/').map(encodeURIComponent).join('/')}.json`;
        target.searchParams.set('auth', token);
        url = target.toString();
      }
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await bounded(() => fetchFn(url, {
        method: endpoint ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', ...(endpoint ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload), signal: controller.signal,
      }));
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'TRACKING_NETWORK_ERROR');
        error.code = error.message;
        throw error;
      }
      if (!endpoint) return { acknowledged: true };
      const result = await bounded(() => response.json());
      if (result?.success !== true || result?.withdrawalAcknowledged !== true) throw new Error('TRACKING_NETWORK_ERROR');
      return result;
    } catch (error) {
      if (error.code === 'PERMISSION_DENIED') throw error;
      throw new Error('TRACKING_NETWORK_ERROR');
    } finally { clearTimeout(timer); controller.abort(); }
  };
  const facade = { ref: path => {
    if (path.startsWith('.info/')) return { once: event => bounded(() => database.ref(path).once(event)) };
    if (!/^driver_location_sessions\/sess_v1_[a-f0-9]{32}\|track_[A-Za-z0-9_-]{8,74}$/.test(path)) {
      throw new Error('INVALID_TRACKING_PATH');
    }
    const sdkRef = database.ref(path);
    const isScopeCurrent = publicationGuards.get(path);
    return { set: value => request(path, value, value.authUid, null, isScopeCurrent), remove: () => request(path, null),
      onDisconnect: () => ({
        remove: () => bounded(() => sdkRef.onDisconnect().remove()),
        cancel: () => bounded(() => sdkRef.onDisconnect().cancel()),
      }) };
  } };
  return {
    database: facade,
    withPublicationGuard: async (intent, isScopeCurrent, operation) => {
      const key = buildDriverLocationSessionKey(intent.scope.sessionId, intent.liveSharingSessionId);
      const path = `driver_location_sessions/${key}`;
      publicationGuards.set(path, isScopeCurrent);
      try { return await operation(); }
      finally { if (publicationGuards.get(path) === isScopeCurrent) publicationGuards.delete(path); }
    },
    writeFence: (intent, status, isScopeCurrent) => request(
      `driver_tracking_sessions/${buildDriverLocationSessionKey(intent.scope.sessionId, intent.liveSharingSessionId)}`,
      trackingFencePayload(intent, status), intent.scope.authUid, null, isScopeCurrent,
    ),
    retireSession: async intent => {
      if (!retireEndpoint) return Promise.reject(new Error('TRACKING_SERVICE_NOT_CONFIGURED'));
      const result = await request(null, trackingFencePayload(intent, 'stopped'), intent.scope.authUid, retireEndpoint);
      try {
        const key = buildDriverLocationSessionKey(intent.scope.sessionId, intent.liveSharingSessionId);
        await bounded(() => database.ref(`driver_location_sessions/${key}`).onDisconnect().cancel());
      } catch { /* A remaining delete on this stopped leaf is harmless. */ }
      return result;
    },
  };
};
