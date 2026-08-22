const { createPersistenceProvider } = require('./persistenceProvider');
const { normalizeTourId } = require('./tourIdentityService');
const { rehydrateDriverTourPackFromFirebase, validateDriverTourPack } = require('./driverTourPackSchema');
const { getDriverTourPackFreshness } = require('./driverTourPackFreshness');

const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'driver_tour_pack';
const IDENTITY_ERROR = 'DRIVER_TOUR_PACK_IDENTITY_INVALID';
const REMOTE_ERROR = 'DRIVER_TOUR_PACK_REMOTE_INVALID';

const response = (success, data, error = null, code = null) => ({ success, data, error, code });
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const cacheSegment = (value) => encodeURIComponent(clean(value));

function isoDate(value) {
  const text = clean(value);
  let result = null;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.000)?Z?)?$/);
  if (iso) result = iso[1];
  const uk = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: 00:00:00)?$/);
  if (uk) result = `${uk[3]}-${uk[2]}-${uk[1]}`;
  if (!result) return null;
  const [year, month, day] = result.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? result : null;
}

function resolveExactDepartureKey({ departureKey, tourId, startDate, tourStartDate } = {}) {
  const explicit = clean(departureKey);
  if (explicit) {
    const matched = explicit.match(/^(\d{4}-\d{2}-\d{2})::([^.#$/\[\]]+)$/);
    const normalized = normalizeTourId(matched?.[2]);
    if (!matched || !isoDate(matched[1]) || !normalized || `${matched[1]}::${normalized}` !== explicit) {
      return { ok: false, reason: 'DEPARTURE_KEY_INVALID' };
    }
    if (tourId && normalizeTourId(tourId) !== normalized) return { ok: false, reason: 'DEPARTURE_KEY_TOUR_MISMATCH' };
    return { ok: true, departureKey: explicit, tourId: normalized, dateISO: matched[1], source: 'explicit' };
  }
  const normalizedTourId = normalizeTourId(tourId);
  const dateISO = isoDate(startDate || tourStartDate);
  if (!normalizedTourId || !dateISO) return { ok: false, reason: 'DEPARTURE_KEY_REQUIRED' };
  return { ok: true, departureKey: `${dateISO}::${normalizedTourId}`, tourId: normalizedTourId, dateISO, source: 'derived' };
}

function normalizeScope(scope = {}) {
  const identity = resolveExactDepartureKey(scope);
  const authUid = clean(scope.authUid);
  const driverId = clean(scope.driverId).toUpperCase();
  if (!identity.ok || !authUid || !/^D-[A-Z0-9_-]+$/.test(driverId)) return { ok: false, reason: identity.reason || IDENTITY_ERROR };
  return { ok: true, ...identity, authUid, driverId };
}

const cacheKey = (scope) => `${CACHE_PREFIX}_${CACHE_VERSION}_${cacheSegment(scope.authUid)}_${cacheSegment(scope.driverId)}_${cacheSegment(scope.departureKey)}`;

function validateDriverTourPackAssignment({ authUid, driverId, driverAuthUid, assignedDepartureKey, tourId, startDate, manifestAssigned, pack } = {}) {
  const scope = normalizeScope({ authUid, driverId, departureKey: assignedDepartureKey, tourId, startDate });
  if (!scope.ok) return { valid: false, reason: scope.reason };
  if (clean(driverAuthUid) !== scope.authUid) return { valid: false, reason: 'DRIVER_AUTH_MISMATCH' };
  if (manifestAssigned !== true) return { valid: false, reason: 'MANIFEST_ASSIGNMENT_MISSING' };
  const check = validateDriverTourPack(pack);
  if (!check.valid) return { valid: false, reason: REMOTE_ERROR, errors: check.errors };
  if (pack.departureKey !== scope.departureKey || pack.tourId !== scope.tourId) return { valid: false, reason: 'PACK_ASSIGNMENT_MISMATCH' };
  return { valid: true, scope };
}

function createDriverTourPackService({ storage = createPersistenceProvider({ namespace: 'LLT_DRIVER_TOUR_PACK', preferredStorage: 'async-storage', allowMemoryFallback: process.env.NODE_ENV === 'test' }), db = null, validator = validateDriverTourPack, now = () => Date.now() } = {}) {
  const locks = new Map();
  const generations = new Map();
  const withLock = async (key, fn) => { const prior = locks.get(key) || Promise.resolve(); const next = prior.catch(() => {}).then(fn); locks.set(key,next); try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); } };
  const currentGeneration = (key) => generations.get(key) || 0;
  const revokeGeneration = (key) => { const next = currentGeneration(key) + 1; generations.set(key, next); return next; };
  const database = () => {
    if (db?.ref) return db;
    try { return require('../firebase').realtimeDb || null; } catch { return null; }
  };
  const deleteKey = async (scope) => storage.deleteItemAsync(cacheKey(scope));
  const load = async (scopeInput) => {
    const scope = normalizeScope(scopeInput); if (!scope.ok) return response(false,null,scope.reason,IDENTITY_ERROR);
    const key = cacheKey(scope);
    try {
      return await withLock(key, async () => {
        const raw = await storage.getItemAsync(key);
        if (!raw) return response(true,null);
        const entry = JSON.parse(raw);
        const check = validator(entry?.pack);
        if (!check.valid || entry.pack.departureKey !== scope.departureKey) {
          await storage.deleteItemAsync(key);
          return response(false,null,'Cached pack is malformed',REMOTE_ERROR);
        }
        const freshness=getDriverTourPackFreshness(entry.pack,{now:now()});
        if(['expired','withdrawn'].includes(freshness.state)){
          await storage.deleteItemAsync(key);
          return response(true,{pack:null,revision:entry.pack.revision,freshness});
        }
        return response(true,{ pack: entry.pack, cachedAtMs: entry.cachedAtMs || null, revision: entry.pack.revision, freshness });
      });
    } catch (error) { return response(false,null,error?.message || String(error),'DRIVER_TOUR_PACK_CACHE_READ_FAILED'); }
  };
  const replace = async (scopeInput, pack, { cachedAtMs = now(), expectedGeneration = null } = {}) => {
    const scope = normalizeScope(scopeInput); if (!scope.ok) return response(false,null,scope.reason,IDENTITY_ERROR);
    const check = validator(pack); if (!check.valid) return response(false,null,'Driver Tour Pack failed validation',REMOTE_ERROR);
    if (pack.departureKey !== scope.departureKey || pack.tourId !== scope.tourId) return response(false,null,'Pack does not match driver scope','DRIVER_TOUR_PACK_SCOPE_MISMATCH');
    const key = cacheKey(scope); try { const entry = await withLock(key, async () => {
      if (expectedGeneration !== null && currentGeneration(key) !== expectedGeneration) return null;
      const next = { pack, cachedAtMs };
      await storage.setItemAsync(key, JSON.stringify(next));
      return next;
    });
    if (!entry) return response(false,null,'Driver Tour Pack scope was revoked','DRIVER_TOUR_PACK_SCOPE_REVOKED');
    return response(true,entry); } catch(error) { return response(false,null,error?.message || String(error),'DRIVER_TOUR_PACK_CACHE_WRITE_FAILED'); }
  };
  const purge = async (scopeInput) => { const scope=normalizeScope(scopeInput); if(!scope.ok)return response(false,null,scope.reason,IDENTITY_ERROR); const key=cacheKey(scope); try { const generation=await withLock(key,async()=>{const next=revokeGeneration(key);await deleteKey(scope);return next;}); return response(true,{purged:true,generation}); } catch(error){return response(false,null,error?.message || String(error),'DRIVER_TOUR_PACK_PURGE_FAILED');} };
  const fetchRemote = async (scopeInput) => {
    const scope=normalizeScope(scopeInput); const activeDb=database(); if(!scope.ok)return response(false,null,scope.reason,IDENTITY_ERROR); if(!activeDb?.ref)return response(false,null,'Driver Tour Pack database unavailable','DRIVER_TOUR_PACK_DB_UNAVAILABLE');
    const key=cacheKey(scope); const expectedGeneration=currentGeneration(key);
    try { const snapshot=await activeDb.ref(`driver_tour_packs/${scope.departureKey}`).once('value'); const remote=snapshot?.val?.(); if(!remote)return response(false,null,'Driver Tour Pack is unavailable','DRIVER_TOUR_PACK_REMOTE_MISSING'); const pack=rehydrateDriverTourPackFromFirebase(remote); const check=validator(pack); if(!check.valid)return response(false,null,'Driver Tour Pack failed validation',REMOTE_ERROR); const freshness=getDriverTourPackFreshness(pack,{now:now()}); if(['expired','withdrawn'].includes(freshness.state)){await purge(scope);return response(true,{pack:null,revision:pack.revision,freshness,source:'remote'});} const saved=await replace(scope,pack,{expectedGeneration}); if(!saved.success)return saved; return response(true,{...saved.data, source:'remote', freshness}); } catch(error) { return response(false,null,error?.message || String(error),'DRIVER_TOUR_PACK_REMOTE_FETCH_FAILED'); }
  };
  const subscribeRevision = (scopeInput, onChange, onError) => {
    const scope=normalizeScope(scopeInput); const activeDb=database(); if(!scope.ok){onError?.(new Error(scope.reason));return ()=>{};} if(!activeDb?.ref){onError?.(new Error('Driver Tour Pack database unavailable'));return ()=>{};}
    const ref=activeDb.ref(`driver_tour_packs/${scope.departureKey}/revision`); const listener=(snapshot)=>onChange?.({ revision:snapshot?.val?.() ?? null, scope }); const error=(err)=>onError?.(err); ref.on('value',listener,error); return ()=>ref.off?.('value',listener);
  };
  return { cacheKey, load, replace, purge, fetchRemote, subscribeRevision, resolveExactDepartureKey, validateDriverTourPackAssignment };
}

const driverTourPackService = createDriverTourPackService();
module.exports = { CACHE_PREFIX, CACHE_VERSION, resolveExactDepartureKey, normalizeScope, validateDriverTourPackAssignment, createDriverTourPackService, ...driverTourPackService };
