import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('../services/tourService', () => ({ applyDriverAssignmentMutation: vi.fn() }));
vi.mock('../services/driverService', () => ({
  createDriver: vi.fn(),
  updateDriverContactProjection: vi.fn(),
}));
vi.mock('../services/appSessionAdminService', () => ({
  APP_SESSION_REVOCATION_REASONS: [],
  maskAppSessionId: vi.fn(),
  revokeAppSession: vi.fn(),
  subscribeToAppSession: vi.fn(),
}));

import { CreateDriverModal } from '../features/drivers/components/driverManagementPanels';

describe('Driver management modal', () => {
  it('renders the add-driver action without a missing icon runtime error', () => {
    render(
      <MantineProvider>
        <CreateDriverModal opened onClose={vi.fn()} onSuccess={vi.fn()} />
      </MantineProvider>,
    );

    expect(screen.getByText('Add New Driver')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Driver' })).toBeInTheDocument();
  });
});
