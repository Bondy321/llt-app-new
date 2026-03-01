// hooks/useDiagnostics.js
// Centralized diagnostics for network, app state, and Firebase connectivity
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { realtimeDb, updateNetworkState } from '../firebase';
import logger from '../services/loggerService';
import offlineSyncService from '../services/offlineSyncService';

const FIREBASE_PROBE_PATH = '.info/serverTimeOffset';

const useDiagnostics = ({ onForeground, activeTourId, role = 'passenger' } = {}) => {
  const [isConnected, setIsConnected] = useState(true);
  const [firebaseConnected, setFirebaseConnected] = useState(true);
  const [lastFirebaseError, setLastFirebaseError] = useState(null);
  const [lastProbeDurationMs, setLastProbeDurationMs] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [queueStats, setQueueStats] = useState({ pending: 0, syncing: 0, failed: 0, total: 0 });

  const appState = useRef(AppState.currentState);
  const firebaseListenerRef = useRef(null);

  const refreshSyncMeta = async () => {
    const lastSuccessResult = await offlineSyncService.getLastSuccessAt();
    if (lastSuccessResult.success) {
      setLastSuccessAt(lastSuccessResult.data || null);
    }

    if (!activeTourId) return;
    const metaResult = await offlineSyncService.getTourPackMeta(activeTourId, role);
    if (metaResult.success) {
      const lastSyncedAt = metaResult.data?.lastSyncedAt || null;
      setLastSyncAt(lastSyncedAt);
      if (lastSyncedAt) {
        setLastSuccessAt(lastSyncedAt);
      }
    }
  };

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

  useEffect(() => {
    const unsubscribeQueue = offlineSyncService.subscribeQueueState((stats) => {
      setQueueStats(stats);
    });

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
        refreshSyncMeta();
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
    refreshSyncMeta();

    return () => {
      unsubscribeQueue?.();
      unsubscribeNetInfo?.();
      appStateSubscription?.remove();
      if (firebaseListenerRef.current) {
        firebaseListenerRef.current.off();
      }
    };
  }, [activeTourId, role]);

  const unifiedSyncStatus = offlineSyncService.deriveUnifiedSyncStatus({
    isConnected,
    firebaseConnected,
    queueStats,
    syncedCount: 0,
    source: 'diagnostics',
    lastSuccessAt: lastSuccessAt || lastSyncAt || null,
  });

  return {
    isConnected,
    firebaseConnected,
    lastFirebaseError,
    lastProbeDurationMs,
    lastSyncAt,
    lastSuccessAt,
    queueStats,
    unifiedSyncStatus,
  };
};

export default useDiagnostics;
