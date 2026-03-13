import { get, ref } from 'firebase/database';
import { nowAsISOString, toEpochMsStrict } from '../utils/dateUtils';
import unifiedSyncContract from './unifiedSyncContract';

const { HEALTH_STATE, UNIFIED_SYNC_STATES: HEALTH_META } = unifiedSyncContract;

export { HEALTH_STATE };


const HEALTH_COLOR_BY_SEVERITY = {
  critical: 'red',
  warning: 'orange',
  info: 'yellow',
  success: 'green',
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
    color: HEALTH_COLOR_BY_SEVERITY[meta.severity] || 'gray',
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
