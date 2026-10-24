import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

vi.mock('../services/adminActionService', () => ({ postAdminAction: vi.fn() }));
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

import { postAdminAction } from '../services/adminActionService';
import StaffDeviceEnrolment from '../features/drivers/components/StaffDeviceEnrolment';
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


const renderEnrolment = () => render(<MantineProvider><StaffDeviceEnrolment driverId="D-SYNTHETIC" /></MantineProvider>);
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const issueSecret = async () => {
  postAdminAction.mockResolvedValueOnce({ success: true, secret: 'synthetic-first-secret' });
  fireEvent.click(screen.getByRole('button', { name: 'Create one-time code' }));
  expect(await screen.findByLabelText('One-time enrolment code')).toHaveValue('synthetic-first-secret');
};

describe('Staff device approval', () => {
  beforeEach(() => postAdminAction.mockReset());

  it('shows an enrolment secret only after the checked server operation succeeds', async () => {
    const pending = deferred(); postAdminAction.mockReturnValueOnce(pending.promise);
    renderEnrolment();
    expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create one-time code' }));
    expect(postAdminAction).toHaveBeenCalledWith('staffDeviceEnrolment', { driverId: 'D-SYNTHETIC', action: 'issue' }, expect.any(Object));
    expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
    await act(async () => pending.resolve({ success: true, secret: 'synthetic-new-secret' }));
    expect(screen.getByLabelText('One-time enrolment code')).toHaveValue('synthetic-new-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
  });

  for (const [action, label] of [['replace', 'Replace all approved phones'], ['revoke', 'Revoke all driver phones']]) {
    it(`${action} clears the previous secret immediately and displays only the confirmed result`, async () => {
      renderEnrolment(); await issueSecret();
      const pending = deferred(); postAdminAction.mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(postAdminAction).toHaveBeenLastCalledWith('staffDeviceEnrolment', { driverId: 'D-SYNTHETIC', action }, expect.any(Object));
      expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
      expect(screen.queryByText('All approved driver phones have been revoked.')).not.toBeInTheDocument();
      await act(async () => pending.resolve(action === 'replace'
        ? { success: true, secret: 'synthetic-replacement-secret' } : { success: true, revoked: true }));
      if (action === 'replace') expect(screen.getByLabelText('One-time enrolment code')).toHaveValue('synthetic-replacement-secret');
      else {
        expect(screen.getByText('All approved driver phones have been revoked.')).toBeInTheDocument();
        expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
      }
    });
  }

  it('an unconfirmed replacement hides the old secret and preserves truthful failure copy', async () => {
    renderEnrolment(); await issueSecret();
    const message = 'The result could not be confirmed. The operation may still have completed; check the current record before retrying.';
    postAdminAction.mockRejectedValueOnce(new Error(message));
    fireEvent.click(screen.getByRole('button', { name: 'Replace all approved phones' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByLabelText('One-time enrolment code')).not.toBeInTheDocument();
    expect(screen.queryByText('All approved driver phones have been revoked.')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace all approved phones' })).toBeEnabled());
  });
});
