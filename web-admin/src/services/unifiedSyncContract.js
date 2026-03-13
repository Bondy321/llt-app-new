const HEALTH_STATE = {
  OFFLINE_NO_NETWORK: 'OFFLINE_NO_NETWORK',
  ONLINE_BACKEND_DEGRADED: 'ONLINE_BACKEND_DEGRADED',
  ONLINE_BACKLOG_PENDING: 'ONLINE_BACKLOG_PENDING',
  ONLINE_HEALTHY: 'ONLINE_HEALTHY',
};

const UNIFIED_SYNC_STATES = {
  [HEALTH_STATE.OFFLINE_NO_NETWORK]: {
    label: 'Offline',
    description: 'No network connection. Changes are saved and will sync when online.',
    severity: 'critical',
    icon: 'wifi-off',
    canRetry: false,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_BACKEND_DEGRADED]: {
    label: 'Service issue',
    description: 'Connected to network, but the sync service is temporarily unavailable.',
    severity: 'warning',
    icon: 'cloud-alert',
    canRetry: true,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_BACKLOG_PENDING]: {
    label: 'Syncing backlog',
    description: 'Connection restored. Pending updates are still being processed.',
    severity: 'info',
    icon: 'clock-sync',
    canRetry: true,
    showLastSync: true,
  },
  [HEALTH_STATE.ONLINE_HEALTHY]: {
    label: 'Up to date',
    description: 'Everything is synced and working normally.',
    severity: 'success',
    icon: 'cloud-check',
    canRetry: false,
    showLastSync: true,
  },
};

const unifiedSyncContract = {
  HEALTH_STATE,
  UNIFIED_SYNC_STATES,
};

export { HEALTH_STATE, UNIFIED_SYNC_STATES };
export default unifiedSyncContract;
