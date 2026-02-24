const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOfflineLoginFromCache,
  OFFLINE_LOGIN_REASONS,
  normalizePassengerEmail,
} = require('../services/offlineLoginResolver');

const createSessionStorage = (tourData, bookingData) => ({
  multiGet: async (keys) => keys.map((key) => {
    if (key === '@LLT:tourData') return [key, tourData ? JSON.stringify(tourData) : null];
    if (key === '@LLT:bookingData') return [key, bookingData ? JSON.stringify(bookingData) : null];
    return [key, null];
  }),
});

const sessionKeys = {
  TOUR_DATA: '@LLT:tourData',
  BOOKING_DATA: '@LLT:bookingData',
};

test('offline passenger login succeeds when booking ref and normalized email match cached session', async () => {
  const result = await resolveOfflineLoginFromCache({
    reference: 'abc123',
    normalizedEmail: normalizePassengerEmail('Passenger@Example.com'),
    sessionStorage: createSessionStorage(
      { id: 'T_1', tourCode: 'T1' },
      { id: 'ABC123', normalizedPassengerEmail: 'passenger@example.com' }
    ),
    sessionKeys,
    offlineSyncService: {
      getTourPackMeta: async () => ({ success: true, data: { lastSyncedAt: new Date().toISOString() } }),
      getTourPack: async () => ({ success: false }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.type, 'passenger');
  assert.equal(result.source, 'session');
});

test('offline passenger login fails with EMAIL_MISMATCH when cached session email differs', async () => {
  const result = await resolveOfflineLoginFromCache({
    reference: 'ABC123',
    normalizedEmail: 'wrong@example.com',
    sessionStorage: createSessionStorage(
      { id: 'T_1', tourCode: 'T1' },
      { id: 'ABC123', normalizedPassengerEmail: 'passenger@example.com' }
    ),
    sessionKeys,
    offlineSyncService: {
      getTourPackMeta: async () => ({ success: true, data: { lastSyncedAt: new Date().toISOString() } }),
      getTourPack: async () => ({ success: false }),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, OFFLINE_LOGIN_REASONS.EMAIL_MISMATCH);
});

test('offline passenger login fails with EMAIL_MISMATCH when tour-pack email differs', async () => {
  const result = await resolveOfflineLoginFromCache({
    reference: 'ABC123',
    normalizedEmail: 'wrong@example.com',
    sessionStorage: createSessionStorage(
      { id: 'T_1', tourCode: 'T1' },
      { id: 'OLD123', normalizedPassengerEmail: 'passenger@example.com' }
    ),
    sessionKeys,
    offlineSyncService: {
      getTourPackMeta: async () => ({ success: true, data: { lastSyncedAt: new Date().toISOString() } }),
      getTourPack: async () => ({
        success: true,
        data: {
          tour: { id: 'T_1' },
          booking: { id: 'ABC123', normalizedPassengerEmail: 'passenger@example.com' },
        },
      }),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, OFFLINE_LOGIN_REASONS.EMAIL_MISMATCH);
});
