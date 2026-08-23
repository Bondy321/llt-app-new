// hooks/useDiagnostics.js
// Centralized diagnostics for network, app state, and Firebase connectivity
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { realtimeDb, updateNetworkState } from '../firebase';
import logger from '../services/loggerService';
import offlineSyncService from '../services/offlineSyncService';

const FIREBASE_PROBE_PATH = '.info/serverTimeOffset';
const PROBE_WINDOWS_MS = {
  appForeground: 5000,
  networkReconnect: 8000,
};
const SYNC_META_REFRESH_WINDOW_MS = 5000;

const { deriveUnifiedSyncStatus, buildSyncSummary, getLastSuccessAt } = offlineSyncService;

const useDiagnostics = ({ onForeground, activeTourId, role = 'passenger', offlineCacheOwnerId = null } = {}) => {
  const [isConnected, setIsConnected] = useState(true);
  const [firebaseConnected, setFirebaseConnected] = useState(true);
  const [lastFirebaseError, setLastFirebaseError] = useState(null);
  const [lastProbeDurationMs, setLastProbeDurationMs] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [queueStats, setQueueStats] = useState({ pending: 0, syncing: 0, failed: 0, total: 0 });

  const appState = useRef(AppState.currentState);
  const firebaseListenerRef = useRef(null);
  const probeTimersRef = useRef({
    app_foreground: null,
    network_recovered: null,
  });
  const lastProbeAtRef = useRef({
    app_foreground: 0,
    network_recovered: 0,
  });
  const refreshSyncMetaInFlightRef = useRef(null);
  const lastSyncMetaRefreshAtRef = useRef(0);
  const statusRef = useRef({
    isConnected: true,
    firebaseConnected: true,
    appState: AppState.currentState,
  });
  const lastProbeOutcomeRef = useRef({ connected: null, error: null });
  const onForegroundRef = useRef(onForeground);
  const effectGenerationRef = useRef(0);

  useEffect(() => {
    onForegroundRef.current = onForeground;
  }, [onForeground]);

  const refreshSyncMeta = async (generation = effectGenerationRef.current) => {
    const now = Date.now();
    if (refreshSyncMetaInFlightRef.current === generation) {
      return;
    }

    if (now - lastSyncMetaRefreshAtRef.current < SYNC_META_REFRESH_WINDOW_MS) {
      return;
    }

    refreshSyncMetaInFlightRef.current = generation;
    lastSyncMetaRefreshAtRef.current = now;

    try {
      if (activeTourId) {
        const metaResult = await offlineSyncService.getTourPackMeta(
          activeTourId,
          role,
          { ownerId: offlineCacheOwnerId },
        );
        if (generation !== effectGenerationRef.current) return;
        if (metaResult.success && metaResult.data?.lastSyncedAt) {
          setLastSyncAt(metaResult.data.lastSyncedAt);
          return;
        }
      }

      const fallbackResult = await getLastSuccessAt();
      if (generation !== effectGenerationRef.current) return;
      if (fallbackResult.success) {
        setLastSyncAt(fallbackResult.data || null);
      }
    } catch (error) {
      logger.warn('Diagnostics', 'Failed to refresh sync metadata', {
        error: error?.message || String(error),
      });
    } finally {
      if (refreshSyncMetaInFlightRef.current === generation) {
        refreshSyncMetaInFlightRef.current = null;
      }
    }
  };

  const scheduleProbe = (reason, generation = effectGenerationRef.current) => {
    const reasonWindow = reason === 'app_foreground'
      ? PROBE_WINDOWS_MS.appForeground
      : reason === 'network_recovered'
        ? PROBE_WINDOWS_MS.networkReconnect
        : 0;

    if (!reasonWindow) {
      probeFirebase(reason, generation);
      return;
    }

    const now = Date.now();
    const lastRun = lastProbeAtRef.current[reason] || 0;
    const elapsed = now - lastRun;

    if (elapsed >= reasonWindow) {
      probeFirebase(reason, generation);
      return;
    }

    if (probeTimersRef.current[reason]) {
      clearTimeout(probeTimersRef.current[reason]);
    }

    const waitMs = reasonWindow - elapsed;
    probeTimersRef.current[reason] = setTimeout(() => {
      probeTimersRef.current[reason] = null;
      probeFirebase(reason, generation);
    }, waitMs);
  };

  const probeFirebase = async (reason = 'manual', generation = effectGenerationRef.current) => {
    if (reason in lastProbeAtRef.current) {
      lastProbeAtRef.current[reason] = Date.now();
    }

    if (!realtimeDb?.ref) {
      if (generation !== effectGenerationRef.current) return;
      setFirebaseConnected(false);
      setLastFirebaseError('Realtime database unavailable');
      logger.warn('Diagnostics', 'Realtime database not available during probe', { reason });
      return;
    }

    const start = Date.now();

    try {
      await realtimeDb.ref(FIREBASE_PROBE_PATH).once('value');
      if (generation !== effectGenerationRef.current) return;
      const duration = Date.now() - start;
      setLastProbeDurationMs(duration);
      setLastFirebaseError(null);
      setFirebaseConnected(true);
      const previousOutcome = lastProbeOutcomeRef.current;
      const recoveredFromFailure = previousOutcome.connected === false || Boolean(previousOutcome.error);

      if (recoveredFromFailure) {
        logger.info('Diagnostics', 'Firebase probe recovered', { reason, durationMs: duration });
      }

      lastProbeOutcomeRef.current = { connected: true, error: null };
    } catch (error) {
      if (generation !== effectGenerationRef.current) return;
      const duration = Date.now() - start;
      setLastProbeDurationMs(duration);
      setFirebaseConnected(false);
      setLastFirebaseError(error.message);
      const previousOutcome = lastProbeOutcomeRef.current;
      const duplicateFailure = previousOutcome.connected === false && previousOutcome.error === error.message;

      if (!duplicateFailure) {
        logger.error('Diagnostics', 'Firebase probe failed', { reason, durationMs: duration, error: error.message });
      }

      lastProbeOutcomeRef.current = { connected: false, error: error.message };
    }
  };

  useEffect(() => {
    const generation = effectGenerationRef.current + 1;
    effectGenerationRef.current = generation;
    // Identity changes must not retain or throttle against the previous
    // traveller's last-sync label.
    lastSyncMetaRefreshAtRef.current = 0;
    setLastSyncAt(null);
    const unsubscribeQueue = offlineSyncService.subscribeQueueState((stats) => {
      if (generation !== effectGenerationRef.current) return;
      setQueueStats(stats);
    });

    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      if (generation !== effectGenerationRef.current) return;
      const online = Boolean(state.isConnected);

      if (statusRef.current.isConnected === online) {
        updateNetworkState(online);
        return;
      }

      statusRef.current.isConnected = online;
      setIsConnected(online);
      updateNetworkState(online);

      if (!online) {
        logger.warn('Diagnostics', 'Network disconnected', {
          isInternetReachable: state.isInternetReachable,
          details: state.details || null,
        });
      }

      if (online) {
        scheduleProbe('network_recovered', generation);
      }
    });

    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (generation !== effectGenerationRef.current) return;
      const prevState = appState.current;
      appState.current = nextAppState;

      if (statusRef.current.appState !== nextAppState) {
        statusRef.current.appState = nextAppState;
      }

      if (prevState.match(/inactive|background/) && nextAppState === 'active') {
        scheduleProbe('app_foreground', generation);
        refreshSyncMeta(generation);
        const foregroundCallback = onForegroundRef.current;
        if (typeof foregroundCallback === 'function') {
          foregroundCallback();
        }
      }
    });

    if (realtimeDb?.ref) {
      const connectionRef = realtimeDb.ref('.info/connected');
      const onConnectionValue = (snapshot) => {
        if (generation !== effectGenerationRef.current) return;
        const connected = Boolean(snapshot.val());

        if (statusRef.current.firebaseConnected === connected) {
          if (connected) {
            setLastFirebaseError(null);
          }
          return;
        }

        statusRef.current.firebaseConnected = connected;
        setFirebaseConnected(connected);
        if (!connected) {
          logger.warn('Diagnostics', 'Realtime database connection lost');
        }
        if (connected) setLastFirebaseError(null);
      };
      connectionRef.on('value', onConnectionValue);
      firebaseListenerRef.current = { ref: connectionRef, callback: onConnectionValue };
    } else {
      setFirebaseConnected(false);
      setLastFirebaseError('Realtime database unavailable');
      logger.warn('Diagnostics', 'Realtime database not available; connection watcher skipped');
    }

    probeFirebase('startup', generation);
    refreshSyncMeta(generation);

    return () => {
      unsubscribeQueue?.();
      unsubscribeNetInfo?.();
      appStateSubscription?.remove();
      Object.keys(probeTimersRef.current).forEach((reason) => {
        if (probeTimersRef.current[reason]) {
          clearTimeout(probeTimersRef.current[reason]);
          probeTimersRef.current[reason] = null;
        }
      });
      if (effectGenerationRef.current === generation) {
        effectGenerationRef.current += 1;
      }
      if (firebaseListenerRef.current?.ref && firebaseListenerRef.current?.callback) {
        firebaseListenerRef.current.ref.off('value', firebaseListenerRef.current.callback);
        firebaseListenerRef.current = null;
      }
    };
  }, [activeTourId, offlineCacheOwnerId, role]);

  const unifiedSyncStatus = deriveUnifiedSyncStatus({
    network: { isOnline: isConnected },
    backend: {
      isReachable: firebaseConnected,
      isDegraded: Boolean(lastFirebaseError),
    },
    queue: queueStats,
    lastSyncAt,
    syncSummary: buildSyncSummary({
      syncedCount: 0,
      pendingCount: queueStats?.pending,
      failedCount: queueStats?.failed,
      lastSuccessAt: lastSyncAt,
      source: 'unknown',
    }),
  });

  return {
    isConnected,
    firebaseConnected,
    lastFirebaseError,
    lastProbeDurationMs,
    lastSyncAt,
    queueStats,
    unifiedSyncStatus,
  };
};

export default useDiagnostics;
