import { createDriverLocationSessionId } from '../driverLocationService.js';
import { TRACKING_STORAGE_KEY, MAX_SAMPLE_AGE_MS, TRACKING_INTERVAL_MS, normalizeTrackingScope,
  sameTrackingScope, validateTrackingIntent, latestTrackingSample } from './trackingIntent.js';

const off = { state: 'off', status: 'Tracking is off', active: false, pending: false, lastPublishedAtMs: null };
const terminalAuthority = error => /permission.?denied|AUTHORITY|SESSION|AUTH_UID/i.test(error?.code || error?.message || '');

export const createDriverTrackingController = ({ storage, native, verifyAuthority, publish,
  withdraw, writeFence, retireSession = async candidate => {
    await writeFence(candidate, 'stopped');
    return withdraw(candidate);
  }, now = Date.now, makeId = () => `track_${createDriverLocationSessionId()}` }) => {
  let snapshot = off;
  let intent = null;
  let generation = 0;
  let rootAttached = false;
  let scope = null;
  let starting = false;
  let lifecycle = Promise.resolve();
  let publication = null;
  let recovery = null;
  let lastAttemptAtMs = null;
  let storageWrites = Promise.resolve();
  const listeners = new Set();
  const emit = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  const serialize = operation => {
    const result = lifecycle.catch(() => {}).then(operation);
    lifecycle = result;
    return result;
  };
  const read = async () => {
    const raw = await storage.getItem(TRACKING_STORAGE_KEY);
    if (!raw) return null;
    try { return validateTrackingIntent(JSON.parse(raw)); } catch { return null; }
  };
  const writeStorage = operation => {
    const result = storageWrites.catch(() => {}).then(operation);
    storageWrites = result;
    return result;
  };
  const save = value => writeStorage(() => storage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(value)));
  const isCurrent = (candidate, expectedGeneration = generation) => candidate?.status === 'active'
    && generation === expectedGeneration && intent?.status === 'active'
    && intent.liveSharingSessionId === candidate.liveSharingSessionId
    && candidate.scope.expiresAtMs > now()
    && (!rootAttached || sameTrackingScope(candidate.scope, scope));

  const finishStop = async candidate => {
    const errors = [];
    // Persist the stop before remote work. Native cleanup and server cleanup are
    // both retried from this same identity after a crash or a lost response.
    intent = candidate ? { ...candidate, status: 'stopping' } : null;
    if (intent) {
      try { await save(intent); } catch (error) { errors.push(error); }
    }
    try { await native.stop(); } catch (error) { errors.push(error); }
    if (intent) {
      try {
        const result = await retireSession(intent);
        if (result?.withdrawalAcknowledged !== true) throw new Error('WITHDRAWAL_NOT_ACKNOWLEDGED');
      } catch (error) { errors.push(error); }
    }
    if (!errors.length) {
      try { await writeStorage(() => storage.removeItem(TRACKING_STORAGE_KEY)); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      emit({ state: 'stop_pending', status: 'Updates are off. Stop cleanup is pending; reconnect and retry.',
        active: false, pending: true, error: 'STOP_PENDING' });
      return { success: false, reason: 'STOP_PENDING' };
    }
    intent = null;
    emit({ ...off, status: snapshot.stopReason === 'interrupted'
      ? 'Previous tracking was interrupted. Start a new session when ready.' : 'Tracking is off', error: null });
    return { success: true, withdrawalAcknowledged: true };
  };
  const stop = ({ reason = 'driver_stop' } = {}) => {
    generation += 1;
    starting = false;
    const needsDurableStop = intent?.status === 'active';
    if (intent) intent = { ...intent, status: 'stopping' };
    emit({ state: 'stopping', status: 'Updates are off. Confirming stop…', active: false, pending: true, stopReason: reason });
    // Do not leave durable active intent behind a slow Start/HTTP response.
    // Final serialized cleanup also stops any registration completing late.
    const captured = intent;
    const localStop = needsDurableStop ? save(captured).catch(() => {}) : Promise.resolve();
    return serialize(async () => { await localStop; return finishStop(intent || await read()); });
  };
  const setScope = nextScope => {
    rootAttached = true;
    scope = normalizeTrackingScope(nextScope, now());
    if ((intent && !sameTrackingScope(intent.scope, scope)) || (!scope && starting)) {
      return stop({ reason: 'authority_changed' });
    }
    return Promise.resolve();
  };
  const recover = () => {
    if (recovery) return recovery;
    emit({ state: 'recovering', pending: true, status: 'Checking previous tracking session…' });
    recovery = serialize(async () => {
      const stored = await read();
      const registered = await native.isStarted();
      if (stored || registered) {
        generation += 1;
        emit({ stopReason: stored?.status === 'stopping' ? 'driver_stop' : 'interrupted' });
        return finishStop(stored);
      }
      emit({ ...off, error: null });
      return { success: true };
    });
    return recovery;
  };

  const start = async ({ scope: requestedScope, disclosureAccepted = false } = {}) => {
    if (!disclosureAccepted) return { success: false, reason: 'DISCLOSURE_REQUIRED' };
    const capturedScope = normalizeTrackingScope(requestedScope, now());
    if (!capturedScope) return { success: false, reason: 'DRIVER_SESSION_REQUIRED' };
    if (starting || snapshot.pending || snapshot.active) return { success: false, reason: 'TRACKING_BUSY' };
    starting = true;
    const epoch = ++generation;
    const canStart = () => generation === epoch && starting
      && (!rootAttached || sameTrackingScope(capturedScope, scope)) && native.isForeground();
    emit({ state: 'starting', status: 'Checking tracking permissions…', error: null });
    try {
      if (!canStart()) throw new Error('START_INTERRUPTED');
      await native.requestPermissions();
      if (!canStart()) throw new Error('START_INTERRUPTED');
      const authority = await verifyAuthority(capturedScope);
      if (!authority.valid) throw new Error(authority.reason || 'AUTHORITY_CHANGED');
      if (Number.isSafeInteger(authority.expiresAtMs)) capturedScope.expiresAtMs = authority.expiresAtMs;
      if (!canStart()) throw new Error('START_INTERRUPTED');
      return await serialize(async () => {
        if (!canStart()) throw new Error('START_INTERRUPTED');
        if (await read()) throw new Error('STOP_CLEANUP_REQUIRED');
        if (!canStart()) throw new Error('START_INTERRUPTED');
        const candidate = validateTrackingIntent({ schemaVersion: 1, status: 'active', scope: capturedScope,
          liveSharingSessionId: makeId(), startedAtMs: now() });
        if (!candidate) throw new Error('INVALID_TRACKING_INTENT');
        intent = candidate;
        await save(candidate);
        if (!canStart()) throw new Error('START_INTERRUPTED');
        await writeFence(candidate, 'active', canStart);
        if (!canStart()) throw new Error('START_INTERRUPTED');
        await native.start();
        if (!canStart()) throw new Error('START_INTERRUPTED');
        starting = false;
        lastAttemptAtMs = null;
        emit({ state: 'waiting', active: true, pending: false, status: 'Tracking started. Waiting for a fresh GPS update.',
          tourId: capturedScope.tourId, error: null });
        return { success: true };
      });
    } catch (error) {
      if (generation !== epoch) return { success: false, reason: 'START_INTERRUPTED' };
      // Do not use stop() recursively from the serialized operation.
      generation += 1;
      starting = false;
      if (intent) await serialize(() => finishStop(intent));
      else emit({ ...off, state: 'error', status: native.permissionMessage(error), error: error?.message || 'START_FAILED' });
      return { success: false, reason: error?.message || 'START_FAILED' };
    }
  };

  const handleLocations = async ({ locations, error } = {}) => {
    // Coalesce concurrent deliveries; never keep a durable queue of coordinates.
    if (publication) return publication;
    const deliveryGeneration = generation;
    publication = (async () => {
      const stored = await read();
      if (generation !== deliveryGeneration) return { skipped: true };
      if (intent && stored && intent.liveSharingSessionId !== stored.liveSharingSessionId) return { skipped: true };
      if (!stored || stored.status !== 'active') {
        if (stored) await stop({ reason: 'pending_stop' });
        else await native.stop();
        return { skipped: true };
      }
      if (!intent) intent = stored; // A headless wake restores only explicit intent.
      const epoch = generation;
      if (!isCurrent(stored, epoch)) {
        await stop({ reason: 'authority_changed' });
        return { skipped: true };
      }
      if (error) {
        // Native task errors carry no session identity; a delayed error from a
        // previous registration cannot revoke the current session on its own.
        const permitted = await native.hasPermissions();
        if (!isCurrent(stored, epoch)) return { skipped: true };
        if (!permitted) await stop({ reason: 'location_error' });
        else emit({ state: 'paused', active: true, status: 'Tracking is on; GPS reported a problem. Waiting for a fresh update.' });
        return { skipped: true };
      }
      const sample = latestTrackingSample(locations, stored, now());
      if (!sample) { emit({ status: 'Tracking is on. Waiting for a fresh, valid GPS fix.' }); return { skipped: true }; }
      // iOS may deliver frequently while foregrounded; its native timeInterval
      // is Android-only. Bound server work independently of native delivery.
      if (lastAttemptAtMs !== null && now() - lastAttemptAtMs < TRACKING_INTERVAL_MS) return { skipped: true };
      lastAttemptAtMs = now();
      const authority = await verifyAuthority(stored.scope);
      if (!isCurrent(stored, epoch)) return { skipped: true };
      if (!authority.valid) {
        if (authority.reason === 'OFFLINE') {
          emit({ state: 'paused', active: true, status: 'Tracking is on; sharing is paused while offline. Old positions are not queued.' });
          return { skipped: true };
        }
        await stop({ reason: 'authority_changed' }); return { skipped: true };
      }
      if (!isCurrent(stored, epoch)) return { skipped: true };
      const latest = await read();
      if (!isCurrent(stored, epoch)) return { skipped: true };
      if (latest?.status !== 'active' || latest.liveSharingSessionId !== stored.liveSharingSessionId) return { skipped: true };
      try {
        const result = await publish(stored, sample, () => isCurrent(stored, epoch)
          && now() - sample.timestamp <= MAX_SAMPLE_AGE_MS && sample.timestamp <= now() + 5_000);
        if (!isCurrent(stored, epoch) || result.skipped) return { skipped: true };
        emit({ state: 'sharing', active: true, pending: false, status: sample.coords.accuracy > 500
          ? 'Tracking is on. GPS accuracy is low; passengers see this only for context.'
          : 'Tracking is on. Last location update acknowledged.', lastPublishedAtMs: result.timestamp });
        return result;
      } catch (failure) {
        if (!isCurrent(stored, epoch)) return { skipped: true };
        if (terminalAuthority(failure)) await stop({ reason: 'authority_changed' });
        else if (isCurrent(stored, epoch)) emit({ state: 'paused', active: true,
          status: 'Tracking is on; location could not be shared. Waiting for the next fresh update.' });
        return { success: false, reason: 'PUBLICATION_FAILED' };
      }
    })().catch(async () => {
      if (generation !== deliveryGeneration) return { skipped: true };
      await stop({ reason: 'task_error' });
      return { success: false, reason: 'TASK_ERROR' };
    });
    try { return await publication; } finally { publication = null; }
  };
  const checkCurrent = async () => {
    if (snapshot.pending) return stop({ reason: snapshot.stopReason || 'pending_stop' });
    if (!intent || !snapshot.active) return { skipped: true };
    const candidate = intent;
    const epoch = generation;
    if (!isCurrent(candidate, epoch)) return stop({ reason: 'tracking_interrupted' });
    const registered = await native.isStarted();
    const permitted = await native.hasPermissions();
    if (generation !== epoch || intent?.liveSharingSessionId !== candidate.liveSharingSessionId) return { skipped: true };
    if (!isCurrent(candidate, epoch) || !registered || !permitted) {
      return stop({ reason: 'tracking_interrupted' });
    }
    if (snapshot.lastPublishedAtMs && now() - snapshot.lastPublishedAtMs > MAX_SAMPLE_AGE_MS) {
      emit({ state: 'waiting', status: 'Tracking is on, but no recent GPS update has been acknowledged. Check location services and your connection.' });
    }
    return { success: true };
  };
  const purgeScope = async ({ authUid, sessionId } = {}) => {
    const epoch = generation;
    const candidate = intent || await read();
    if (epoch !== generation || (intent && candidate && intent.liveSharingSessionId !== candidate.liveSharingSessionId)) return { success: true, skipped: true };
    if (!candidate || candidate.scope.authUid !== authUid
      || (sessionId && candidate.scope.sessionId !== sessionId)) return { success: true, skipped: true };
    await stop({ reason: 'session_purge' });
    return serialize(async () => {
      if (intent && intent.liveSharingSessionId !== candidate.liveSharingSessionId) return { success: true, skipped: true };
      // Logout/deletion has durable pending recovery that blocks another login.
      // Server session cleanup retires its fences. Local privacy cleanup must
      // not retain the old driver's identity after replacing Firebase Auth.
      await native.stop();
      await writeStorage(() => storage.removeItem(TRACKING_STORAGE_KEY));
      intent = null;
      emit({ ...off, error: null });
      return { success: true };
    });
  };
  return { start, stop, setScope, recover, handleLocations, checkCurrent, purgeScope,
    getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
};
