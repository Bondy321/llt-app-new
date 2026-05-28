import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/database', () => ({
  get: vi.fn(),
  onValue: vi.fn(),
  ref: vi.fn(),
  update: vi.fn(),
}));

import {
  buildBroadcastActivity,
  buildOperationsDashboardModel,
  buildSafetyAlerts,
  filterSafetyAlerts,
  sanitizeDashboardText,
} from './dashboardService';

describe('dashboardService operations model', () => {
  it('derives dispatch coverage and passenger load from real tour, driver, and manifest data', () => {
    const model = buildOperationsDashboardModel({
      drivers: {
        D1: { name: 'Alice', currentTourId: 'TOUR_ASSIGNED' },
        D2: { name: 'Bob' },
      },
      tours: {
        TOUR_ASSIGNED: {
          name: 'Assigned Tour',
          driverName: 'Alice',
          startDate: '29/05/2026',
          currentParticipants: 18,
          maxParticipants: 20,
          isActive: true,
        },
        TOUR_PARTICIPANTS: {
          name: 'Participant Count Fallback',
          driverName: 'TBA',
          startDate: '30/05/2026',
          participants: { u1: true, u2: true },
          maxParticipants: 10,
          isActive: true,
        },
        TOUR_MANIFEST: {
          name: 'Manifest Count Fallback',
          driverName: 'TBA',
          startDate: '31/05/2026',
          maxParticipants: 5,
          isActive: true,
        },
      },
      tourManifests: {
        TOUR_ASSIGNED: { assigned_drivers: { D1: true } },
        TOUR_MANIFEST: {
          bookings: {
            hiddenBookingRef: {
              passengerStatus: { 0: 'PENDING', 1: 'BOARDED' },
            },
          },
        },
      },
    }, {
      now: new Date(2026, 4, 28),
    });

    expect(model.metrics.totalDrivers).toBe(2);
    expect(model.metrics.assignedDrivers).toBe(1);
    expect(model.metrics.upcomingTours).toBe(3);
    expect(model.metrics.assignedUpcomingTours).toBe(1);
    expect(model.metrics.unassignedUpcomingTours).toBe(2);
    expect(model.metrics.totalPassengers).toBe(22);
    expect(model.metrics.totalKnownCapacity).toBe(35);
    expect(model.metrics.passengerLoadPercent).toBe(63);
    expect(model.highLoadTours.map((tour) => tour.id)).toEqual(['TOUR_ASSIGNED']);
    expect(model.tourRows.find((tour) => tour.id === 'TOUR_MANIFEST').passengerCountSource).toBe('tour_manifests.bookings');
  });

  it('deduplicates safety alerts and keeps sensitive identifiers out of summaries', () => {
    const alerts = buildSafetyAlerts({
      globalSafetyAlerts: {
        global1: {
          eventId: 'event-1',
          severity: 'critical',
          status: 'pending',
          isSOS: true,
          tourId: 'TOUR_1',
          role: 'passenger',
          timestamp: '2026-05-28T10:00:00.000Z',
          message: 'Need help bookingRef=ABC123 jane@example.com session_1779960000_secret',
        },
      },
      tours: {
        TOUR_1: {
          safetyAlerts: {
            tour1: {
              eventId: 'event-1',
              severity: 'critical',
              status: 'pending',
              timestamp: '2026-05-28T10:00:00.000Z',
              message: 'Need help bookingRef=ABC123 jane@example.com',
            },
          },
        },
      },
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].paths).toEqual(['globalSafetyAlerts/global1', 'tours/TOUR_1/safetyAlerts/tour1']);
    expect(alerts[0].message).not.toContain('jane@example.com');
    expect(alerts[0].message).not.toContain('ABC123');
    expect(alerts[0].message).not.toContain('session_1779960000_secret');
    expect(filterSafetyAlerts(alerts, 'attention')).toHaveLength(1);
  });

  it('summarizes broadcast activity without exposing author UIDs or raw tokens', () => {
    const activity = buildBroadcastActivity({
      TOUR_1: {
        b1: {
          message: 'Delay update token=super-secret-value',
          createdAtMs: 1779962400000,
          createdByUid: 'raw-auth-uid',
          source: 'web_admin',
        },
      },
    }, {
      nowMs: 1779966000000,
    });

    expect(activity.totalCount).toBe(1);
    expect(activity.last24hCount).toBe(1);
    expect(activity.recent[0].message).not.toContain('super-secret-value');
    expect(activity.recent[0]).not.toHaveProperty('createdByUid');
  });

  it('redacts common sensitive text patterns in dashboard summaries', () => {
    const text = sanitizeDashboardText('authUid=abcdefghijklmnopqrstuvwxyz bookingId=ABC123 ExponentPushToken[abc]');

    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('ABC123');
    expect(text).not.toContain('ExponentPushToken[abc]');
  });
});
