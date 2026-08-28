import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

const policyMocks = vi.hoisted(() => ({
  getDriverLoginPolicy: vi.fn(),
  setDriverLoginPolicy: vi.fn(),
}));
const notificationMocks = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock('@mantine/notifications', () => ({ notifications: notificationMocks }));
vi.mock('../services/accountSecurityService', () => ({
  getCurrentAccountUser: () => ({ uid: 'admin-1', email: 'admin@example.test' }),
  changeCurrentAccountPassword: vi.fn(),
}));
vi.mock('../services/driverLoginPolicyService', () => policyMocks);

import Settings from './Settings';

const renderSettings = () => render(<MantineProvider><Settings /></MantineProvider>);

describe('Settings driver handset policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyMocks.getDriverLoginPolicy.mockResolvedValue({
      enforceSingleDevice: false,
      generation: 0,
      revision: 0,
      updatedAtMs: null,
      isDefault: true,
    });
  });

  it('shows default-off state and requires explicit confirmation before enabling', async () => {
    policyMocks.setDriverLoginPolicy.mockResolvedValue({
      policy: {
        enforceSingleDevice: true,
        generation: 1,
        revision: 1,
        updatedAtMs: 1_800_000_000_000,
        isDefault: false,
      },
      changed: true,
      cleanup: { queued: 2, cleaned: 2, pending: 0 },
    });
    renderSettings();

    expect(await screen.findByText('Limit each driver code to one handset')).toBeInTheDocument();
    expect(screen.getByText('Default: multiple verified company handsets are allowed.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Limit each driver code to one handset' }));
    expect(await screen.findByText('Enable single-device driver login?')).toBeInTheDocument();
    expect(policyMocks.setDriverLoginPolicy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enable and revoke driver access' }));
    await waitFor(() => expect(policyMocks.setDriverLoginPolicy).toHaveBeenCalledWith({
      enforceSingleDevice: true,
      expectedRevision: 0,
    }));
    expect(notificationMocks.show).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('2 of 2 old session record(s) cleaned; 0 remain queued.'),
    }));
  });

  it('closes stale confirmation and reloads policy after a revision conflict', async () => {
    policyMocks.getDriverLoginPolicy
      .mockResolvedValueOnce({
        enforceSingleDevice: false,
        generation: 0,
        revision: 1,
        updatedAtMs: 1_800_000_000_000,
        isDefault: false,
      })
      .mockResolvedValueOnce({
        enforceSingleDevice: true,
        generation: 1,
        revision: 2,
        updatedAtMs: 1_800_000_000_100,
        isDefault: false,
      });
    const conflict = new Error('This setting changed in another session.');
    conflict.code = 'POLICY_CHANGED';
    policyMocks.setDriverLoginPolicy.mockRejectedValueOnce(conflict);
    renderSettings();

    const deviceSwitch = await screen.findByRole('switch', { name: 'Limit each driver code to one handset' });
    fireEvent.click(deviceSwitch);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable and revoke driver access' }));

    await waitFor(() => expect(policyMocks.getDriverLoginPolicy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Enable single-device driver login?')).not.toBeInTheDocument());
    expect(await screen.findByText('Single-device enforcement is active.')).toBeInTheDocument();
  });
});
