const { PARTS, normalizeScope, normalizeEnvelope, normalizePart, sameScope, versionValid } = require('./tripBoundary');
const { validateContract } = require('../../src/shared/contracts/generated/passengerTrip');

const createPassengerTripController = ({ scope: inputScope, seed, cache, request, subscribeSignals,
  migrateSeed = async (_scope, value) => value,
  onInvalidSession = () => {}, schedule = setTimeout, cancel = clearTimeout,
  diagnostics = () => {}, coalesceMs = 40 }) => {
  const scope = normalizeScope(inputScope);
  if (!scope) throw new Error('INVALID_TRIP_SCOPE');
  let stopped = false;
  let online = false;
  let foreground = true;
  let timer = null;
  const retries = new Map();
  const readStarted = new Set();
  let inFlight = null;
  let unsubscribe = null;
  let abort = null;
  let hydrated = false;
  let state = { scope, parts: {}, checking: false };
  const listeners = new Set();
  const dirty = new Set();
  const signals = new Map();
  const waiters = [];
  const current = () => !stopped;
  const emit = () => { if (current()) listeners.forEach((listener) => listener(state)); };
  const install = (envelope, persisted) => {
    if (!envelope) return;
    state = { ...state, parts: Object.fromEntries(Object.entries(envelope.parts).map(([name, part]) =>
      [name, { ...part, status: 'saved', persisted }])) };
    emit();
  };
  install(normalizeEnvelope(seed, scope), false);
  const persist = async () => {
    const captured = state.parts;
    try {
      const saved = await cache.write(scope, { schemaVersion: 1, scope, parts: captured }, current);
      if (!current() || !saved) return;
      const parts = { ...state.parts };
      for (const name of PARTS) if (parts[name] === captured[name] && parts[name] && !parts[name].persisted) {
        parts[name] = { ...parts[name], persisted: true };
      }
      state = { ...state, parts };
    } catch {
      if (!current()) return;
      diagnostics('cache_save_failed', {});
    }
    emit();
  };
  const ready = (async () => {
    try {
      const cached = await cache.read(scope);
      if (!current()) return;
      if (cached) install(cached, true);
      else if (Object.keys(state.parts).length) {
        const migrated = await migrateSeed(scope, seed);
        if (!current()) return;
        install(normalizeEnvelope(migrated, scope), false);
        await persist();
      }
    } catch { diagnostics('cache_read_failed', {}); }
    hydrated = true;
  })();
  const settle = () => { waiters.splice(0).forEach((resolve) => resolve(state)); };
  const markSaved = () => {
    state = { ...state, parts: Object.fromEntries(Object.entries(state.parts).map(([name, part]) =>
      [name, { ...part, status: part.status === 'error' ? 'error' : 'saved' }])) };
    emit();
  };
  const apply = (response, requested) => {
    if (!validateContract('PassengerTripSnapshot', response).valid || !sameScope(response.scope, scope)
      || !Number.isSafeInteger(response.checkedAtMs) || response.checkedAtMs <= 0) throw new Error('INVALID_RESPONSE');
    const parts = { ...state.parts };
    const unavailable = [];
    for (const name of requested) {
      const incoming = response.parts?.[name];
      const old = parts[name];
      if (incoming?.status === 'unavailable' || !incoming) {
        parts[name] = { ...old, status: 'error', error: 'SOURCE_UNAVAILABLE' };
        unavailable.push(name);
        continue;
      }
      if (!versionValid(incoming.version)) throw new Error('INVALID_RESPONSE');
      let data;
      if (incoming.status === 'unchanged' && old && old.version === incoming.version) data = old.data;
      else if (incoming.status === 'absent' && name === 'itinerary') data = null;
      else if (incoming.status === 'value') {
        data = normalizePart(name, incoming.data, scope);
        if (!data) throw new Error('INVALID_RESPONSE');
      } else throw new Error('INVALID_RESPONSE');
      if (old?.version === incoming.version) data = old.data;
      parts[name] = { data, version: incoming.version, checkedAtMs: response.checkedAtMs,
        status: online && foreground ? 'checked' : 'saved', persisted: false, error: null };
    }
    state = { ...state, parts };
    emit();
    return unavailable;
  };
  const kick = () => {
    if (timer || inFlight || !online || !foreground || !current()) return;
    timer = schedule(() => { timer = null; run(); }, coalesceMs);
  };
  const cancelRetries = (names, reset = false) => {
    names.forEach((name) => {
      const retry = retries.get(name);
      if (retry?.timer) cancel(retry.timer);
      if (reset) retries.delete(name);
      else if (retry) retry.timer = null;
    });
  };
  const retryParts = (names) => {
    if (!current() || !online || !foreground) return;
    names.forEach((name) => {
      const retry = retries.get(name) || { count: 0, timer: null };
      if (retry.timer || retry.count >= 3) return;
      retry.count += 1;
      retry.timer = schedule(() => {
        retry.timer = null;
        if (!current() || !online || !foreground) return;
        dirty.add(name); kick();
      }, 1000 * (2 ** (retry.count - 1)));
      retries.set(name, retry);
    });
  };
  const fail = (requested, error) => {
    const reason = error?.reason || error?.message || 'NETWORK_ERROR';
    state = { ...state, parts: { ...state.parts } };
    requested.forEach((name) => { state.parts[name] = { ...state.parts[name], status: 'error', error: reason }; });
    if (error?.invalidSession === true) {
      stop();
      onInvalidSession({ reason });
    } else retryParts(requested);
  };
  const run = () => {
    if (inFlight || !current() || !online || !foreground || !dirty.size) { settle(); return; }
    inFlight = (async () => {
      await ready;
      if (!current() || !online || !foreground) return;
      const requested = PARTS.filter((part) => dirty.has(part));
      requested.forEach((part) => dirty.delete(part));
      cancelRetries(requested);
      requested.forEach((part) => readStarted.add(part));
      state = { ...state, checking: true, parts: { ...state.parts } };
      requested.forEach((name) => { state.parts[name] = { ...state.parts[name], status: 'checking' }; });
      emit();
      abort = new AbortController();
      try {
        diagnostics('refresh', { parts: requested });
        const response = await request({ scope, parts: requested,
          versions: Object.fromEntries(requested.filter((name) => state.parts[name]?.version)
            .map((name) => [name, state.parts[name].version])), signal: abort.signal });
        if (!current()) return;
        const unavailable = apply(response, requested);
        cancelRetries(requested.filter((name) => !unavailable.includes(name)), true);
        retryParts(unavailable);
        await persist();
      } catch (error) { if (current()) fail(requested, error); }
      finally { abort = null; }
    })().finally(() => {
      inFlight = null;
      if (!current()) { settle(); return; }
      state = { ...state, checking: false };
      emit();
      if (dirty.size && online && foreground) kick();
      else settle();
    });
  };
  const refresh = (reason = 'manual', parts = PARTS) => {
    if (!current()) return Promise.resolve(state);
    const requested = parts.filter((part) => PARTS.includes(part));
    requested.forEach((part) => dirty.add(part));
    cancelRetries(requested, reason !== 'signal');
    diagnostics('refresh_requested', { reason, coalesced: Boolean(inFlight || timer) });
    if (!online || !foreground) { markSaved(); return Promise.resolve(state); }
    const result = new Promise((resolve) => waiters.push(resolve));
    if (reason === 'manual' && !inFlight) { if (timer) cancel(timer); timer = null; run(); }
    else kick();
    return result;
  };
  const onSignal = (name, value) => {
    if (!current()) return;
    const signature = JSON.stringify(value ?? null);
    const previous = signals.get(name);
    signals.set(name, signature);
    // An initial callback is covered only if this part's read has not started.
    // A delayed first delivery may already represent a newer source generation.
    if (previous === signature || (previous === undefined && !readStarted.has(name))) return;
    refresh('signal', [name]);
  };
  const setAvailability = (connected, active = true) => {
    const wasAvailable = online && foreground;
    online = connected; foreground = active;
    if (!current()) return;
    if (online && foreground) {
      if (!unsubscribe) unsubscribe = subscribeSignals(scope, onSignal, () => { markSaved(); });
      if (!wasAvailable) refresh(hydrated ? 'reconnect' : 'start');
    } else {
      if (timer) cancel(timer); timer = null;
      cancelRetries(PARTS);
      unsubscribe?.(); unsubscribe = null;
      markSaved(); settle();
    }
  };
  const stop = () => {
    stopped = true;
    if (timer) cancel(timer);
    cancelRetries(PARTS, true);
    abort?.abort(); unsubscribe?.(); unsubscribe = null;
    listeners.clear(); settle();
  };
  return { scope, ready, getState: () => state, refresh, setAvailability, stop,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async purge() { stop(); await cache.purge(scope); },
  };
};
module.exports = { createPassengerTripController };
