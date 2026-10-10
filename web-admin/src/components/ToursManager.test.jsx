import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import ToursManager from './ToursManager';

const mockRef = vi.fn((_db, path) => ({ path }));
const mockOnValue = vi.fn();

vi.mock('../firebase', () => ({
  db: {},
}));

vi.mock('firebase/database', () => ({
  ref: (...args) => mockRef(...args),
  get: async (dbRef) => {
    const tourId = dbRef.path?.startsWith('tours/') ? dbRef.path.slice('tours/'.length) : '';
    const value = currentToursFixture?.[tourId];
    return { exists: () => value !== undefined, val: () => value };
  },
  onValue: (...args) => mockOnValue(...args),
  orderByChild: (path) => ({ type: 'orderByChild', path }),
  orderByKey: () => ({ type: 'orderByKey' }),
  startAt: (value) => ({ type: 'startAt', value }),
  endAt: (value) => ({ type: 'endAt', value }),
  equalTo: (value) => ({ type: 'equalTo', value }),
  limitToFirst: (limit) => ({ type: 'limitToFirst', limit }),
  limitToLast: (limit) => ({ type: 'limitToLast', limit }),
  query: (dbRef, ...constraints) => ({ ...dbRef, constraints }),
}));

vi.mock('../services/tourService', () => ({
  DEFAULT_TOUR: {},
  TOUR_TEMPLATES: [],
  createTour: vi.fn(),
  createTourFromTemplate: vi.fn(),
  updateTour: vi.fn(),
  deleteTour: vi.fn(),
  assignDriver: vi.fn(),
  unassignDriver: vi.fn(),
  duplicateTour: vi.fn(),
  exportToursToCSV: vi.fn(),
  previewTourCSVImport: vi.fn(),
  executeTourCSVImport: vi.fn(),
  ddmmyyyyToInputFormat: vi.fn((value) => value),
  inputFormatToDDMMYYYY: vi.fn((value) => value),
}));

const buildTours = () => {
  const tours = {};
  for (let i = 1; i <= 13; i += 1) {
    tours[`TOUR_${i}`] = {
      name: `Tour ${i}`,
      tourCode: `TC-${i}`,
      days: 1,
      startDate: '01/01/2099',
      endDate: '02/01/2099',
      isActive: i % 2 === 0,
      driverName: i % 3 === 0 ? `Driver ${i}` : 'TBA',
      currentParticipants: i,
      maxParticipants: 53,
    };
  }
  return tours;
};

const toursFixture = buildTours();
const driversFixture = { D1: { name: 'Driver One' } };
let currentToursFixture = toursFixture;
let currentPackStatusFixture = {};

function LocationSearchProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderAt(search = '') {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[`/tours${search}`]}>
        <Routes>
          <Route
            path="/tours"
            element={(
              <>
                <LocationSearchProbe />
                <ToursManager />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    </MantineProvider>
  );
}

async function changeStatus(container, label) {
  const statusInput =
    container.querySelector('input[placeholder="Filter by status"]')
    || container.querySelector('input.mantine-Select-input');

  fireEvent.mouseDown(statusInput);
  const options = await screen.findAllByRole('option', { name: label, hidden: true });
  fireEvent.click(options[0]);
}

async function changeDateScope(container, label) {
  const dateScopeInput = container.querySelector('input[placeholder="Filter by date"]');

  fireEvent.mouseDown(dateScopeInput);
  const options = await screen.findAllByRole('option', { name: label, hidden: true });
  fireEvent.click(options[0]);
}

beforeEach(() => {
  mockRef.mockClear();
  mockOnValue.mockClear();
  currentToursFixture = toursFixture;
  currentPackStatusFixture = {};
  mockOnValue.mockImplementation((dbRef, callback) => {
    const value = dbRef.path === 'tours'
      ? currentToursFixture
      : dbRef.path === 'drivers' ? driversFixture
        : dbRef.path === 'driver_tour_pack_admin_status' ? currentPackStatusFixture : {};
    callback({ val: () => value, size: Object.keys(value).length });
    return vi.fn();
  });
});

afterEach(() => vi.restoreAllMocks());

describe('ToursManager query-param status behavior', () => {
  it('shows imported bookings in grid, totals, details and table when runtime participants is zero', async () => {
    currentToursFixture = { IMPORTED: {
      ...toursFixture.TOUR_1, name: 'Imported Tour', sold: 32, bookedPassengerCount: 30,
      manifestPassengerCount: 30, currentParticipants: 0,
    } };
    renderAt();
    expect(await screen.findByText('32 / 53 booked places')).toBeInTheDocument();
    expect(screen.getByText('Passenger report lists 30; check the difference')).toBeInTheDocument();
    expect(screen.getByText('Booked places in view')).toBeInTheDocument();
    expect(screen.getByText('32')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Details', exact: true }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('32 / 53 booked places');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('table')).toHaveTextContent('32 / 53 booked places');
  }, 15000);
  it('does not claim an empty date window means the database has no tours', async () => {
    currentToursFixture = {};
    renderAt();
    expect(await screen.findByText('No tours found in this date view matching your criteria.')).toBeInTheDocument();
    expect(screen.queryByText('Create First Tour')).not.toBeInTheDocument();
  });

  it('reports query failure instead of presenting an empty database', async () => {
    const normalSubscribe = mockOnValue.getMockImplementation();
    mockOnValue.mockImplementation((dbRef, callback, onError) => {
      if (dbRef.path === 'tours') {
        onError(new Error('permission denied'));
        return vi.fn();
      }
      return normalSubscribe(dbRef, callback, onError);
    });
    renderAt();
    expect(await screen.findByText('Tours could not be loaded. Check your connection and refresh the page.')).toBeInTheDocument();
    expect(screen.queryByText('Create First Tour')).not.toBeInTheDocument();
  });

  it('moves the query to the new UK day when an open page regains focus', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 8, 22, 59));
    renderAt();
    await screen.findByText('Tour 1');
    const lastTourQuery = () => mockOnValue.mock.calls.filter(([reference]) => reference.path === 'tours').at(-1)[0];
    expect(lastTourQuery().constraints).toContainEqual({ type: 'startAt', value: Date.UTC(2026, 9, 8) });
    now.mockReturnValue(Date.UTC(2026, 9, 8, 23, 1));
    fireEvent.focus(window);
    await waitFor(() => expect(lastTourQuery().constraints)
      .toContainEqual({ type: 'startAt', value: Date.UTC(2026, 9, 9) }));
  });
  const asyncAssertionTimeoutMs = 15000;
  it('hydrates Select and filtered list from ?status=unassigned', async () => {
    renderAt('?status=unassigned');

    await screen.findByText('Showing 9 of 9 tours', {}, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByTestId('location-search')).toHaveTextContent('?status=unassigned');
    expect(screen.getByText('Unassigned (TBA)')).toBeInTheDocument();
    expect(screen.queryByText('Tour 3')).not.toBeInTheDocument();
    expect(screen.getByText('Tour 1')).toBeInTheDocument();
  }, 15000);

  it('changing status updates URL and resets pagination to page 1', async () => {
    const { container } = renderAt('?status=all');

    await screen.findByText('Showing 12 of 13 tours', {}, { timeout: asyncAssertionTimeoutMs });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await screen.findByText('Showing 1 of 13 tours', {}, { timeout: asyncAssertionTimeoutMs });

    await changeStatus(container, 'Assigned');

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?status=assigned');
    }, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByText('Showing 4 of 4 tours')).toBeInTheDocument();
  }, 15000);

  it('preserves unrelated query params while updating status', async () => {
    const { container } = renderAt('?foo=bar&status=active');

    await screen.findByText('Showing 6 of 6 tours', {}, { timeout: asyncAssertionTimeoutMs });

    await changeStatus(container, 'Inactive');

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?foo=bar&status=inactive');
    }, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByText('Showing 7 of 7 tours')).toBeInTheDocument();
  }, 15000);

  it('falls back safely for invalid status values', async () => {
    renderAt('?status=bogus');

    await screen.findByText('Showing 12 of 13 tours', {}, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByTestId('location-search')).toHaveTextContent('?status=bogus');
    expect(screen.getByText('All Tours')).toBeInTheDocument();
  }, 15000);

  it('hydrates search from ?q= and keeps deep links from the dashboard useful', async () => {
    renderAt('?q=TC-13');

    await screen.findByText('Showing 1 of 1 tours', {}, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByTestId('location-search')).toHaveTextContent('?q=TC-13');
    expect(screen.getByDisplayValue('TC-13')).toBeInTheDocument();
    expect(screen.getByText('Tour 13')).toBeInTheDocument();
  }, 15000);

  it('writes search changes back to q while preserving status', async () => {
    renderAt('?status=unassigned');

    await screen.findByText('Showing 9 of 9 tours', {}, { timeout: asyncAssertionTimeoutMs });
    fireEvent.change(screen.getByPlaceholderText('Search tours, codes, drivers...'), {
      target: { value: 'TC-13' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?status=unassigned&q=TC-13');
    }, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByText('Showing 1 of 1 tours')).toBeInTheDocument();
  }, 15000);

  it('shows exact departure pack readiness, revision and publication time beside the tour', async () => {
    currentPackStatusFixture = {
      '2099-01-01::TOUR_1': {
        schemaVersion: 1,
        departureKey: '2099-01-01::TOUR_1',
        tourId: 'TOUR_1',
        tourCode: 'TC-1',
        dateISO: '2099-01-01',
        status: 'active',
        qualityState: 'complete',
        revision: 5,
        publishedAtMs: 4_071_004_800_000,
        expiresAtMs: 4_071_091_200_000,
        sourceSnapshotDate: '2098-12-31',
        runId: 'run_1',
      },
    };
    renderAt('?q=Tour%201');
    expect(await screen.findByText('Pack ready', {}, { timeout: asyncAssertionTimeoutMs })).toBeInTheDocument();
    expect(screen.getByText(/Rev 5/)).toBeInTheDocument();
  }, 15000);

  it('filters finished tours out by default', async () => {
    currentToursFixture = {
      FUTURE_TOUR: {
        name: 'Future Tour',
        tourCode: 'FUTURE-1',
        days: 1,
        startDate: '01/01/2099',
        endDate: '02/01/2099',
        isActive: true,
        driverName: 'TBA',
        currentParticipants: 1,
        maxParticipants: 53,
      },
      PAST_TOUR: {
        name: 'Past Tour',
        tourCode: 'PAST-1',
        days: 1,
        startDate: '01/01/2020',
        endDate: '02/01/2020',
        isActive: false,
        driverName: 'TBA',
        currentParticipants: 1,
        maxParticipants: 53,
      },
    };

    renderAt();

    await screen.findByText('Showing 1 of 1 tours', {}, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByText('Future Tour')).toBeInTheDocument();
    expect(screen.queryByText('Past Tour')).not.toBeInTheDocument();
    expect(screen.getByText('Current & upcoming')).toBeInTheDocument();
  }, 15000);

  it('allows finished tours to be filtered back in', async () => {
    currentToursFixture = {
      FUTURE_TOUR: {
        name: 'Future Tour',
        tourCode: 'FUTURE-1',
        days: 1,
        startDate: '01/01/2099',
        endDate: '02/01/2099',
        isActive: true,
        driverName: 'TBA',
        currentParticipants: 1,
        maxParticipants: 53,
      },
      PAST_TOUR: {
        name: 'Past Tour',
        tourCode: 'PAST-1',
        days: 1,
        startDate: '01/01/2020',
        endDate: '02/01/2020',
        isActive: false,
        driverName: 'TBA',
        currentParticipants: 1,
        maxParticipants: 53,
      },
    };

    const { container } = renderAt();

    await screen.findByText('Showing 1 of 1 tours', {}, { timeout: asyncAssertionTimeoutMs });

    await changeDateScope(container, 'All dates');

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?dateScope=all');
    }, { timeout: asyncAssertionTimeoutMs });
    expect(screen.getByText('Showing 2 of 2 tours')).toBeInTheDocument();
    expect(screen.getByText('Past Tour')).toBeInTheDocument();
  }, 15000);
});
