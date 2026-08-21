import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import actionService from '../services/driverTourPackActionService';
import offlineSyncService from '../services/offlineSyncService';

const EMPTY_ACTIONS = Object.freeze({
  schemaVersion: 1,
  packRevision: 0,
  revisionAcknowledged: 0,
  updatedAtMs: 0,
  pickupStops: {},
  serviceCompletion: {},
  hotelCompletion: {},
  issues: {},
});

export default function useDriverTourPackActions({
  pack,
  driverId,
  authUid,
  isConnected,
  service = actionService,
  queue = offlineSyncService,
} = {}) {
  const [state, setState] = useState({
    actions: EMPTY_ACTIONS,
    change: null,
    source: null,
    loading: true,
    pendingCount: 0,
    queued: false,
    error: null,
  });
  const generation = useRef(0);
  const scope = useMemo(() => service.normalizeScope({
    authUid,
    driverId,
    departureKey: pack?.departureKey,
    tourId: pack?.tourId,
  }), [authUid, driverId, pack?.departureKey, pack?.tourId, service]);
  const queueOwner = useMemo(() => scope.ok ? {
    tourId: scope.tourId,
    principalId: `driver:${scope.driverId}`,
    role: 'driver',
    authUid: scope.authUid,
    cacheOwnerId: scope.driverId,
  } : null, [scope]);

  useEffect(() => {
    generation.current += 1;
    const token = generation.current;
    if (!scope.ok) {
      setState({ actions: EMPTY_ACTIONS, change: null, source: null, loading: false, pendingCount: 0, queued: false, error: null });
      return undefined;
    }
    setState({ actions: EMPTY_ACTIONS, change: null, source: null, loading: true, pendingCount: 0, queued: false, error: null });
    let unsubscribeRemote = () => {};
    let unsubscribeQueue = () => {};
    let remoteSeen = false;
    service.readCache(scope).then((cached) => {
      if (token !== generation.current || remoteSeen || !cached.success) return;
      setState((previous) => ({ ...previous, ...cached.data, source: cached.data?.cachedAtMs ? 'cache' : null, loading: false }));
    }).catch(() => {});
    unsubscribeRemote = service.subscribe(scope, (next) => {
      if (token !== generation.current) return;
      remoteSeen = true;
      setState((previous) => ({ ...previous, ...next, loading: false, error: null }));
    }, (error) => {
      if (token !== generation.current) return;
      setState((previous) => ({ ...previous, loading: false, error: error?.message || String(error) }));
    });
    unsubscribeQueue = queue.subscribeQueuedActions((items = []) => {
      if (token !== generation.current) return;
      const pending = items.filter((item) => item.type === 'DRIVER_TOUR_PACK_ACTION' && item.status !== 'completed');
      setState((previous) => ({ ...previous, pendingCount: pending.length, queued: pending.length > 0 }));
    }, { scope: queueOwner });
    return () => {
      generation.current += 1;
      unsubscribeRemote?.();
      unsubscribeQueue?.();
    };
  }, [queue, queueOwner, scope, service]);

  const submit = useCallback(async (operation) => {
    if (!scope.ok || !pack?.revision) return { success: false, error: 'Driver pack assignment unavailable' };
    const result = await service.submit(scope, { ...operation, packRevision: pack.revision }, { online: Boolean(isConnected) });
    setState((previous) => ({
      ...previous,
      ...(result.data?.actions ? { actions: result.data.actions } : {}),
      queued: Boolean(result.data?.queued) || previous.pendingCount > 0,
      error: result.success ? null : result.error || 'Driver action failed',
    }));
    return result;
  }, [isConnected, pack?.revision, scope, service]);

  const acknowledgementPending = Boolean(
    state.change
    && state.change.revision === pack?.revision
    && state.actions.revisionAcknowledged < state.change.revision,
  );

  return {
    ...state,
    scope: scope.ok ? scope : null,
    acknowledgementPending,
    acknowledge: () => submit({ kind: 'acknowledge' }),
    setPickup: (targetId, progressState) => submit({ kind: 'pickup', targetId, state: progressState }),
    setService: (targetId, completionState) => submit({ kind: 'service', targetId, state: completionState }),
    setHotel: (targetId, completionState) => submit({ kind: 'hotel', targetId, state: completionState }),
    reportIssue: ({ category, severity, summary }) => submit({ kind: 'issue', category, severity, summary }),
  };
}
