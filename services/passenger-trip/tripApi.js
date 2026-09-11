const INVALID_SESSION_REASONS = new Set(['SESSION_CHANGED', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND',
  'SESSION_REVOKED', 'SESSION_SCOPE_MISMATCH', 'ACCOUNT_DELETION_IN_PROGRESS', 'SESSION_INACTIVE',
  'SESSION_UID_MISMATCH', 'SESSION_ROLE_MISMATCH', 'SESSION_TOUR_MISMATCH', 'PARTICIPANT_MISSING',
  'PARTICIPANT_SESSION_MISMATCH', 'PASSENGER_PROFILE_MISMATCH', 'BOOKING_SCOPE_MISMATCH',
  'PASSENGER_IDENTITY_MISMATCH', 'REAUTHORIZE_REQUIRED']);
const createTripApi = ({ getFirebase = () => require('../../firebase'), fetchFn = (...args) => fetch(...args),
  endpoint = () => {
    const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
    return project ? `https://europe-west1-${project}.cloudfunctions.net/getPassengerTripSnapshot` : null;
  }, timeoutMs = 15000 } = {}) => ({
  async request({ scope, parts, versions, signal }) {
    const firebase = getFirebase();
    const user = firebase.auth?.currentUser;
    if (!user || user.uid !== scope.authUid) throw Object.assign(new Error('AUTH_UID_CHANGED'), { invalidSession: true });
    const url = endpoint();
    if (!url) throw new Error('ENDPOINT_UNAVAILABLE');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel);
    const timer = setTimeout(cancel, timeoutMs);
    try {
      const [token, appCheck] = await Promise.all([user.getIdToken(), firebase.getCurrentAppCheckToken?.()]);
      if (signal?.aborted || abort.signal.aborted) throw new Error('REQUEST_CANCELLED');
      const response = await fetchFn(url, { method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          ...(appCheck ? { 'x-firebase-appcheck': appCheck } : {}) },
        body: JSON.stringify({ expectedSessionId: scope.sessionId, parts, versions }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const reason = payload?.reason || 'SERVICE_UNAVAILABLE';
        throw Object.assign(new Error(reason), { reason, invalidSession: INVALID_SESSION_REASONS.has(reason) });
      }
      return payload;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  },
  subscribeSignals(scope, onSignal, onError) {
    const db = getFirebase().realtimeDb;
    if (!db) { onError(); return () => {}; }
    const booking = db.ref(`passenger_trip_signals/v1/bookings/${scope.bookingRef}`);
    const tour = db.ref(`passenger_trip_signals/v1/tours/${scope.tourId}`);
    const bookingValue = (snapshot) => onSignal('booking', snapshot.val()?.booking ?? null);
    const tourValue = (snapshot) => {
      const value = snapshot.val();
      onSignal('tour', value?.tour ?? null);
      onSignal('itinerary', value?.itinerary ?? null);
    };
    booking.on('value', bookingValue, onError);
    tour.on('value', tourValue, onError);
    return () => { booking.off('value', bookingValue); tour.off('value', tourValue); };
  },
});
module.exports = { createTripApi, INVALID_SESSION_REASONS };
