import { auth, getCurrentAppCheckToken } from '../../firebase';
import { allocateNotificationRegistrationRevision } from './notificationRegistrationRevision';

const endpoint = (name) => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${name}` : null;
};

const post = async (name, input, { fetchFn = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 15000 } = {}) => {
  const currentUser = auth?.currentUser;
  const capturedUid = currentUser?.uid;
  if (!capturedUid) throw Object.assign(new Error('Sign in before registering notifications.'), { code: 'AUTH_REQUIRED' });
  const controller = new AbortController();
  let timer;
  const timeoutError = () => Object.assign(new Error('Notification device request timed out.'), { code: 'NOTIFICATION_REQUEST_TIMEOUT' });
  const assertActive = () => {
    if (controller.signal.aborted) throw timeoutError();
    if (auth?.currentUser?.uid !== capturedUid) throw Object.assign(new Error('Notification identity changed.'), { code: 'IDENTITY_CHANGED' });
  };
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timeoutError()); },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 15000);
  });
  const request = async () => {
    // Revision allocation and authentication belong to the same total deadline
    // as every retry, response body and backoff. Late work cannot send a request.
    const body = typeof input === 'function' ? await input() : input;
    assertActive();
    const url = endpoint(name);
    const token = await currentUser.getIdToken();
    assertActive();
    if (!url || !token) throw new Error('Notification device service is unavailable.');
    const appCheckToken = await getCurrentAppCheckToken();
    assertActive();
    if (!appCheckToken) throw Object.assign(new Error('App verification is unavailable.'), { code: 'APP_CHECK_REQUIRED' });
    for (let attempt = 0; ; attempt += 1) {
      assertActive();
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Firebase-AppCheck': appCheckToken },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      assertActive();
      const payload = await response.json().catch(() => ({}));
      assertActive();
      if (response.status === 409 && ['SESSION_IN_PROGRESS', 'DEVICE_UPDATE_IN_PROGRESS'].includes(payload?.reason) && attempt < 4) {
        await wait(Math.min(1000, 200 * (2 ** attempt)));
        assertActive();
        continue;
      }
      if (!response.ok || payload?.success === false) {
        const error = new Error(payload?.reason || 'Notification device request failed.');
        error.code = payload?.reason || `HTTP_${response.status}`;
        throw error;
      }
      return payload;
    }
  };
  try { return await Promise.race([request(), deadline]); }
  finally { clearTimeout(timer); }
};

const withRegistrationRevision = async (input = {}) => {
  if (Number.isSafeInteger(input.registrationRevision) && input.registrationRevision > 0) return input;
  const authUid = auth?.currentUser?.uid;
  if (!authUid) throw Object.assign(new Error('Notification identity unavailable.'), { code: 'AUTH_REQUIRED' });
  const registrationRevision = await allocateNotificationRegistrationRevision({ authUid });
  return { ...input, registrationRevision };
};

export const reconcileNotificationDevice = async (input, options) => post('updateNotificationDeviceRegistration', async () => ({
  action: 'reconcile', ...await withRegistrationRevision(input),
}), options);
export const updateNotificationPreferences = async (input, options) => post('updateNotificationDeviceRegistration', async () => ({
  action: 'preferences', ...await withRegistrationRevision(input),
}), options);
export const endNotificationDeviceSession = async (input = {}, options) => post('updateNotificationDeviceRegistration', async () => ({
  action: 'logout', ...await withRegistrationRevision(input),
}), options);
export const revokeNotificationDevice = async (options) => post('updateNotificationDeviceRegistration', async () => ({
  action: 'security_revoke', ...await withRegistrationRevision(),
}), options);
export const getMarketingNotificationDetail = (input, options) => post('getMarketingNotificationDetail', input, options);
export const getSafetyAlertDetail = (input, options) => post('getSafetyAlertDetail', input, options);
