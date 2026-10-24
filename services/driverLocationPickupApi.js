import Constants from 'expo-constants';

import { auth, getCurrentAppCheckToken } from '../firebase';
import { withTrackingTimeout } from './driver-tracking/withTrackingTimeout';

const buildEndpoint = () => {
  const explicit = process.env.EXPO_PUBLIC_DRIVER_LOCATION_PICKUP_URL?.trim();
  if (explicit) return explicit;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/updateDriverLocationPickup` : null;
};

const reasonMessage = (reason) => ({
  UPDATE_REQUIRED: 'Update the app to continue sharing driver locations.',
  ASSIGNMENT_CHANGED: 'Your tour assignment changed. Refresh before sharing this pickup point.',
  ASSIGNMENT_IN_PROGRESS: 'Your tour assignment is changing. Wait a moment and retry.',
  SESSION_CHANGED: 'Your secure driver session changed. Sign in again before sharing.',
  SESSION_IN_PROGRESS: 'Your secure session is updating. Wait a moment and retry.',
  POLICY_CONFIGURATION_INVALID: 'Driver access is temporarily unavailable. Contact dispatch.',
}[reason] || 'The pickup location could not be updated. Check your connection and retry.');

export const mutateDriverLocationPickup = async ({
  operation,
  tourId,
  location,
  address,
  sessionScope,
  fetchFn = (...args) => fetch(...args),
  authInstance = auth,
  endpoint = buildEndpoint(),
  clientVersion = Constants?.expoConfig?.version || '',
  getAppCheckToken = getCurrentAppCheckToken,
  timeoutMs = 15000,
} = {}) => {
  const currentUser = authInstance?.currentUser;
  if (!endpoint) throw new Error('The pickup location service is not configured. Update the app or contact dispatch.');
  if (!currentUser?.getIdToken || !sessionScope?.sessionId) throw new Error('An active driver session is required. Sign in again.');
  const controller = new AbortController();
  const perform = async () => {
  const token = await currentUser.getIdToken();
  const appCheck = await getAppCheckToken();
  if (controller.signal.aborted) throw new Error('Pickup request timed out. Retry to confirm the current location.');
  if (authInstance.currentUser !== currentUser) throw new Error('Your driver account changed. Retry from the current session.');
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      ...(appCheck ? { 'X-Firebase-AppCheck': appCheck } : {}) },
    signal: controller.signal,
    body: JSON.stringify({
      operation,
      tourId,
      expectedSessionId: sessionScope.sessionId,
      clientVersion,
      ...(operation === 'publish' ? { location, address } : {}),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const error = new Error(reasonMessage(payload?.reason));
    error.code = payload?.reason || 'DRIVER_LOCATION_PICKUP_FAILED';
    throw error;
  }
  return payload;
  };
  try { return await withTrackingTimeout(perform, timeoutMs); }
  finally { controller.abort(); }
};

export default mutateDriverLocationPickup;
