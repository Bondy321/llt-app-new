import { buildDriverLocationSessionKey, buildDriverLocationSourcePayload } from '../../utils/driverLocation.js';
import { latestTrackingSample, trackingFencePayload, validateTrackingIntent } from './trackingIntent.js';
import { withTrackingTimeout } from './withTrackingTimeout.js';

// Background tracking uses independent, acknowledged HTTP requests. A suspended
// RTDB socket must neither prevent publication nor delete an HTTP-owned source.
// Never expose URLs, tokens or coordinates in transport errors or logs.
export const createTrackingRestRepository = ({ auth, baseUrl, retireEndpoint,
  fetchFn = (...args) => fetch(...args), timeoutMs = 10_000, now = Date.now }) => {
  const request = async ({ path, payload, expectedUid, endpoint, method = 'PUT',
    isScopeCurrent = () => true, readBody = false }) => {
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error('TRACKING_NETWORK_ERROR');
      if (!isScopeCurrent()) throw new Error('START_INTERRUPTED');
    };
    const perform = async () => {
      assertCurrent();
      await auth.authStateReady?.();
      assertCurrent();
      const currentUser = auth.currentUser;
      if (!currentUser || currentUser.uid !== expectedUid) throw new Error('AUTH_UID_CHANGED');
      const token = await currentUser.getIdToken();
      assertCurrent();
      if (auth.currentUser?.uid !== expectedUid) throw new Error('AUTH_UID_CHANGED');
      let url = endpoint;
      if (!url) {
        const target = new URL(baseUrl);
        target.pathname = `/${path.split('/').map(encodeURIComponent).join('/')}.json`;
        target.searchParams.set('auth', token);
        url = target.toString();
      }
      // Auth restoration can take seconds. Recheck Stop, identity and sample
      // freshness immediately before dispatch, using a single request deadline.
      assertCurrent();
      const response = await fetchFn(url, {
        method, headers: { 'Content-Type': 'application/json',
          ...(endpoint ? { Authorization: `Bearer ${token}` } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }), signal: controller.signal,
      });
      assertCurrent();
      if (auth.currentUser?.uid !== expectedUid) throw new Error('AUTH_UID_CHANGED');
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'TRACKING_NETWORK_ERROR');
        error.code = error.message;
        throw error;
      }
      if (!readBody && !endpoint) return { acknowledged: true };
      const result = await response.json();
      assertCurrent();
      if (auth.currentUser?.uid !== expectedUid) throw new Error('AUTH_UID_CHANGED');
      if (endpoint && (result?.success !== true || result?.withdrawalAcknowledged !== true)) {
        throw new Error('TRACKING_NETWORK_ERROR');
      }
      return result;
    };
    try {
      return await withTrackingTimeout(perform, timeoutMs);
    } catch (error) {
      if (['PERMISSION_DENIED', 'AUTH_UID_CHANGED', 'START_INTERRUPTED'].includes(error?.message)) {
        const safe = new Error(error.message);
        safe.code = error.message;
        throw safe;
      }
      throw new Error('TRACKING_NETWORK_ERROR');
    } finally { controller.abort(); }
  };
  const sourcePath = intent => `driver_location_sessions/${buildDriverLocationSessionKey(intent.scope.sessionId, intent.liveSharingSessionId)}`;
  return {
    readCurrentSession: authUid => {
      if (typeof authUid !== 'string' || !authUid || authUid.length > 128 || /[.#$\/\[\]\u0000-\u001f\u007f]/.test(authUid)) {
        return Promise.reject(new Error('AUTH_UID_CHANGED'));
      }
      return request({ path: `app_sessions/${authUid}`, expectedUid: authUid, method: 'GET', readBody: true });
    },
    publish: async (intent, sample, isScopeCurrent = () => true) => {
      if (!validateTrackingIntent(intent)) throw new Error('INVALID_TRACKING_INTENT');
      const current = () => intent.status === 'active' && intent.scope.expiresAtMs > now()
        && isScopeCurrent() && Boolean(latestTrackingSample([sample], intent, now()));
      if (!current()) throw new Error('START_INTERRUPTED');
      const payload = buildDriverLocationSourcePayload({ ...sample.coords, source: 'auto',
        authUid: intent.scope.authUid, appSessionId: intent.scope.sessionId,
        driverId: intent.scope.cacheOwnerId, tourId: intent.scope.tourId,
        liveSharingSessionId: intent.liveSharingSessionId, nowMs: now() });
      await request({ path: sourcePath(intent), payload, expectedUid: intent.scope.authUid, isScopeCurrent: current });
      return { success: true, publicationAcknowledged: true, timestamp: now(), timestampSource: 'client_estimate' };
    },
    writeFence: (intent, status, isScopeCurrent) => request({
      path: `driver_tracking_sessions/${buildDriverLocationSessionKey(intent.scope.sessionId, intent.liveSharingSessionId)}`,
      payload: trackingFencePayload(intent, status), expectedUid: intent.scope.authUid, isScopeCurrent,
    }),
    retireSession: intent => {
      if (!retireEndpoint) return Promise.reject(new Error('TRACKING_SERVICE_NOT_CONFIGURED'));
      return request({ payload: trackingFencePayload(intent, 'stopped'), expectedUid: intent.scope.authUid,
        endpoint: retireEndpoint, method: 'POST' });
    },
  };
};
