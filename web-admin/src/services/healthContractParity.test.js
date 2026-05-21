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

  it('maps every contract state to its shared metadata without drift', () => {
    const scenariosByState = {
      [CONTRACT_STATE.OFFLINE_NO_NETWORK]: {
        isOnline: false,
        listenerConnected: false,
      },
      [CONTRACT_STATE.ONLINE_BACKEND_DEGRADED]: {
        isOnline: true,
        listenerConnected: true,
        listenerErrorCount: 1,
      },
      [CONTRACT_STATE.ONLINE_BACKLOG_PENDING]: {
        isOnline: true,
        listenerConnected: true,
        backlogPendingCount: 1,
      },
      [CONTRACT_STATE.ONLINE_HEALTHY]: {
        isOnline: true,
        listenerConnected: true,
        lastSuccessfulSyncAt: '2026-04-08T00:00:00.000Z',
      },
    };

    Object.entries(scenariosByState).forEach(([state, signals]) => {
      const snapshot = buildHealthSnapshot(signals, {
        now: Date.parse('2026-04-08T00:00:30.000Z'),
      });
      const expectedMeta = UNIFIED_SYNC_STATES[state];

      expect(snapshot.state).toBe(state);
      expect(snapshot.label).toBe(expectedMeta.label);
      expect(snapshot.description).toBe(expectedMeta.description);
      expect(snapshot.severity).toBe(expectedMeta.severity);
      expect(snapshot.icon).toBe(expectedMeta.icon);
      expect(snapshot.canRetry).toBe(expectedMeta.canRetry);
      expect(snapshot.showLastSync).toBe(expectedMeta.showLastSync);
    });
  });
});
