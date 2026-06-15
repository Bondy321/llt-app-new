import { beforeEach, describe, expect, it, vi } from 'vitest';

const getIdTokenMock = vi.fn();

vi.mock('../firebase', () => ({
  auth: {
    currentUser: {
      getIdToken: getIdTokenMock,
    },
  },
}));

describe('passengerService manual booking validation', () => {
  const tours = {
    '5112D_8': {
      name: 'Highlands',
      tourCode: '5112D 8',
      startDate: '15/06/2026',
      endDate: '16/06/2026',
      isActive: true,
      maxParticipants: 53,
    },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    getIdTokenMock.mockResolvedValue('token-123');
  });

  it('requires all app-critical booking, identity, pickup, passenger, and seat fields', async () => {
    const { validateManualPassengerDraft } = await import('./passengerService.js');

    const result = validateManualPassengerDraft({
      tourId: '5112D_8',
      bookingRef: '',
      email: 'not-an-email',
      pickupDate: '',
      pickupTime: '',
      pickupLocation: '',
      passengers: [{ name: '', seatNumber: '', phone: '' }],
    }, tours);

    expect(result.valid).toBe(false);
    expect(result.errors.bookingRef).toBeTruthy();
    expect(result.errors.email).toBeTruthy();
    expect(result.errors.pickupDate).toBeTruthy();
    expect(result.errors.pickupTime).toBeTruthy();
    expect(result.errors.pickupLocation).toBeTruthy();
    expect(result.errors.passengerRows[0].name).toBeTruthy();
    expect(result.errors.passengerRows[0].seatNumber).toBeTruthy();
    expect(result.errors.passengerRows[0].phone).toBeTruthy();
  });

  it('normalizes a complete booking draft for the Cloud Function contract', async () => {
    const { validateManualPassengerDraft } = await import('./passengerService.js');

    const result = validateManualPassengerDraft({
      tourId: '5112D_8',
      bookingRef: ' t123456 ',
      email: ' Review@Example.COM ',
      pickupDate: '2026-06-15',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      passengers: [
        { name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' },
      ],
    }, tours);

    expect(result.valid).toBe(true);
    expect(result.normalized).toEqual({
      tourId: '5112D_8',
      bookingRef: 'T123456',
      email: 'review@example.com',
      pickupDate: '15/06/2026',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      passengers: [
        { name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' },
      ],
    });
  });

  it('blocks duplicate seats inside the same manual booking', async () => {
    const { validateManualPassengerDraft } = await import('./passengerService.js');

    const result = validateManualPassengerDraft({
      tourId: '5112D_8',
      bookingRef: 'T123456',
      email: 'review@example.com',
      pickupDate: '2026-06-15',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      passengers: [
        { name: 'First Passenger', seatNumber: 19, phone: '+44 7700 900000' },
        { name: 'Second Passenger', seatNumber: 19, phone: '+44 7700 900001' },
      ],
    }, tours);

    expect(result.valid).toBe(false);
    expect(result.errors.passengerRows[1].seatNumber).toMatch(/already used/);
  });

  it('sends the normalized payload with the current admin bearer token', async () => {
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-project');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        bookingRef: 'T123456',
        tourId: '5112D_8',
        tourCode: '5112D 8',
        email: 'review@example.com',
        passengerCount: 1,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { createManualPassengerBooking } = await import('./passengerService.js');
    const result = await createManualPassengerBooking({
      tourId: '5112D_8',
      bookingRef: 't123456',
      email: 'Review@Example.COM',
      pickupDate: '2026-06-15',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      passengers: [
        { name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' },
      ],
    }, tours);

    expect(result.bookingRef).toBe('T123456');
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://europe-west1-demo-project.cloudfunctions.net/createManualPassengerBooking',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tourId: '5112D_8',
          bookingRef: 'T123456',
          email: 'review@example.com',
          pickupDate: '15/06/2026',
          pickupTime: '08:30',
          pickupLocation: 'Buchanan Bus Station',
          passengers: [
            { name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' },
          ],
        }),
      }),
    );
  });
});
