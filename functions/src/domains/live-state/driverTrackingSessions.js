'use strict';

// @ts-check

const { validateContract } = require('../../contracts/generated/contracts');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');

const DRIVER_TRACKING_SESSIONS_ROOT = 'driver_tracking_sessions';
const IMMUTABLE_TRACKING_FIELDS = Object.freeze([
  'schemaVersion', 'authUid', 'appSessionId', 'driverId', 'tourId',
  'liveSharingSessionId', 'startedAtMs', 'expiresAtMs',
]);

/** @param {any} record */
const trackingSourceKey = (record) => `${record.appSessionId}|${record.liveSharingSessionId}`;
/** @param {any} value */
const isTrackedLiveSharingSession = (value) => typeof value === 'string' && value.startsWith('track_');
/** @param {any} record @param {string} sourceKey */
const isValidTrackingIntent = (record, sourceKey) => Boolean(
  validateContract('DriverTrackingSessionRecord', record).valid
  && [record.authUid, record.driverId, record.tourId].every(isValidFirebaseKey)
  && Number.isSafeInteger(record.startedAtMs)
  && Number.isSafeInteger(record.expiresAtMs)
  && sourceKey === trackingSourceKey(record),
);
/** @param {any} left @param {any} right */
const sameTrackingIdentity = (left, right) => Boolean(left && right
  && IMMUTABLE_TRACKING_FIELDS.every((field) => left[field] === right[field]));
/** @param {any} source @param {any} intent */
const sourceMatchesIntent = (source, intent) => Boolean(source && intent
  && source.schemaVersion === 2 && source.source === 'auto' && source.mode === 'live'
  && ['authUid', 'appSessionId', 'driverId', 'tourId', 'liveSharingSessionId']
    .every((field) => source[field] === intent[field]));
/** @param {any} ref */
const readValue = async (ref) => (await (typeof ref.get === 'function' ? ref.get() : ref.once('value'))).val();

/** @param {any} database @param {any} record @param {number} nowMs */
async function hasActiveTrackingIntent(database, record, nowMs) {
  if (!isTrackedLiveSharingSession(record?.liveSharingSessionId)) return true;
  const sourceKey = trackingSourceKey(record);
  const intent = await readValue(database.ref(`${DRIVER_TRACKING_SESSIONS_ROOT}/${sourceKey}`));
  return Boolean(isValidTrackingIntent(intent, sourceKey)
    && intent.status === 'active' && intent.expiresAtMs > nowMs
    && sourceMatchesIntent(record, intent));
}

/**
 * Event payloads identify the publication, never its current permission state.
 * Re-read the intent first: delayed stop/delete events cannot retire a newer
 * active intent. The source transaction removes only the exact owned leaf.
 * Tombstones remain until their immutable app-session expiry.
 * @param {any} options
 */
async function reconcileDriverTrackingIntentChange({
  database, sourceKey, before, after, nowMs = Date.now(), reconcileProjection,
}) {
  if (!database?.ref || typeof reconcileProjection !== 'function') throw new TypeError('Tracking reconciliation dependencies are required');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be a non-negative safe integer');
  const candidate = isValidTrackingIntent(after, sourceKey) ? after : before;
  if (!isValidTrackingIntent(candidate, sourceKey)) return { ok: true, removed: false, reason: 'INVALID_INTENT' };
  const current = await readValue(database.ref(`${DRIVER_TRACKING_SESSIONS_ROOT}/${sourceKey}`));
  if (isValidTrackingIntent(current, sourceKey) && current.status === 'active' && current.expiresAtMs > nowMs) {
    return { ok: true, removed: false, reason: 'ACTIVE_INTENT' };
  }
  // A replaced publication owns its own event. An old event cannot delete it.
  if (current && !sameTrackingIdentity(current, candidate)) {
    return { ok: true, removed: false, reason: 'INTENT_CHANGED' };
  }
  let matchedSource = false;
  const result = await database.ref(`driver_location_sessions/${sourceKey}`).transaction((/** @type {any} */ source) => {
    if (source === null) { matchedSource = false; return null; }
    if (!sourceMatchesIntent(source, candidate)) return undefined;
    matchedSource = true;
    return null;
  }, undefined, false);
  await reconcileProjection({ database, tourId: candidate.tourId, nowMs });
  return { ok: true, removed: matchedSource && result?.committed === true, tourId: candidate.tourId };
}

/** @param {any} options */
async function cleanupExpiredDriverTrackingIntents({ database, nowMs, limit, reconcileProjection }) {
  const snapshot = await database.ref(DRIVER_TRACKING_SESSIONS_ROOT)
    .orderByChild('expiresAtMs').startAt(1).endAt(nowMs).limitToFirst(limit).get();
  const candidates = snapshot.val() || {};
  let removed = 0;
  let sourcesRemoved = 0;
  const reconciledTours = new Set();
  for (const [sourceKey, candidate] of Object.entries(candidates)) {
    if (!isValidTrackingIntent(candidate, sourceKey) || candidate.expiresAtMs > nowMs) continue;
    const result = await reconcileDriverTrackingIntentChange({
      database, sourceKey, before: candidate, after: candidate, nowMs, reconcileProjection,
    });
    if (result.reason) continue;
    if (result.removed) sourcesRemoved += 1;
    reconciledTours.add(candidate.tourId);
    let matchedIntent = false;
    const deleted = await database.ref(`${DRIVER_TRACKING_SESSIONS_ROOT}/${sourceKey}`).transaction((/** @type {any} */ current) => {
      if (current === null) { matchedIntent = false; return null; }
      if (!isValidTrackingIntent(current, sourceKey) || !sameTrackingIdentity(current, candidate)
        || current.status !== candidate.status || current.expiresAtMs > nowMs) return undefined;
      matchedIntent = true;
      return null;
    }, undefined, false);
    if (matchedIntent && deleted?.committed === true) removed += 1;
  }
  return { scanned: Object.keys(candidates).length, removed, sourcesRemoved,
    reconciledTours: [...reconciledTours].sort(), hasMore: Object.keys(candidates).length >= limit };
}

/** @param {any} record @param {any} session */
const matchesCapturedTrackingSession = (record, session) => Boolean(record
  && record.authUid === session.authUid && record.appSessionId === session.sessionId
  && record.driverId === session.driverId && record.tourId === session.tourId);

/**
 * Session cleanup uses captured server scope, never a refreshed profile or role.
 * Retire first and preserve immutable fences until expiry so delayed callbacks
 * cannot republish between source cleanup and session authority removal.
 * @param {any} options
 */
async function retireDriverTrackingIntentsForAppSession({ database, session }) {
  if (session?.principalType !== 'driver'
    || ![session.authUid, session.driverId, session.tourId].every(isValidFirebaseKey)) {
    return { ok: true, retired: 0, scanned: 0 };
  }
  let query = database.ref(DRIVER_TRACKING_SESSIONS_ROOT).orderByChild('appSessionId');
  if (typeof query.equalTo === 'function') query = query.equalTo(session.sessionId);
  const candidates = await readValue(query);
  let retired = 0;
  for (const [sourceKey, candidate] of Object.entries(candidates || {})) {
    if (!isValidTrackingIntent(candidate, sourceKey) || !matchesCapturedTrackingSession(candidate, session)) continue;
    let changed = false;
    const result = await database.ref(`${DRIVER_TRACKING_SESSIONS_ROOT}/${sourceKey}`).transaction((/** @type {any} */ current) => {
      // Null can be a cold cache. Let the transaction retry against server state.
      if (current === null) return null;
      if (!isValidTrackingIntent(current, sourceKey) || !sameTrackingIdentity(current, candidate)
        || !matchesCapturedTrackingSession(current, session)) return undefined;
      changed = current.status === 'active';
      return { ...current, status: 'stopped' };
    }, undefined, false);
    if (changed && result?.committed === true) retired += 1;
  }
  return { ok: true, retired, scanned: Object.keys(candidates || {}).length };
}

module.exports = {
  DRIVER_TRACKING_SESSIONS_ROOT,
  cleanupExpiredDriverTrackingIntents,
  hasActiveTrackingIntent,
  isTrackedLiveSharingSession,
  isValidTrackingIntent,
  reconcileDriverTrackingIntentChange,
  retireDriverTrackingIntentsForAppSession,
  sameTrackingIdentity,
  sourceMatchesIntent,
  trackingSourceKey,
};
