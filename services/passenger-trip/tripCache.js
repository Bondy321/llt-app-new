const { normalizeEnvelope, normalizeScope, scopeKey } = require('./tripBoundary');

const createTripCache = (storage) => {
  const locks = new Map();
  const keyFor = (scope) => `@LLT:passengerTrip:v1:${encodeURIComponent(scopeKey(scope))}`;
  const serial = (key, work) => {
    const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  };
  return {
    keyFor,
    async read(scope) {
      if (!normalizeScope(scope)) return null;
      const raw = await storage.getItem(keyFor(scope));
      try { return normalizeEnvelope(JSON.parse(raw), scope); } catch { return null; }
    },
    write(scope, envelope, isCurrent = () => true) {
      return serial(keyFor(scope), async () => {
        if (!isCurrent()) return false;
        const safe = normalizeEnvelope(envelope, scope);
        if (!safe) throw new Error('INVALID_TRIP_CACHE');
        await storage.setItem(keyFor(scope), JSON.stringify(safe));
        return isCurrent();
      });
    },
    purge(scope) {
      if (!normalizeScope(scope)) return Promise.resolve();
      return serial(keyFor(scope), () => storage.removeItem(keyFor(scope)));
    },
  };
};
let cache;
const getTripCache = () => {
  if (!cache) cache = createTripCache(require('@react-native-async-storage/async-storage').default);
  return cache;
};
module.exports = { createTripCache, getTripCache };
