import { buildDriverLocationSessionKey } from '../../utils/driverLocation.js';
import { withdrawLiveDriverLocation } from '../driverLocationService.js';

export const withdrawDriverLiveLocationSession = ({ session, pending, dbInstance,
  withdraw = withdrawLiveDriverLocation }) => {
  if (!session) return Promise.resolve({ success: true, skipped: true, reason: 'NO_ACTIVE_LIVE_SESSION' });
  const key = buildDriverLocationSessionKey(session.appSessionId, session.sessionId);
  let entry = pending.get(key);
  if (!entry) { entry = { session, promise: null }; pending.set(key, entry); }
  if (entry.promise) return entry.promise;
  // Retain identity through failure and effect cleanup; Retry must never invent
  // a new key or forget which publication still needs an acknowledged delete.
  const attempt = Promise.resolve().then(() => withdraw({
    tourId: entry.session.tourId,
    appSessionId: entry.session.appSessionId,
    expectedSessionId: entry.session.sessionId,
    dbInstance,
  })).then(result => {
    if (result?.withdrawalAcknowledged !== true) throw new Error('Live location removal was not acknowledged');
    if (pending.get(key) === entry) pending.delete(key);
    return result;
  });
  entry.promise = attempt;
  attempt.then(() => { entry.promise = null; }, () => { entry.promise = null; });
  return attempt;
};

export const withdrawPendingDriverLiveLocations = async ({ pending, dbInstance }) => {
  // Sequential retries keep transport work bounded; errors stay in the map.
  let failure;
  for (const { session } of [...pending.values()]) {
    try { await withdrawDriverLiveLocationSession({ session, pending, dbInstance }); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return { success: true, withdrawalAcknowledged: true };
};
