import { get, ref } from 'firebase/database';
import { nowAsISOString, toEpochMsStrict } from '../utils/dateUtils';

export const HEALTH_STATE = {
  OFFLINE_NO_NETWORK: 'OFFLINE_NO_NETWORK',
  ONLINE_BACKEND_DEGRADED: 'ONLINE_BACKEND_DEGRADED',
  ONLINE_BACKLOG_PENDING: 'ONLINE_BACKLOG_PENDING',
  ONLINE_HEALTHY: 'ONLINE_HEALTHY',
};

const HEALTH_META = {
  [HEALTH_STATE.OFFLINE_NO_NETWORK]: {
    label: 'Offline',
    description: 'No network or listener connectivity detected.',
    severity: 'critical',
    color: 'red',
    icon: 'plug-off',
    canRetry: true,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_BACKEND_DEGRADED]: {
    label: 'Service issue',
    description: 'Backend is reachable but errors are affecting sync.',
    severity: 'high',
    color: 'orange',
    icon: 'alert-triangle',
    canRetry: true,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_BACKLOG_PENDING]: {
    label: 'Syncing backlog',
    description: 'System is online with pending operations to flush.',
    severity: 'medium',
    color: 'yellow',
    icon: 'clock',
    canRetry: true,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_HEALTHY]: {
    label: 'Up to date',
    description: 'Everything is synced and working normally.',
    severity: 'low',
    color: 'green',
    icon: 'circle-check',
    canRetry: false,
    showLastSync: true,
  },
};

const DEFAULT_STALE_MS = 2 * 60 * 1000;

export function deriveHealthState(signals, options = {}) {
  const {
    listenerConnected = true,
    listenerErrorCount = 0,
    pendingFailedOperations = 0,
    backlogPendingCount = 0,
    lastSuccessfulSyncAt,
    isOnline = true,
  } = signals || {};

  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now();
  const lastSyncTs = lastSuccessfulSyncAt ? toEpochMsStrict(lastSuccessfulSyncAt) : null;
  const hasFreshSync = Number.isFinite(lastSyncTs) && now - lastSyncTs <= staleMs;

  if (!isOnline || !listenerConnected) {
    return HEALTH_STATE.OFFLINE_NO_NETWORK;
  }

  if (listenerErrorCount > 0 || pendingFailedOperations > 0) {
    return HEALTH_STATE.ONLINE_BACKEND_DEGRADED;
  }

  if (backlogPendingCount > 0 || !hasFreshSync) {
    return HEALTH_STATE.ONLINE_BACKLOG_PENDING;
  }

  return HEALTH_STATE.ONLINE_HEALTHY;
}

export function buildHealthSnapshot(signals, options = {}) {
  const state = deriveHealthState(signals, options);
  const meta = HEALTH_META[state];

  return {
    state,
    ...meta,
    lastSuccessfulSyncAt: signals?.lastSuccessfulSyncAt ?? null,
  };
}

export function buildDashboardStatusChips(healthSnapshot) {
  const base = {
    mobileStateKey: healthSnapshot.state,
    label: healthSnapshot.label,
    color: healthSnapshot.color,
  };

  return {
    DATABASE_CONNECTION: {
      ...base,
      description: 'Realtime listeners for drivers/tours',
    },
    REALTIME_SYNC: {
      ...base,
      description: healthSnapshot.description,
    },
    BROADCAST_SYSTEM: {
      ...base,
      description: 'Refresh + broadcast dependencies',
    },
  };
}

export async function revalidateDashboardData(database) {
  const [driversSnap, toursSnap] = await Promise.all([
    get(ref(database, 'drivers')),
    get(ref(database, 'tours')),
  ]);

  return {
    drivers: driversSnap.val() || {},
    tours: toursSnap.val() || {},
    revalidatedAt: nowAsISOString(),
  };
}
