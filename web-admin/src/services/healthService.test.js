import { describe, expect, it } from 'vitest';
import {
  HEALTH_STATE,
  buildDashboardStatusChips,
  buildHealthSnapshot,
  deriveHealthState,
} from './healthService';

describe('healthService derivation', () => {
  it('returns OFFLINE_NO_NETWORK when browser offline', () => {
    const state = deriveHealthState({
      isOnline: false,
      listenerConnected: true,
      lastSuccessfulSyncAt: new Date().toISOString(),
    });

    expect(state).toBe(HEALTH_STATE.OFFLINE_NO_NETWORK);
  });

  it('returns ONLINE_BACKEND_DEGRADED when listener errors exist', () => {
    const state = deriveHealthState({
      isOnline: true,
      listenerConnected: true,
      listenerErrorCount: 1,
      pendingFailedOperations: 0,
      backlogPendingCount: 0,
      lastSuccessfulSyncAt: new Date().toISOString(),
    });

    expect(state).toBe(HEALTH_STATE.ONLINE_BACKEND_DEGRADED);
  });

  it('returns ONLINE_BACKLOG_PENDING when sync is stale', () => {
    const staleDate = new Date('2026-01-01T10:00:00.000Z').toISOString();
    const state = deriveHealthState(
      {
        isOnline: true,
        listenerConnected: true,
        listenerErrorCount: 0,
        pendingFailedOperations: 0,
        backlogPendingCount: 0,
        lastSuccessfulSyncAt: staleDate,
      },
      {
        now: Number(new Date('2026-01-01T10:10:00.000Z')),
        staleMs: 60 * 1000,
      },
    );

    expect(state).toBe(HEALTH_STATE.ONLINE_BACKLOG_PENDING);
  });

  it('returns ONLINE_HEALTHY when connected with fresh successful sync', () => {
    const state = deriveHealthState(
      {
        isOnline: true,
        listenerConnected: true,
        listenerErrorCount: 0,
        pendingFailedOperations: 0,
        backlogPendingCount: 0,
        lastSuccessfulSyncAt: '2026-01-01T10:00:30.000Z',
      },
      {
        now: Number(new Date('2026-01-01T10:01:00.000Z')),
        staleMs: 5 * 60 * 1000,
      },
    );

    expect(state).toBe(HEALTH_STATE.ONLINE_HEALTHY);
  });



  it('uses canonical sync contract metadata across all health states', () => {
    const offlineSnapshot = buildHealthSnapshot({
      isOnline: false,
      listenerConnected: true,
    });

    expect(offlineSnapshot.label).toBe('Offline');
    expect(offlineSnapshot.description).toBe('No network connection. Changes are saved and will sync when online.');
    expect(offlineSnapshot.severity).toBe('critical');
    expect(offlineSnapshot.icon).toBe('wifi-off');
    expect(offlineSnapshot.canRetry).toBe(false);
    expect(offlineSnapshot.showLastSync).toBe(true);

    const healthySnapshot = buildHealthSnapshot({
      isOnline: true,
      listenerConnected: true,
      listenerErrorCount: 0,
      pendingFailedOperations: 0,
      backlogPendingCount: 0,
      lastSuccessfulSyncAt: '2026-01-01T10:00:30.000Z',
    }, {
      now: Number(new Date('2026-01-01T10:01:00.000Z')),
      staleMs: 5 * 60 * 1000,
    });

    expect(healthySnapshot.severity).toBe('success');
    expect(healthySnapshot.icon).toBe('cloud-check');
    expect(healthySnapshot.canRetry).toBe(false);
    expect(healthySnapshot.color).toBe('green');
  });

  it('maps snapshots to dashboard status chips using canonical mobile state key', () => {
    const snapshot = buildHealthSnapshot({
      isOnline: true,
      listenerConnected: true,
      listenerErrorCount: 0,
      pendingFailedOperations: 2,
      backlogPendingCount: 0,
      lastSuccessfulSyncAt: new Date().toISOString(),
    });

    const chips = buildDashboardStatusChips(snapshot);

    expect(snapshot.state).toBe(HEALTH_STATE.ONLINE_BACKEND_DEGRADED);
    expect(chips.DATABASE_CONNECTION.mobileStateKey).toBe(HEALTH_STATE.ONLINE_BACKEND_DEGRADED);
    expect(chips.REALTIME_SYNC.label).toBe('Service issue');
    expect(chips.BROADCAST_SYSTEM.color).toBe('orange');
  });
});
