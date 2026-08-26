import { onValue, ref } from 'firebase/database';
import { db } from '../firebase';
import { postAdminAction } from './adminActionService';
import { isValidRemoteAppSession } from '../shared/session/appSessionBoundary.js';

const SESSION_ID_PATTERN = /^sess_v1_[a-f0-9]{32}$/;
const REVOCATION_REASONS = new Set(['lost_device', 'security_review', 'staff_request', 'account_support']);

export const maskAppSessionId = (sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId || '')) return 'Unavailable';
  return `${sessionId.slice(0, 11)}…${sessionId.slice(-6)}`;
};

export const normalizeAdminAppSession = (value, nowMs = Date.now()) => {
  if (!isValidRemoteAppSession(value)) return null;
  if (!value || value.schemaVersion !== 1 || value.status !== 'active') return null;
  if (!SESSION_ID_PATTERN.test(value.sessionId || '') || !Number.isFinite(value.expiresAtMs)) return null;
  return {
    sessionId: value.sessionId,
    principalType: value.principalType === 'driver' ? 'driver' : 'passenger',
    tourId: typeof value.tourId === 'string' ? value.tourId : null,
    driverId: typeof value.driverId === 'string' ? value.driverId : null,
    issuedAtMs: Number(value.issuedAtMs) || null,
    expiresAtMs: Number(value.expiresAtMs),
    sessionRevision: Number(value.sessionRevision) || 1,
    isExpired: Number(value.expiresAtMs) <= nowMs,
  };
};

export const subscribeToAppSession = ({ authUid, onChange, onError, database = db }) => {
  if (!authUid || typeof onChange !== 'function') {
    onChange?.(null);
    return () => {};
  }
  return onValue(
    ref(database, `app_sessions/${authUid}`),
    (snapshot) => onChange(normalizeAdminAppSession(snapshot.val())),
    onError,
  );
};

export const revokeAppSession = async ({ authUid, sessionId, reason }) => {
  if (!authUid || !SESSION_ID_PATTERN.test(sessionId || '') || !REVOCATION_REASONS.has(reason)) {
    throw new Error('Select a valid reason before ending this app session.');
  }
  return postAdminAction('revokeAppSession', {
    authUid,
    expectedSessionId: sessionId,
    reason,
  }, {
    reasonMessages: {
      SESSION_CHANGED: 'This session changed before it could be ended. Refresh and review the current session.',
      SESSION_IN_PROGRESS: 'Another session action is still finishing. Wait a moment and retry.',
      NOT_AUTHORIZED: 'Your admin account is not authorised to end app sessions.',
      INVALID_INPUT: 'The session or reason is no longer valid. Refresh and retry.',
    },
    fallbackError: 'The app session could not be ended safely.',
  });
};

export const APP_SESSION_REVOCATION_REASONS = [
  { value: 'lost_device', label: 'Lost or replaced device' },
  { value: 'security_review', label: 'Security review' },
  { value: 'staff_request', label: 'Staff request' },
  { value: 'account_support', label: 'Account support' },
];
