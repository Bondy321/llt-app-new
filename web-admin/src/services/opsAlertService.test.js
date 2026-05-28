import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  ref: vi.fn((_database, path) => ({ path })),
  query: vi.fn((baseRef, ...constraints) => ({ baseRef, constraints })),
  orderByChild: vi.fn((field) => ({ type: 'orderByChild', field })),
  limitToLast: vi.fn((limit) => ({ type: 'limitToLast', limit })),
  onValue: vi.fn(),
  update: vi.fn(),
}));

vi.mock('firebase/database', () => firebaseMocks);

import {
  acknowledgeOpsAlert,
  buildOpsAlertStats,
  filterOpsAlerts,
  formatAffectedDevice,
  formatAffectedSession,
  normalizeOpsAlert,
  resolveOpsAlert,
  subscribeToOpsAlerts,
} from './opsAlertService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('opsAlertService', () => {
  it('subscribes to a bounded lastSeenAtMs query and normalizes newest-first alerts', () => {
    const unsubscribe = vi.fn();
    firebaseMocks.onValue.mockImplementation((_queryRef, onNext) => {
      onNext({
        val: () => ({
          older: {
            fingerprint: 'older',
            createdAtMs: 100,
            lastSeenAtMs: 100,
            severity: 'error',
            level: 'ERROR',
            source: 'mobile_logger',
            component: 'LoginScreen',
            message: 'older',
            status: 'open',
            userKey: 'us***01',
            sessionKey: 'se***01',
            deviceInfo: { platform: 'ios', version: '18', model: 'iPhone' },
            summary: 'older summary',
            count: 1,
          },
          newer: {
            fingerprint: 'newer',
            createdAtMs: 200,
            lastSeenAtMs: 300,
            severity: 'critical',
            level: 'FATAL',
            source: 'crash_diagnostics',
            component: 'GlobalError',
            message: 'newer jane@example.com',
            status: 'acknowledged',
            userKey: 'us***02',
            sessionKey: 'se***02',
            deviceInfo: { platform: 'android', version: '15', model: 'Pixel' },
            summary: 'newer summary',
            count: 2,
          },
        }),
      });
      return unsubscribe;
    });

    const onNext = vi.fn();
    const result = subscribeToOpsAlerts({}, { limit: 25 }, onNext, vi.fn());

    expect(result).toBe(unsubscribe);
    expect(firebaseMocks.ref).toHaveBeenCalledWith({}, 'ops_alerts');
    expect(firebaseMocks.orderByChild).toHaveBeenCalledWith('lastSeenAtMs');
    expect(firebaseMocks.limitToLast).toHaveBeenCalledWith(25);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext.mock.calls[0][0].map((alert) => alert.id)).toEqual(['newer', 'older']);
    expect(onNext.mock.calls[0][0][0].message).not.toContain('jane@example.com');
  });

  it('builds active critical stats and component groupings', () => {
    const alerts = [
      normalizeOpsAlert('a', {
        severity: 'critical',
        status: 'open',
        component: 'GlobalError',
        createdAtMs: 1,
        lastSeenAtMs: 2,
        deviceInfo: { platform: 'ios', version: '18', model: 'iPhone' },
      }),
      normalizeOpsAlert('b', {
        severity: 'error',
        status: 'acknowledged',
        component: 'TourHome',
        createdAtMs: 1,
        lastSeenAtMs: 3,
        deviceInfo: { platform: 'android', version: '15', model: 'Pixel' },
      }),
      normalizeOpsAlert('c', {
        severity: 'critical',
        status: 'resolved',
        component: 'GlobalError',
        createdAtMs: 1,
        lastSeenAtMs: 4,
        deviceInfo: { platform: 'ios', version: '18', model: 'iPhone' },
      }),
    ];

    const stats = buildOpsAlertStats(alerts);

    expect(stats.totalCount).toBe(3);
    expect(stats.activeCount).toBe(2);
    expect(stats.openCriticalCount).toBe(1);
    expect(stats.openErrorCount).toBe(1);
    expect(stats.byComponent).toEqual({ GlobalError: 1, TourHome: 1 });
    expect(stats.mostSevereActiveAlert.id).toBe('a');
    expect(filterOpsAlerts(alerts, { status: 'active', severity: 'all' }).map((alert) => alert.id)).toEqual(['a', 'b']);
  });

  it('writes sanitized admin status updates for acknowledge and resolve actions', async () => {
    firebaseMocks.update.mockResolvedValue(undefined);

    await acknowledgeOpsAlert({}, 'opa_alert_1');
    await resolveOpsAlert({}, 'opa_alert_2');

    expect(firebaseMocks.ref).toHaveBeenCalledWith({}, 'ops_alerts/opa_alert_1');
    expect(firebaseMocks.ref).toHaveBeenCalledWith({}, 'ops_alerts/opa_alert_2');
    expect(firebaseMocks.update.mock.calls[0][1]).toMatchObject({
      status: 'acknowledged',
      statusUpdatedBy: 'admin',
    });
    expect(firebaseMocks.update.mock.calls[1][1]).toMatchObject({
      status: 'resolved',
      statusUpdatedBy: 'admin',
    });
    expect(firebaseMocks.update.mock.calls[0][1].statusUpdatedBy).not.toContain('@');
  });

  it('formats affected device and session without raw secret-like values', () => {
    const alert = normalizeOpsAlert('a', {
      userKey: 'userId=ABCDEFGHIJKLMNOPQRSTUVWX',
      sessionKey: 'session_1779960000_secret',
      role: 'driver',
      tourId: '5112D_8',
      deviceInfo: {
        platform: 'ios',
        version: '18',
        model: 'iPhone',
        appVersion: '1.0.2',
      },
    });

    expect(formatAffectedDevice(alert)).toBe('ios / iPhone / app 1.0.2');
    expect(formatAffectedSession(alert)).toContain('driver');
    expect(formatAffectedSession(alert)).toContain('tour 5112D_8');
    expect(formatAffectedSession(alert)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(formatAffectedSession(alert)).not.toContain('session_1779960000_secret');
  });
});
