import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import driverTourPackService from '../services/driverTourPackService';
import { getDriverTourPackFreshness } from '../services/driverTourPackFreshness';

const initial = { state: 'missing', pack: null, error: null, source: null, revision: null, loading: true };

export default function useDriverTourPack(scope, { service = driverTourPackService, enabled = true } = {}) {
  const [state, setState] = useState(initial);
  const generation = useRef(0);
  const normalized = useMemo(() => service.normalizeScope(scope), [scope?.authUid, scope?.driverId, scope?.departureKey, scope?.tourId, scope?.startDate, service]);
  const refresh = useCallback(async ({ force = false } = {}) => {
    const token = generation.current;
    if (!enabled || !normalized.ok) return;
    const cached = await service.load(normalized);
    if (token !== generation.current) return;
    const cachedRevision = cached.success ? cached.data?.revision : null;
    if (cached.success && cached.data?.pack) setState({ state: cached.data.freshness.state, pack: cached.data.pack, error: null, source: 'cache', revision: cachedRevision, loading: false });
    if (!force) return;
    const remote = await service.fetchRemote(normalized);
    if (token !== generation.current) return;
    if (remote.success) {
      const pack = remote.data.pack;
      setState({ state: remote.data.freshness.state, pack: pack || null, error: null, source: 'remote', revision: remote.data.revision ?? pack?.revision ?? null, loading: false });
    }
    else setState((previous) => ({ ...previous, state: previous.pack ? previous.state : 'failed', error: remote.error, loading: false }));
  }, [enabled, normalized, service]);
  useEffect(() => {
    generation.current += 1; const token = generation.current; if (!enabled || !normalized.ok) { setState({ ...initial, loading: false, error: normalized.reason || null }); return undefined; }
    let lastRevision = null;
    let unsubscribe = () => {};
    (async () => {
      const cached = await service.load(normalized);
      if (token !== generation.current) return;
      if (cached.success && cached.data?.pack) {
        lastRevision = cached.data.revision;
        setState({ state: cached.data.freshness.state, pack: cached.data.pack, error: null, source: 'cache', revision: lastRevision, loading: false });
      } else if (cached.success && cached.data?.freshness) {
        lastRevision = cached.data.revision;
        setState({ state: cached.data.freshness.state, pack: null, error: null, source: 'cache', revision: lastRevision, loading: false });
      }
      unsubscribe = service.subscribeRevision(normalized, ({ revision }) => {
        if (token !== generation.current) return;
        if (!Number.isSafeInteger(revision)) {
          setState((previous) => previous.pack ? previous : { ...initial, state: 'missing', loading: false });
          return;
        }
        if (revision === lastRevision) return;
        service.fetchRemote(normalized).then((next) => {
          if (token !== generation.current || !next.success) {
            if (token === generation.current) setState((previous) => previous.pack ? { ...previous, error: next?.error || 'Driver Tour Pack refresh failed', loading: false } : { ...previous, state: 'failed', error: next?.error || 'Driver Tour Pack refresh failed', loading: false });
            return;
          }
          lastRevision = next.data.revision;
          if (!next.data.pack) {
            setState({ state: next.data.freshness.state, pack: null, error: null, source: 'remote', revision: lastRevision, loading: false });
            return;
          }
          setState({ state: next.data.freshness.state, pack: next.data.pack, error: null, source: 'remote', revision: lastRevision, loading: false });
        });
      }, (error) => { if (token === generation.current) setState((p) => p.pack ? ({ ...p, error: error?.message || String(error), loading: false }) : ({ ...p, state: 'failed', error: error?.message || String(error), loading: false })); });
    })().catch((error) => { if (token === generation.current) setState((p) => p.pack ? { ...p, error: error?.message || String(error), loading: false } : { ...p, state: 'failed', error: error?.message || String(error), loading: false }); });
    return () => { generation.current += 1; unsubscribe?.(); };
  }, [enabled, normalized, service]);
  const purge = useCallback(() => normalized.ok ? service.purge(normalized) : Promise.resolve({ success: false, error: normalized.reason }), [normalized, service]);
  return { ...state, freshness: state.pack ? getDriverTourPackFreshness(state.pack) : { state: state.state }, refresh, purge, scope: normalized.ok ? normalized : null };
}
