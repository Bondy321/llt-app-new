const NativeAsyncStorage = require('@react-native-async-storage/async-storage').default;
const { projectValidatedAppSession } = require('../src/app/session/appSessionBoundary');
const { parseValidatedJson } = require('../src/shared/persistence/jsonBoundary');
const { classifySessionTransition } = require('./appSessionTransition');

const testStorageValues = new Map();
const testStorage = {
  getItem: async (key) => testStorageValues.get(key) ?? null,
  setItem: async (key, value) => { testStorageValues.set(key, value); },
  removeItem: async (key) => { testStorageValues.delete(key); },
  multiSet: async (entries) => { entries.forEach(([key, value]) => testStorageValues.set(key, value)); },
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
  let storageMutation = Promise.resolve();
  const mutateStorage = (operation) => {
    const result = storageMutation.catch(() => {}).then(operation);
    storageMutation = result;
    return result;
  };
  const endRequestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? Math.min(requestTimeoutMs, 60_000) : 15_000;

  const persistSession = async (session, { isCurrent = () => true } = {}) => {
    const valid = validateAppSession(session, { nowMs: now() });
    if (!valid) throw new Error('The server returned an invalid or expired app session.');
    const committed = await mutateStorage(async () => {
      if (!isCurrent()) return false;
      await storage.setItem(APP_SESSION_KEY, JSON.stringify(valid));
      return true;
    });
    if (!committed) return false;
    return valid;
  };

  const readSession = ({ allowExpired = false } = {}) => mutateStorage(async () => {
    const raw = await storage.getItem(APP_SESSION_KEY);
    const parsed = parseValidatedJson(raw, validateAppSession, { nowMs: now(), allowExpired });
    if (!parsed && raw) await storage.removeItem(APP_SESSION_KEY);
    return parsed;
  });

  const clearSession = () => mutateStorage(() => storage.removeItem(APP_SESSION_KEY));

  // Commit the validated session and its display seed together, in the same
  // serialized adapter used by login/logout. A delayed assignment may neither
  // replace a newer revision nor recreate a session removed by logout.
  const persistSessionTransition = ({ expectedSession, session, projectionEntries, isCurrent }) => mutateStorage(async () => {
    const next = validateAppSession(session, { nowMs: now() });
    const stored = parseValidatedJson(await storage.getItem(APP_SESSION_KEY), validateAppSession,
      { nowMs: now(), allowExpired: true });
    if (!next || !stored || !isCurrent()
      || !['advance', 'duplicate'].includes(classifySessionTransition(expectedSession, next, { allowDriverAssignment: true }))
      || !['advance', 'duplicate'].includes(classifySessionTransition(stored, next, { allowDriverAssignment: true }))) return false;
    await storage.multiSet([...projectionEntries, [APP_SESSION_KEY, JSON.stringify(next)]]);
    return true;
  });

  const persistProjection = ({ expectedSession, entries, isCurrent }) => mutateStorage(async () => {
    const stored = parseValidatedJson(await storage.getItem(APP_SESSION_KEY), validateAppSession, { nowMs: now() });
    if (!stored || !isCurrent() || classifySessionTransition(expectedSession, stored) !== 'duplicate') return false;
    await storage.multiSet(entries);
    return true;
  });

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
    await mutateStorage(() => storage.setItem(PENDING_SESSION_END_KEY, JSON.stringify(pending)));
    return pending;
  };

  const readPendingEnd = () => mutateStorage(async () => {
    const raw = await storage.getItem(PENDING_SESSION_END_KEY);
    const parsed = parseValidatedJson(raw, validatePendingSessionEnd);
    if (!parsed && raw) await storage.removeItem(PENDING_SESSION_END_KEY);
    return parsed;
  });
  const clearPendingEnd = ({ isCurrent = () => true } = {}) => mutateStorage(() => (
    isCurrent() ? storage.removeItem(PENDING_SESSION_END_KEY) : false
  ));

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
    const updated = await mutateStorage(async () => {
      const current = parseValidatedJson(await storage.getItem(PENDING_SESSION_END_KEY), validatePendingSessionEnd);
      if (!current || current.authUid !== validPending.authUid || current.sessionId !== validPending.sessionId
        || current.requestedAtMs !== validPending.requestedAtMs) return false;
      await storage.setItem(PENDING_SESSION_END_KEY, JSON.stringify(nextPending));
      return true;
    });
    if (!updated) return { success: false, reason: 'PENDING_SESSION_CHANGED' };
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

  const completeEnd = ({ expectedSessionId } = {}) => mutateStorage(async () => {
    const [sessionRaw, pendingRaw] = await Promise.all([
      storage.getItem(APP_SESSION_KEY), storage.getItem(PENDING_SESSION_END_KEY),
    ]);
    if (!sessionRaw && !pendingRaw) return true;
    if (!SESSION_ID_PATTERN.test(expectedSessionId || '')) return false;
    const session = parseValidatedJson(sessionRaw, validateAppSession, { nowMs: now(), allowExpired: true });
    const pending = parseValidatedJson(pendingRaw, validatePendingSessionEnd);
    if ((sessionRaw && session?.sessionId !== expectedSessionId)
      || (pendingRaw && pending?.sessionId !== expectedSessionId)) return false;
    await storage.multiRemove([APP_SESSION_KEY, PENDING_SESSION_END_KEY]);
    return true;
  });

  const verifyCurrent = async ({ authUid, expectedSession, readRemoteSession, allowDriverAssignment = false } = {}) => {
    if (!isSafeKey(authUid) || !expectedSession) return { valid: false, reason: 'INVALID_INPUT' };
    const raw = readRemoteSession
      ? await readRemoteSession(authUid)
      : (await getFirebase().realtimeDb.ref(`app_sessions/${authUid}`).once('value')).val();
    const remote = validateAppSession(raw, { nowMs: now() });
    if (!remote || (raw.authUid && raw.authUid !== authUid)) return { valid: false, reason: 'SESSION_INACTIVE' };
    if (allowDriverAssignment) {
      const transition = classifySessionTransition(expectedSession, remote, { allowDriverAssignment: true });
      return transition === 'invalid' || transition === 'stale'
        ? { valid: false, reason: 'SESSION_CHANGED', session: remote }
        : { valid: true, session: remote };
    }
    if (remote.sessionId !== expectedSession.sessionId
      || remote.principalId !== expectedSession.principalId
      || remote.principalType !== expectedSession.principalType
      || remote.tourId !== expectedSession.tourId) {
      return { valid: false, reason: 'SESSION_CHANGED', session: remote };
    }
    return { valid: true, session: remote };
  };

  const subscribe = ({ authUid, expectedSession, onSession, onRevoked, onError, subscribeToForeground }) => {
    if (!isSafeKey(authUid) || !expectedSession) return () => {};
    const firebase = getFirebase();
    const ref = firebase.realtimeDb.ref(`app_sessions/${authUid}`);
    let active = true;
    let notified = false;
    let expiryTimer = null;
    let acceptedSession = expectedSession;
    const clearExpiryTimer = () => {
      if (expiryTimer !== null) cancelTimer(expiryTimer);
      expiryTimer = null;
    };
    const revoke = (reason, session = acceptedSession) => {
      if (!active || notified) return;
      notified = true;
      clearExpiryTimer();
      onRevoked?.({ reason, session });
    };
    const checkExpiry = () => {
      clearExpiryTimer();
      if (!active || notified) return;
      const remaining = acceptedSession.expiresAtMs - now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        revoke('SESSION_EXPIRED');
        return;
      }
      expiryTimer = scheduleTimer(checkExpiry, Math.min(remaining, 2_147_483_647));
    };
    const onValue = (snapshot) => {
      if (!active || notified) return;
      const raw = snapshot.val();
      const remote = validateAppSession(raw, { nowMs: now(), allowExpired: true });
      if (!remote || (raw.authUid && raw.authUid !== authUid)) { revoke('SESSION_ENDED'); return; }
      const transition = classifySessionTransition(acceptedSession, remote, { allowDriverAssignment: Boolean(onSession) });
      if (transition === 'invalid') { revoke('SESSION_CHANGED'); return; }
      if (transition === 'stale') return;
      if (remote.expiresAtMs <= now()) { revoke('SESSION_EXPIRED', remote); return; }
      if (transition === 'duplicate') {
        // A previous projection load may have failed while offline. Replaying
        // this same authority can repair its seed, without lowering revision.
        Promise.resolve(onSession?.({ authUid, session: acceptedSession }))
          .catch(error => { if (active && !notified) onError?.(error); });
        return;
      }
      const previousSession = acceptedSession;
      acceptedSession = remote;
      checkExpiry();
      // The accepted expiry is effective immediately, even if tour loading or
      // storage reconciliation is still awaiting I/O.
      Promise.resolve(onSession?.({ authUid, session: remote, previousSession })).catch(error => {
        if (active && !notified) onError?.(error);
      });
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
    persistSessionTransition,
    persistProjection,
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
