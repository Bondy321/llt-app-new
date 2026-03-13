import { describe, expect, it } from 'vitest';
import unifiedSyncContract from './unifiedSyncContract';
import { HEALTH_STATE, buildHealthSnapshot } from './healthService';

const { HEALTH_STATE: CONTRACT_STATE, UNIFIED_SYNC_STATES } = unifiedSyncContract;

describe('healthService unified sync contract parity', () => {
  it('reuses canonical shared health-state keys', () => {
    expect(HEALTH_STATE).toEqual(CONTRACT_STATE);
  });

  it('buildHealthSnapshot returns metadata from shared contract', () => {
    const snapshot = buildHealthSnapshot({
      isOnline: true,
      listenerConnected: true,
      listenerErrorCount: 1,
    });

    expect(snapshot.state).toBe(CONTRACT_STATE.ONLINE_BACKEND_DEGRADED);
    expect(snapshot.label).toBe(UNIFIED_SYNC_STATES[CONTRACT_STATE.ONLINE_BACKEND_DEGRADED].label);
    expect(snapshot.description).toBe(UNIFIED_SYNC_STATES[CONTRACT_STATE.ONLINE_BACKEND_DEGRADED].description);
    expect(snapshot.icon).toBe(UNIFIED_SYNC_STATES[CONTRACT_STATE.ONLINE_BACKEND_DEGRADED].icon);
    expect(snapshot.showLastSync).toBe(true);
  });
});
