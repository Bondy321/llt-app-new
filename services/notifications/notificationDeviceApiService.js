import { auth } from '../../firebase';

const endpoint = (name) => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${name}` : null;
};

const post = async (name, body, { fetchFn = fetch } = {}) => {
  const url = endpoint(name);
  const token = await auth?.currentUser?.getIdToken?.();
  if (!url || !token) throw new Error('Notification device service is unavailable.');
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const error = new Error(payload?.reason || 'Notification device request failed.');
    error.code = payload?.reason || `HTTP_${response.status}`;
    throw error;
  }
  return payload;
};

export const reconcileNotificationDevice = (input, options) => post('updateNotificationDeviceRegistration', {
  action: 'reconcile', ...input,
}, options);
export const updateNotificationPreferences = (input, options) => post('updateNotificationDeviceRegistration', {
  action: 'preferences', ...input,
}, options);
export const endNotificationDeviceSession = (input = {}, options) => post('updateNotificationDeviceRegistration', {
  action: 'logout', ...input,
}, options);
export const revokeNotificationDevice = (options) => post('updateNotificationDeviceRegistration', { action: 'security_revoke' }, options);
export const deleteNotificationDevice = (options) => post('updateNotificationDeviceRegistration', { action: 'delete' }, options);
export const getMarketingNotificationDetail = (input, options) => post('getMarketingNotificationDetail', input, options);
export const getSafetyAlertDetail = (input, options) => post('getSafetyAlertDetail', input, options);
