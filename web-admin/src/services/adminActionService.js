import { auth } from '../firebase';
import { isAdminActionSuccessResponse } from '../shared/api/adminResponseBoundary.js';

const buildFunctionUrl = (functionName) => {
  const environmentKey = `VITE_${functionName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_URL`;
  const explicitUrl = import.meta.env[environmentKey]?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;
  return `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}`;
};

export async function postAdminAction(functionName, body, options = {}) {
  const endpoint = buildFunctionUrl(functionName);
  if (!endpoint) {
    throw new Error(options.configurationError || 'This admin operation is not configured for this deployment.');
  }
  if (!auth.currentUser) {
    throw new Error('Your admin session has expired. Sign in again and retry.');
  }

  const token = await auth.currentUser.getIdToken();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !isAdminActionSuccessResponse(payload)) {
    const reason = payload?.reason || 'INTERNAL_ERROR';
    const error = new Error(options.reasonMessages?.[reason] || options.fallbackError || 'The operation could not be completed safely.');
    error.code = reason;
    throw error;
  }

  return payload;
}
