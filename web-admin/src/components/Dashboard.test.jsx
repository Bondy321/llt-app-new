import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';

const databaseMocks = vi.hoisted(() => ({
  ref: vi.fn((_db, path) => ({ path })),
  onValue: vi.fn(),
  query: vi.fn((baseRef, ...constraints) => ({ baseRef, constraints })),
  orderByChild: vi.fn((field) => ({ type: 'orderByChild', field })),
  startAt: vi.fn((value) => ({ type: 'startAt', value })),
  endAt: vi.fn((value) => ({ type: 'endAt', value })),
  limitToFirst: vi.fn((limit) => ({ type: 'limitToFirst', limit })),
  limitToLast: vi.fn((limit) => ({ type: 'limitToLast', limit })),
  get: vi.fn(),
  update: vi.fn(),
}));

const opsMocks = vi.hoisted(() => ({
  subscribeToOpsAlerts: vi.fn(),
  acknowledgeOpsAlert: vi.fn(),
  resolveOpsAlert: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
}));

vi.mock('firebase/database', () => ({
  ref: (...args) => databaseMocks.ref(...args),
  onValue: (...args) => databaseMocks.onValue(...args),
  query: (...args) => databaseMocks.query(...args),
  orderByChild: (...args) => databaseMocks.orderByChild(...args),
  startAt: (...args) => databaseMocks.startAt(...args),
  endAt: (...args) => databaseMocks.endAt(...args),
  limitToFirst: (...args) => databaseMocks.limitToFirst(...args),
  limitToLast: (...args) => databaseMocks.limitToLast(...args),
  get: (...args) => databaseMocks.get(...args),
  update: (...args) => databaseMocks.update(...args),
}));

vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}));

vi.mock('../services/opsAlertService', async () => {
  const actual = await vi.importActual('../services/opsAlertService');
  return {
    ...actual,
    subscribeToOpsAlerts: (...args) => opsMocks.subscribeToOpsAlerts(...args),
    acknowledgeOpsAlert: (...args) => opsMocks.acknowledgeOpsAlert(...args),
    resolveOpsAlert: (...args) => opsMocks.resolveOpsAlert(...args),
  };
});

import Dashboard from './Dashboard';

let rolloutPhase = 'legacy';
const pathOf = (source) => source.path || source.baseRef?.path;

const renderDashboard = () => render(
  <MantineProvider>
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  </MantineProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  rolloutPhase = 'legacy';
  databaseMocks.onValue.mockImplementation((dbRef, callback) => {
    const path = pathOf(dbRef);
    if (path === 'admin_dashboard_rollout/v1') {
      callback({ val: () => ({ schemaVersion: 1, phase: rolloutPhase }) });
    }

    if (path === 'drivers') {
      callback({ val: () => ({ D1: { name: 'Driver One', currentTourId: 'TOUR_1', createdAt: '2026-05-28T10:00:00.000Z' } }) });
    }

    if (path === 'tours') {
      callback({ val: () => ({ TOUR_1: { name: 'Tour One', driverName: 'Driver One', currentParticipants: 12, startDate: '01/09/2026' } }) });
    }

    if (['tour_manifests', 'globalSafetyAlerts', 'broadcasts'].includes(path)) {
      callback({ val: () => ({}) });
    }

    if (path === 'admin_dashboard/v1/tours') {
      callback({ val: () => ({ TOUR_1: { displayName: 'Projected Tour', passengerCount: 12, startAtMs: 1780000000000 } }), size: 1 });
    }

    if (['admin_dashboard/v1/safety_attention', 'admin_dashboard/v1/recent_broadcasts'].includes(path)) {
      callback({ val: () => ({}), size: 0 });
    }

    if (path === 'admin_dashboard/v1/summary') {
      callback({ val: () => ({ totalDrivers: 1, totalTours: 1, activeTours: 1, totalPassengers: 999 }) });
    }

    return vi.fn();
  });

  opsMocks.subscribeToOpsAlerts.mockImplementation((_database, _options, onNext) => {
    onNext([
      {
        id: 'opa_alert_1',
        fingerprint: 'opa_alert_1',
        createdAtMs: 1779960000000,
        lastSeenAtMs: 1779960300000,
        severity: 'critical',
        level: 'FATAL',
        source: 'crash_diagnostics',
        component: 'GlobalError',
        message: 'Fatal mobile crash [email]',
        status: 'open',
        userKey: 'us***99',
        sessionKey: 'se***ab',
        deviceInfo: {
          platform: 'ios',
          version: '18',
          model: 'iPhone',
          appVersion: '1.0.2',
        },
        role: 'passenger',
        tourId: '5112D_8',
        summary: 'global_error | breadcrumbs: 2',
        crashBreadcrumbSummary: {
          count: 2,
          latest: 'TourHome:refresh_started | GlobalError:unhandled_exception',
        },
        count: 3,
      },
    ]);
    return vi.fn();
  });
});

describe('Dashboard ops alerts panel', () => {
  it('renders live curated device/app errors without raw log scanning', async () => {
    renderDashboard();

    expect(await screen.findByText('Operations / Health / Errors')).toBeInTheDocument();
    expect(screen.getAllByText('Fatal mobile crash [email]').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GlobalError').length).toBeGreaterThan(0);
    expect(screen.getByText('ios / iPhone / app 1.0.2')).toBeInTheDocument();
    expect(screen.getByText(/Seen 3x/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 critical/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/jane@example\.com/)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(opsMocks.subscribeToOpsAlerts).toHaveBeenCalledWith(
        {},
        { orderBy: 'lastSeenAtMs', limit: 80 },
        expect.any(Function),
        expect.any(Function),
      );
    });

    const listenedPaths = databaseMocks.onValue.mock.calls.map(([source]) => pathOf(source));
    expect(listenedPaths).toEqual(expect.arrayContaining([
      'drivers',
      'tours',
      'tour_manifests',
      'globalSafetyAlerts',
      'broadcasts',
    ]));
    expect(listenedPaths).not.toContain('admin_dashboard/v1/tours');
  });

  it('projection phase attaches only bounded projection data listeners', async () => {
    rolloutPhase = 'projection';
    renderDashboard();

    expect(await screen.findByText('Operations / Health / Errors')).toBeInTheDocument();
    const listenedPaths = databaseMocks.onValue.mock.calls.map(([source]) => pathOf(source));
    expect(listenedPaths).toEqual(expect.arrayContaining([
      'admin_dashboard/v1/tours',
      'admin_dashboard/v1/safety_attention',
      'admin_dashboard/v1/recent_broadcasts',
      'admin_dashboard/v1/summary',
    ]));
    expect(listenedPaths).not.toEqual(expect.arrayContaining([
      'drivers',
      'tours',
      'tour_manifests',
      'globalSafetyAlerts',
      'broadcasts',
    ]));
    expect(databaseMocks.limitToFirst).toHaveBeenCalledWith(500);
    expect(databaseMocks.limitToLast).toHaveBeenCalledWith(80);
    expect(databaseMocks.limitToLast).toHaveBeenCalledWith(40);
  });

  it('shadow phase keeps the legacy render while subscribing to bounded projections', async () => {
    rolloutPhase = 'shadow';
    renderDashboard();

    expect(await screen.findByText('Operations / Health / Errors')).toBeInTheDocument();
    const listenedPaths = databaseMocks.onValue.mock.calls.map(([source]) => pathOf(source));
    expect(listenedPaths).toEqual(expect.arrayContaining([
      'drivers',
      'tours',
      'tour_manifests',
      'globalSafetyAlerts',
      'broadcasts',
      'admin_dashboard/v1/tours',
      'admin_dashboard/v1/safety_attention',
      'admin_dashboard/v1/recent_broadcasts',
      'admin_dashboard/v1/summary',
    ]));
    expect(screen.getByText('12 passengers / 0 known seats')).toBeInTheDocument();
    expect(screen.queryByText('999 passengers / 0 known seats')).not.toBeInTheDocument();
  });
});
