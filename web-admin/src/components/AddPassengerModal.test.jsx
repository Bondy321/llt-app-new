import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import AddPassengerModal from './AddPassengerModal';

vi.mock('../firebase', () => ({
  auth: { currentUser: null },
}));

describe('AddPassengerModal', () => {
  const tours = {
    '5112D_8': {
      name: 'Highlands',
      tourCode: '5112D 8',
      startDate: '15/06/2026',
      endDate: '15/06/2026',
      isActive: true,
      maxParticipants: 53,
    },
  };

  it('keeps creation disabled until every required passenger field is valid', async () => {
    render(
      <MantineProvider>
        <AddPassengerModal
          opened
          onClose={vi.fn()}
          tours={tours}
          initialTourId="5112D_8"
        />
      </MantineProvider>,
    );

    const submitButton = screen.getByRole('button', { name: 'Add Passenger Booking' });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/booking reference/i), {
      target: { value: 'T123456' },
    });
    fireEvent.change(screen.getByLabelText(/login email/i), {
      target: { value: 'review@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    fireEvent.change(screen.getByLabelText(/pickup location/i), {
      target: { value: 'Buchanan Bus Station' },
    });
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'Apple Reviewer' },
    });
    fireEvent.change(screen.getByLabelText(/seat number/i), {
      target: { value: '19' },
    });
    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '+44 7700 900000' },
    });

    expect(screen.getByRole('button', { name: 'Add Passenger Booking' })).toBeEnabled();
  });
});
