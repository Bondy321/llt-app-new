// hooks/useDiagnostics.js
// Centralized diagnostics for network, app state, Firebase connectivity, and offline sync state
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { realtimeDb, updateNetworkState } from '../firebase';
import logger from '../services/loggerService';
import {
  subscribeQueueState,
  getTourPackMeta,
  getStaleness,
} from '../services/offlineSyncService';

const FIREBASE_PROBE_PATH = '.info/serverTimeOffset';

const DEFAULT_QUEUE_STATS = { pending: 0, failed: 0, syncing: 0, total: 0 };

const useDiagnostics = ({ onForeground, tourId, role } = {}) => {
  const [isConnected, setIsConnected] = useState(true);
  const [firebaseConnected, setFirebaseConnected] = useState(true);
  const [lastFirebaseError, setLastFirebaseError] = useState(null);
  const [lastProbeDurationMs, setLastProbeDurationMs] = useState(null);

  // Offline sync state
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [queueStats, setQueueStats] = useState(DEFAULT_QUEUE_STATS);

  const appState = useRef(AppState.currentState);
  const firebaseListenerRef = useRef(null);

  const probeFirebase = async (reason = 'manual') => {
    if (!realtimeDb?.ref) {
      setFirebaseConnected(false);
      setLastFirebaseError('Realtime database unavailable');
      logger.warn('Diagnostics', 'Realtime database not available during probe', { reason });
      return;
    }

    const start = Date.now();

    try {
      await realtimeDb.ref(FIREBASE_PROBE_PATH).once('value');
      const duration = Date.now() - start;
      setLastProbeDurationMs(duration);
      setLastFirebaseError(null);
      setFirebaseConnected(true);
      logger.info('Diagnostics', 'Firebase probe successful', { reason, durationMs: duration });
    } catch (error) {
      const duration = Date.now() - start;
      setLastProbeDurationMs(duration);
      setFirebaseConnected(false);
      setLastFirebaseError(error.message);
      logger.error('Diagnostics', 'Firebase probe failed', { reason, durationMs: duration, error: error.message });
    }
  };

  // Derive syncHealth from connectivity and staleness
  const syncHealth = useMemo(() => {
    if (!isConnected) return 'offline';
    if (!firebaseConnected) return 'degraded';

    const staleness = getStaleness(lastSyncAt);
    if (staleness === 'old' || staleness === 'stale') return 'stale';

    return 'healthy';
  }, [isConnected, firebaseConnected, lastSyncAt]);

  // Load Tour Pack meta when tourId or role changes
  const loadTourPackMeta = useCallback(async () => {
    if (!tourId) return;

    try {
      const meta = await getTourPackMeta(tourId, role);
      if (meta?.lastSyncAt) {
        setLastSyncAt(meta.lastSyncAt);
        logger.info('Diagnostics', 'Tour pack meta loaded', {
          tourId,
          role,
          lastSyncAt: meta.lastSyncAt,
        });
      }
    } catch (error) {
      logger.error('Diagnostics', 'Failed to load tour pack meta', {
        tourId,
        role,
        error: error.message,
      });
    }
  }, [tourId, role]);

  // Effect: load tour pack meta on mount or when tourId/role changes
  useEffect(() => {
    loadTourPackMeta();
  }, [loadTourPackMeta]);

  // Effect: subscribe to offline queue state changes
  useEffect(() => {
    const unsubscribeQueue = subscribeQueueState((state) => {
      setQueueStats({
        pending: state?.pending ?? 0,
        failed: state?.failed ?? 0,
        syncing: state?.syncing ?? 0,
        total: state?.total ?? 0,
      });
      logger.info('Diagnostics', 'Queue state updated', { queueStats: state });
    });

    return () => {
      if (typeof unsubscribeQueue === 'function') {
        unsubscribeQueue();
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected);
      setIsConnected(online);
      updateNetworkState(online);
      logger.info('Diagnostics', 'Network state changed', {
        isConnected: online,
        isInternetReachable: state.isInternetReachable,
        details: state.details || null,
      });

      if (online) {
        probeFirebase('network_recovered');
      }
    });

    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      const prevState = appState.current;
      appState.current = nextAppState;
      logger.info('Diagnostics', 'App state changed', { from: prevState, to: nextAppState });

      if (prevState.match(/inactive|background/) && nextAppState === 'active') {
        probeFirebase('app_foreground');
        if (typeof onForeground === 'function') {
          onForeground();
        }
      }
    });

    if (realtimeDb?.ref) {
      firebaseListenerRef.current = realtimeDb.ref('.info/connected');
      firebaseListenerRef.current.on('value', (snapshot) => {
        const connected = Boolean(snapshot.val());
        setFirebaseConnected(connected);
        logger.info('Diagnostics', 'Realtime database connection updated', { connected });
        if (connected) setLastFirebaseError(null);
      });
    } else {
      setFirebaseConnected(false);
      setLastFirebaseError('Realtime database unavailable');
      logger.warn('Diagnostics', 'Realtime database not available; connection watcher skipped');
    }

    probeFirebase('startup');

    return () => {
      unsubscribeNetInfo?.();
      appStateSubscription?.remove();
      if (firebaseListenerRef.current) {
        firebaseListenerRef.current.off();
      }
    };
  }, []);

  return {
    isConnected,
    firebaseConnected,
    lastFirebaseError,
    lastProbeDurationMs,
    lastSyncAt,
    queueStats,
    syncHealth,
  };
};

export default useDiagnostics;
