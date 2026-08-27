import { limitToLast, onValue, orderByChild, push, query, ref, set } from 'firebase/database';
import { auth, db } from '../firebase';

const getNotificationAdminEndpoint = (functionName) => {
  const explicitUrl = import.meta.env[`VITE_${functionName.replace(/([A-Z])/g, '_$1').toUpperCase()}_URL`]?.trim();
  if (explicitUrl) return explicitUrl;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}` : null;
};

const callNotificationAdminEndpoint = async (functionName, body = {}) => {
  const endpoint = getNotificationAdminEndpoint(functionName);
  if (!endpoint) throw new Error('Notification administration is not configured for this deployment.');
  if (!auth.currentUser) throw new Error('Your admin session has expired. Sign in again and retry.');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await auth.currentUser.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const error = new Error(payload?.reason || 'The notification service could not complete that request.');
    error.code = payload?.reason || 'NOTIFICATION_SERVICE_ERROR';
    throw error;
  }
  return payload;
};

export const subscribeToBroadcastTours = ({ onData, onError }) => onValue(
  ref(db, 'tours'),
  (snapshot) => onData(snapshot.val() || {}),
  onError,
);

export const subscribeToBroadcastHistory = ({ rootPath, limit = 25, onData, onError }) => {
  const historyQuery = query(ref(db, rootPath), orderByChild('createdAtMs'), limitToLast(limit));
  return onValue(historyQuery, (snapshot) => onData(snapshot.val() || {}), onError);
};

export const queueBroadcast = async ({ rootPath, payload }) => {
  const authUid = auth.currentUser?.uid;
  if (!authUid) {
    const error = new Error('A current admin session is required.');
    error.code = 'auth/session-expired';
    throw error;
  }
  const newBroadcastRef = push(ref(db, rootPath));
  await set(newBroadcastRef, { ...payload, createdByUid: authUid });
  return newBroadcastRef.key;
};

export const previewNotificationAudience = (target) => callNotificationAdminEndpoint('previewNotificationAudience', target);

const waitForAdminPoll = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
const MAX_ADMIN_POLL_REQUESTS = 240;

export const previewNotificationAudienceFully = async (target, {
  onProgress = () => {},
  shouldContinue = () => true,
} = {}) => {
  let request = target;
  for (let requestCount = 0; requestCount < MAX_ADMIN_POLL_REQUESTS; requestCount += 1) {
    if (!shouldContinue()) return null;
    const result = await previewNotificationAudience(request);
    if (!shouldContinue()) return null;
    onProgress(result);
    if (result?.preview?.complete) return result;
    if (!result?.preview?.previewId) throw new Error('The audience check did not return a continuation identifier.');
    request = { previewId: result.preview.previewId };
    await waitForAdminPoll(150);
  }
  throw new Error('The audience check did not finish before its safety limit. Please retry.');
};

export const createServerTestNotification = (requestId) => callNotificationAdminEndpoint(
  'createServerTestNotification',
  { requestId },
);

export const requeueNotificationJob = (jobId) => callNotificationAdminEndpoint('requeueNotificationJob', { jobId });

export const requeueNotificationJobFully = async (jobId) => {
  let result = null;
  for (let requestCount = 0; requestCount < MAX_ADMIN_POLL_REQUESTS; requestCount += 1) {
    result = await requeueNotificationJob(jobId);
    if (result?.complete) return result;
    await waitForAdminPoll(150);
  }
  throw new Error('The bounded requeue did not finish before its safety limit. Please retry.');
};

export const subscribeToNotificationJob = ({ jobId, onData, onError }) => {
  if (!jobId) return () => {};
  return onValue(ref(db, `notification_jobs/${jobId}`), (snapshot) => onData(snapshot.val() || null), onError);
};
