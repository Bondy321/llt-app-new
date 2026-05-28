import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';

const databaseMocks = vi.hoisted(() => ({
  ref: vi.fn((_db, path) => ({ path })),
  onValue: vi.fn(),
  query: vi.fn((baseRef, ...constraints) => ({ baseRef, constraints })),
  orderByChild: vi.fn((field) => ({ type: 'orderByChild', field })),
  limitToLast: vi.fn((limit) => ({ type: 'limitToLast', limit })),
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
  limitToLast: (...args) => databaseMocks.limitToLast(...args),
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

const renderDashboard = () => render(
  <MantineProvider>
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  </MantineProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  databaseMocks.onValue.mockImplementation((dbRef, callback) => {
    if (dbRef.path === 'drivers') {
      callback({ val: () => ({ D1: { name: 'Driver One', currentTourId: 'TOUR_1', createdAt: '2026-05-28T10:00:00.000Z' } }) });
    }

    if (dbRef.path === 'tours') {
      callback({ val: () => ({ TOUR_1: { name: 'Tour One', driverName: 'Driver One', currentParticipants: 12, startDate: '28/05/2026' } }) });
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
    expect(screen.getByText('Fatal mobile crash [email]')).toBeInTheDocument();
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
  });
});
