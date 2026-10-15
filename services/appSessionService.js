const NativeAsyncStorage = require('@react-native-async-storage/async-storage').default;
const { projectValidatedAppSession } = require('../src/app/session/appSessionBoundary');
const { parseValidatedJson } = require('../src/shared/persistence/jsonBoundary');

const testStorageValues = new Map();
const testStorage = {
  getItem: async (key) => testStorageValues.get(key) ?? null,
  setItem: async (key, value) => { testStorageValues.set(key, value); },
  removeItem: async (key) => { testStorageValues.delete(key); },
  multiRemove: async (keys) => { keys.forEach((key) => testStorageValues.delete(key)); },
};
const AsyncStorage = process.env.NODE_ENV === 'test' ? testStorage : NativeAsyncStorage;

const APP_SESSION_KEY = '@LLT:appSession:v1';
const PENDING_SESSION_END_KEY = '@LLT:pendingSessionEnd:v1';
const SESSION_ID_PATTERN = /^sess_v1_[a-f0-9]{32}$/;
const PASSENGER_PRINCIPAL_PATTERN = /^pax_v2_[a-f0-9]{32}$/;
const DRIVER_PRINCIPAL_PATTERN = /^driver:[^.#$\/\[\]]{1,120}$/;
const SAFE_SESSION_KEYS = new Set([
  'schemaVersion',
  'sessionId',
  'tourId',
  'principalId',
  'principalType',
  'driverId',
  'issuedAtMs',
  'expiresAtMs',
  'sessionRevision',
]);

const isSafeKey = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 160
  && !/[.#$\/\[\]]/.test(value);

const validateAppSession = (input, { nowMs = Date.now(), allowExpired = false } = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = projectValidatedAppSession(input);
  if (!candidate) return null;
  if (candidate.schemaVersion !== 1 || !SESSION_ID_PATTERN.test(candidate.sessionId || '')) return null;
  if (!Number.isSafeInteger(candidate.issuedAtMs) || !Number.isSafeInteger(candidate.expiresAtMs)
    || candidate.expiresAtMs <= candidate.issuedAtMs || (!allowExpired && candidate.expiresAtMs <= nowMs)) return null;
  if (!Number.isSafeInteger(candidate.sessionRevision) || candidate.sessionRevision < 1) return null;
  if (candidate.principalType === 'passenger') {
    if (!PASSENGER_PRINCIPAL_PATTERN.test(candidate.principalId || '') || !isSafeKey(candidate.tourId)
      || candidate.driverId !== null) return null;
  } else if (candidate.principalType === 'driver') {
    if (!DRIVER_PRINCIPAL_PATTERN.test(candidate.principalId || '') || !isSafeKey(candidate.driverId)
      || candidate.principalId !== `driver:${candidate.driverId}`
      || (candidate.tourId !== null && !isSafeKey(candidate.tourId))) return null;
  } else {
    return null;
  }
  return Object.fromEntries([...SAFE_SESSION_KEYS].map((key) => [key, candidate[key]]));
};

const validatePendingSessionEnd = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!isSafeKey(input.authUid) || !SESSION_ID_PATTERN.test(input.sessionId || '')) return null;
  if (input.tourId !== null && !isSafeKey(input.tourId)) return null;
  if (input.principalType !== 'passenger' && input.principalType !== 'driver') return null;
  if (!Number.isSafeInteger(input.requestedAtMs) || input.requestedAtMs <= 0) return null;
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) return null;
  return {
    authUid: input.authUid,
    sessionId: input.sessionId,
    tourId: input.tourId,
    principalType: input.principalType,
    requestedAtMs: input.requestedAtMs,
    attemptCount: input.attemptCount,
  };
};

const buildEndpoint = (functionName) => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  return projectId
    ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}`
    : null;
};

// This transport owns no durable state. A late token, fetch or body response
// after its deadline cannot write a marker or complete a different logout.
const requestSessionEndWithDeadline = async ({
  firebase, currentUser, endpoint, pending, fetchFn, scheduleTimer, cancelTimer, timeoutMs,
}) => {
  const controller = new AbortController();
  let timer;
  const assertActive = () => {
    if (controller.signal.aborted) throw new Error('Logout request timed out');
  };
  const deadline = new Promise((_resolve, reject) => {
    timer = scheduleTimer(() => {
      controller.abort();
      reject(new Error('Logout request timed out'));
    }, timeoutMs);
  });
  const transport = async () => {
    const token = await currentUser.getIdToken();
    assertActive();
    const appCheckToken = await firebase.getCurrentAppCheckToken?.();
    assertActive();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (appCheckToken) headers['x-firebase-appcheck'] = appCheckToken;
    const response = await fetchFn(endpoint, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ expectedSessionId: pending.sessionId, reason: 'user_logout' }),
    });
    assertActive();
    const payload = await response.json().catch(() => null);
    assertActive();
    return { response, payload };
  };
  try {
    return await Promise.race([transport(), deadline]);
  } finally {
    cancelTimer(timer);
  }
};

const createAppSessionService = ({
  storage = AsyncStorage,
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
  scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  cancelTimer = (timer) => clearTimeout(timer),
  requestTimeoutMs = 15_000,
  getFirebase = () => require('../firebase'),
} = {}) => {
  let endInFlight = null;
  const endRequestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? Math.min(requestTimeoutMs, 60_000) : 15_000;

  const persistSession = async (session) => {
    const valid = validateAppSession(session, { nowMs: now() });
    if (!valid) throw new Error('The server returned an invalid or expired app session.');
    await storage.setItem(APP_SESSION_KEY, JSON.stringify(valid));
    return valid;
  };

  const readSession = async ({ allowExpired = false } = {}) => {
    const raw = await storage.getItem(APP_SESSION_KEY);
    const parsed = parseValidatedJson(raw, validateAppSession, { nowMs: now(), allowExpired });
    if (!parsed && raw) await storage.removeItem(APP_SESSION_KEY);
    return parsed;
  };

  const clearSession = () => storage.removeItem(APP_SESSION_KEY);

  const persistPendingEnd = async ({ authUid, session }) => {
    const validSession = validateAppSession(session, { nowMs: now(), allowExpired: true });
    if (!validSession || !isSafeKey(authUid)) throw new Error('A valid session is required to request logout.');
    const pending = {
      authUid,
      sessionId: validSession.sessionId,
      tourId: validSession.tourId,
      principalType: validSession.principalType,
      requestedAtMs: now(),
      attemptCount: 0,
    };
    await storage.setItem(PENDING_SESSION_END_KEY, JSON.stringify(pending));
    return pending;
  };

  const readPendingEnd = async () => {
    const raw = await storage.getItem(PENDING_SESSION_END_KEY);
    const parsed = parseValidatedJson(raw, validatePendingSessionEnd);
    if (!parsed && raw) await storage.removeItem(PENDING_SESSION_END_KEY);
    return parsed;
  };
  const clearPendingEnd = () => storage.removeItem(PENDING_SESSION_END_KEY);

  const requestEnd = async (pending) => {
    const validPending = validatePendingSessionEnd(pending);
    if (!validPending) return { success: false, reason: 'INVALID_PENDING_SESSION' };
    const firebase = getFirebase();
    const currentUser = firebase.auth?.currentUser;
    if (!currentUser || currentUser.uid !== validPending.authUid) {
      return { success: false, reason: 'AUTH_UID_CHANGED' };
    }
    const endpoint = process.env.EXPO_PUBLIC_END_APP_SESSION_URL?.trim() || buildEndpoint('endAppSession');
    if (!endpoint) return { success: false, reason: 'ENDPOINT_UNAVAILABLE' };
    const nextPending = { ...validPending, attemptCount: validPending.attemptCount + 1 };
    await storage.setItem(PENDING_SESSION_END_KEY, JSON.stringify(nextPending));
    let response; let payload;
    try {
      ({ response, payload } = await requestSessionEndWithDeadline({
        firebase, currentUser, endpoint, pending: validPending, fetchFn,
        scheduleTimer, cancelTimer, timeoutMs: endRequestTimeoutMs,
      }));
    } catch (error) {
      return { success: false, reason: 'NETWORK_ERROR', error: error?.message || String(error), pending: nextPending };
    }
    if (response.status === 409 && payload?.reason === 'SESSION_CHANGED') {
      return { success: false, reason: 'SESSION_CHANGED', pending: nextPending };
    }
    if (!response.ok || payload?.success !== true) {
      return { success: false, reason: payload?.reason || 'SERVER_ERROR', pending: nextPending };
    }
    return { success: true, data: payload, pending: nextPending };
  };

  const endSession = async ({ authUid, session } = {}) => {
    if (endInFlight) return endInFlight;
    endInFlight = (async () => {
      const pending = await persistPendingEnd({ authUid, session });
      return requestEnd(pending);
    })();
    try { return await endInFlight; } finally { endInFlight = null; }
  };

  const retryPendingEnd = async () => {
    if (endInFlight) return endInFlight;
    const pending = await readPendingEnd();
    if (!pending) return { success: true, alreadyEnded: true };
    endInFlight = requestEnd(pending);
    try { return await endInFlight; } finally { endInFlight = null; }
  };

  const completeEnd = async () => {
    await storage.multiRemove([APP_SESSION_KEY, PENDING_SESSION_END_KEY]);
  };

  const verifyCurrent = async ({ authUid, expectedSession } = {}) => {
    if (!isSafeKey(authUid) || !expectedSession) return { valid: false, reason: 'INVALID_INPUT' };
    const firebase = getFirebase();
    const snapshot = await firebase.realtimeDb.ref(`app_sessions/${authUid}`).once('value');
    const remote = validateAppSession(snapshot.val(), { nowMs: now() });
    if (!remote) return { valid: false, reason: 'SESSION_INACTIVE' };
    if (remote.sessionId !== expectedSession.sessionId
      || remote.principalId !== expectedSession.principalId
      || remote.principalType !== expectedSession.principalType
      || remote.tourId !== expectedSession.tourId) {
      return { valid: false, reason: 'SESSION_CHANGED', session: remote };
    }
    return { valid: true, session: remote };
  };

  const subscribe = ({ authUid, expectedSession, onRevoked, onError, subscribeToForeground }) => {
    if (!isSafeKey(authUid) || !expectedSession) return () => {};
    const firebase = getFirebase();
    const ref = firebase.realtimeDb.ref(`app_sessions/${authUid}`);
    let active = true;
    let notified = false;
    let expiryTimer = null;
    const clearExpiryTimer = () => {
      if (expiryTimer !== null) cancelTimer(expiryTimer);
      expiryTimer = null;
    };
    const revoke = (reason) => {
      if (!active || notified) return;
      notified = true;
      clearExpiryTimer();
      onRevoked?.({ reason });
    };
    const checkExpiry = () => {
      clearExpiryTimer();
      if (!active || notified) return;
      const remaining = expectedSession.expiresAtMs - now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        revoke('SESSION_EXPIRED');
        return;
      }
      expiryTimer = scheduleTimer(checkExpiry, Math.min(remaining, 2_147_483_647));
    };
    const onValue = (snapshot) => {
      if (!active || notified) return;
      const remote = validateAppSession(snapshot.val(), { nowMs: now() });
      if (!remote
        || remote.sessionId !== expectedSession.sessionId
        || remote.principalId !== expectedSession.principalId
        || remote.principalType !== expectedSession.principalType
        || remote.tourId !== expectedSession.tourId) {
        revoke(remote ? 'SESSION_CHANGED' : 'SESSION_ENDED');
      }
    };
    const cancelled = (error) => { if (active) onError?.(error); };
    const stopForeground = subscribeToForeground?.(checkExpiry);
    checkExpiry();
    ref.on('value', onValue, cancelled);
    return () => {
      active = false;
      clearExpiryTimer();
      stopForeground?.();
      ref.off('value', onValue);
    };
  };

  return {
    persistSession,
    readSession,
    clearSession,
    persistPendingEnd,
    readPendingEnd,
    clearPendingEnd,
    retryPendingEnd,
    endSession,
    completeEnd,
    verifyCurrent,
    subscribe,
  };
};

const appSessionService = createAppSessionService();

module.exports = {
  APP_SESSION_KEY,
  PENDING_SESSION_END_KEY,
  SESSION_ID_PATTERN,
  validateAppSession,
  validatePendingSessionEnd,
  createAppSessionService,
  ...appSessionService,
};
