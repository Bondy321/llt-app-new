import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ToursManager from '../ToursManager';

let mockTours = {};
let mockDrivers = {};

vi.mock('../../firebase', () => ({
  db: {},
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((_, path) => path),
  onValue: vi.fn((path, callback) => {
    if (path === 'tours') {
      callback({ val: () => mockTours });
    }

    if (path === 'drivers') {
      callback({ val: () => mockDrivers });
    }

    return vi.fn();
  }),
}));

const renderToursManager = (initialUrl = '/') => {
  window.history.pushState({}, '', initialUrl);

  return render(
    <MantineProvider>
      <BrowserRouter>
        <ToursManager />
      </BrowserRouter>
    </MantineProvider>
  );
};

describe('ToursManager status query integration', () => {
  afterEach(() => {
    mockTours = {};
    mockDrivers = {};
  });

  test('initializes filter from ?status=unassigned and only shows unassigned tours', async () => {
    mockTours = {
      TOUR_A: { name: 'Assigned Tour', driverName: 'Jane Driver', isActive: true },
      TOUR_B: { name: 'Unassigned TBA Tour', driverName: 'TBA', isActive: true },
      TOUR_C: { name: 'Unassigned Missing Driver Tour', isActive: false },
    };

    renderToursManager('/?status=unassigned');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tours Management' })).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText('Filter by status')).toHaveValue('Unassigned (TBA)');
    expect(screen.getByText('Unassigned TBA Tour')).toBeInTheDocument();
    expect(screen.getByText('Unassigned Missing Driver Tour')).toBeInTheDocument();
    expect(screen.queryByText('Assigned Tour')).not.toBeInTheDocument();
  });

  test('falls back safely when status query is invalid', async () => {
    mockTours = {
      TOUR_A: { name: 'Assigned Tour', driverName: 'Jane Driver', isActive: true },
      TOUR_B: { name: 'Unassigned Tour', driverName: 'TBA', isActive: false },
    };

    renderToursManager('/?status=not-real');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tours Management' })).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText('Filter by status')).toHaveValue('All Tours');
    expect(screen.getByText('Assigned Tour')).toBeInTheDocument();
    expect(screen.getByText('Unassigned Tour')).toBeInTheDocument();
  });

  test.skip('updates URL when user changes status filter (enable after two-way sync task lands)', async () => {
    mockTours = {
      TOUR_A: { name: 'Assigned Tour', driverName: 'Jane Driver', isActive: true },
      TOUR_B: { name: 'Unassigned Tour', driverName: 'TBA', isActive: false },
    };

    const user = userEvent.setup();
    renderToursManager('/?status=unassigned');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tours Management' })).toBeInTheDocument();
    });

    const statusSelect = screen.getByPlaceholderText('Filter by status');
    await user.click(statusSelect);
    await user.click(screen.getByRole('option', { name: 'Assigned' }));

    expect(window.location.search).toContain('status=assigned');
  });
});
