const DAY_MS = 24 * 60 * 60 * 1000;

const toMs = (value) => {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : NaN;
};

const getDriverTourPackFreshness = (pack, { now = Date.now(), staleAfterMs = DAY_MS } = {}) => {
  if (!pack || typeof pack !== 'object') return { state: 'missing', reason: 'PACK_MISSING' };
  if (pack.status === 'cancelled' || pack.status === 'withdrawn') return { state: 'withdrawn', reason: 'PACK_WITHDRAWN' };
  const expiresAtMs = toMs(pack.expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return { state: 'expired', reason: 'PACK_EXPIRED' };
  if (pack.quality?.state !== 'complete') return { state: 'incomplete', reason: 'PACK_DEGRADED' };
  const generatedAtMs = toMs(pack.generatedAtMs);
  if (!Number.isFinite(generatedAtMs) || now - generatedAtMs > staleAfterMs) {
    return { state: 'stale', reason: 'PACK_STALE' };
  }
  return { state: 'ready', reason: null };
};

module.exports = { DAY_MS, toMs, getDriverTourPackFreshness };
