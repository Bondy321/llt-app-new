import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  onValue: (...args) => mockOnValue(...args),
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
      startDate: '01/01/2026',
      endDate: '02/01/2026',
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

beforeEach(() => {
  mockRef.mockClear();
  mockOnValue.mockImplementation((dbRef, callback) => {
    const value = dbRef.path === 'tours' ? toursFixture : driversFixture;
    callback({ val: () => value });
    return vi.fn();
  });
});

describe('ToursManager query-param status behavior', () => {
  it('hydrates Select and filtered list from ?status=unassigned', async () => {
    renderAt('?status=unassigned');

    await screen.findByText('Showing 9 of 9 tours');
    expect(screen.getByTestId('location-search')).toHaveTextContent('?status=unassigned');
    expect(screen.getByText('Unassigned (TBA)')).toBeInTheDocument();
    expect(screen.queryByText('Tour 3')).not.toBeInTheDocument();
    expect(screen.getByText('Tour 1')).toBeInTheDocument();
  });

  it('changing status updates URL and resets pagination to page 1', async () => {
    const { container } = renderAt('?status=all');

    await screen.findByText('Showing 12 of 13 tours');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await screen.findByText('Showing 1 of 13 tours');

    await changeStatus(container, 'Assigned');

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?status=assigned');
    });
    expect(screen.getByText('Showing 4 of 4 tours')).toBeInTheDocument();
  });

  it('preserves unrelated query params while updating status', async () => {
    const { container } = renderAt('?foo=bar&status=active');

    await screen.findByText('Showing 6 of 6 tours');

    await changeStatus(container, 'Inactive');

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('?foo=bar&status=inactive');
    });
    expect(screen.getByText('Showing 7 of 7 tours')).toBeInTheDocument();
  });

  it('falls back safely for invalid status values', async () => {
    renderAt('?status=bogus');

    await screen.findByText('Showing 12 of 13 tours');
    expect(screen.getByTestId('location-search')).toHaveTextContent('?status=bogus');
    expect(screen.getByText('All Tours')).toBeInTheDocument();
  });
});
