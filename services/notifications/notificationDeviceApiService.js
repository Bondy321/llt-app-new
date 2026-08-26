import { auth } from '../../firebase';
import { allocateNotificationRegistrationRevision } from './notificationRegistrationRevision';

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

const withRegistrationRevision = async (input = {}) => {
  if (Number.isSafeInteger(input.registrationRevision) && input.registrationRevision > 0) return input;
  // A Firebase ID token remains mandatory in post(); the fallback exists only
  // for the brief auth-restoration instant before the SDK exposes its UID.
  const authUid = auth?.currentUser?.uid || 'authenticated-device';
  const registrationRevision = await allocateNotificationRegistrationRevision({ authUid });
  return { ...input, registrationRevision };
};

export const reconcileNotificationDevice = async (input, options) => post('updateNotificationDeviceRegistration', {
  action: 'reconcile', ...await withRegistrationRevision(input),
}, options);
export const updateNotificationPreferences = async (input, options) => post('updateNotificationDeviceRegistration', {
  action: 'preferences', ...await withRegistrationRevision(input),
}, options);
export const endNotificationDeviceSession = async (input = {}, options) => post('updateNotificationDeviceRegistration', {
  action: 'logout', ...await withRegistrationRevision(input),
}, options);
export const revokeNotificationDevice = async (options) => post('updateNotificationDeviceRegistration', {
  action: 'security_revoke', ...await withRegistrationRevision(),
}, options);
export const deleteNotificationDevice = async (options) => post('updateNotificationDeviceRegistration', {
  action: 'delete', ...await withRegistrationRevision(),
}, options);
export const getMarketingNotificationDetail = (input, options) => post('getMarketingNotificationDetail', input, options);
export const getSafetyAlertDetail = (input, options) => post('getSafetyAlertDetail', input, options);
