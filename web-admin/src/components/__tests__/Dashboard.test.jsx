import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockState, refMock, onValueMock } = vi.hoisted(() => {
  const mockState = { mockRealtimeData: {} };
  const refMock = vi.fn((_db, path) => ({ path }));
  const onValueMock = vi.fn((reference, callback) => {
    const value = mockState.mockRealtimeData[reference.path] ?? null;
    callback({ val: () => value });
    return vi.fn();
  });

  return { mockState, refMock, onValueMock };
});

vi.mock('firebase/database', () => ({
  ref: refMock,
  onValue: onValueMock,
}));

vi.mock('../../firebase', () => ({ db: {} }));

import Dashboard from '../Dashboard';

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

function formatUkDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysFromToday(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

function expectedUrgencyLabel(offsetFromToday) {
  const today = daysFromToday(0);
  const parsedDate = daysFromToday(offsetFromToday);
  parsedDate.setHours(12, 0, 0, 0);

  const dayDelta = Math.ceil((parsedDate - today) / (1000 * 60 * 60 * 24));

  if (dayDelta < 0) return `${Math.abs(dayDelta)}d overdue`;
  if (dayDelta === 0) return 'Today';
  return `In ${dayDelta}d`;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderDashboardWithRouter() {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="*"
            element={(
              <>
                <LocationProbe />
                <Dashboard />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    </MantineProvider>
  );
}

describe('Dashboard priority actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test('shows urgent count and urgency labels for mixed assigned/unassigned tours with mixed date formats', async () => {
    const overdueOffset = -2;
    const todayOffset = -1;
    const soonOffset = 1;
    const laterOffset = 4;

    mockState.mockRealtimeData = {
      drivers: {
        d1: { name: 'Driver 1', createdAt: '2026-01-02T10:00:00Z' },
      },
      tours: {
        overdue_unassigned: {
          name: 'Overdue unassigned tour',
          driverName: 'TBA',
          startDate: formatUkDate(daysFromToday(overdueOffset)),
          currentParticipants: 12,
        },
        today_unassigned: {
          name: 'Today unassigned tour',
          driverName: 'TBA',
          startDate: formatUkDate(daysFromToday(todayOffset)),
          currentParticipants: 22,
        },
        soon_unassigned: {
          name: 'Soon unassigned tour',
          startDate: formatUkDate(daysFromToday(soonOffset)),
          currentParticipants: 18,
        },
        later_unassigned: {
          name: 'Later unassigned tour',
          startDate: formatUkDate(daysFromToday(laterOffset)),
          currentParticipants: 5,
        },
        far_unassigned: {
          name: 'Far unassigned tour',
          startDate: formatIsoDate(daysFromToday(10)),
          currentParticipants: 9,
        },
        assigned_soon: {
          name: 'Assigned soon tour',
          driverName: 'Alex Driver',
          startDate: formatIsoDate(daysFromToday(1)),
          currentParticipants: 14,
        },
      },
    };

    renderDashboardWithRouter();

    expect(await screen.findByText('4 urgent')).not.toBeNull();
    expect(screen.getByText(expectedUrgencyLabel(overdueOffset))).not.toBeNull();
    expect(screen.getByText(expectedUrgencyLabel(todayOffset))).not.toBeNull();
    expect(screen.getByText(expectedUrgencyLabel(soonOffset))).not.toBeNull();
    expect(screen.getByText(expectedUrgencyLabel(laterOffset))).not.toBeNull();

    expect(refMock).toHaveBeenCalledWith(expect.anything(), 'drivers');
    expect(refMock).toHaveBeenCalledWith(expect.anything(), 'tours');
    expect(onValueMock).toHaveBeenCalledTimes(2);
  });

  test('navigates to unassigned tours review route', async () => {
    mockState.mockRealtimeData = {
      drivers: {},
      tours: {
        overdue_unassigned: {
          name: 'Overdue unassigned tour',
          driverName: 'TBA',
          startDate: formatUkDate(daysFromToday(-2)),
          currentParticipants: 20,
        },
      },
    };

    const user = userEvent.setup();
    renderDashboardWithRouter();

    await user.click(await screen.findByRole('button', { name: /Review unassigned tours/i }));

    expect(screen.getByTestId('location').textContent).toBe('/tours?status=unassigned');
  });

  test('shows empty-state message when there are no urgent unassigned tours', async () => {
    mockState.mockRealtimeData = {
      drivers: {
        d1: { name: 'Driver 1', createdAt: '2026-01-02T10:00:00Z' },
      },
      tours: {
        assigned_soon: {
          name: 'Assigned soon tour',
          driverName: 'Alex Driver',
          startDate: formatUkDate(daysFromToday(1)),
          currentParticipants: 11,
        },
        unassigned_far: {
          name: 'Unassigned far tour',
          driverName: 'TBA',
          startDate: formatIsoDate(daysFromToday(14)),
          currentParticipants: 7,
        },
      },
    };

    renderDashboardWithRouter();

    expect(await screen.findByText('No urgent items')).not.toBeNull();
    expect(
      screen.getByText('All tours starting within 7 days currently have drivers assigned.')
    ).not.toBeNull();
  });
});
