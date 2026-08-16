import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTransactionMock = vi.fn();
const refMock = vi.fn((_database, path) => ({ path }));

vi.mock('firebase/database', () => ({
  ref: refMock,
  runTransaction: runTransactionMock,
}));
vi.mock('../firebase', () => ({ db: { __mock: true } }));

describe('driverService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a normalized driver only when its code does not exist', async () => {
    runTransactionMock.mockImplementation(async (_target, updater, options) => {
      expect(options).toEqual({ applyLocally: false });
      const value = updater(null);
      expect(value).toMatchObject({ id: 'D-ALICE-SMITH', name: 'Alice Smith' });
      return { committed: true };
    });

    const { createDriver } = await import('./driverService');
    const result = await createDriver({ name: ' Alice Smith ', code: 'alice smith' });

    expect(result.id).toBe('D-ALICE-SMITH');
    expect(refMock).toHaveBeenCalledWith({ __mock: true }, 'drivers/D-ALICE-SMITH');
  });

  it('refuses duplicate codes without replacing the existing driver record', async () => {
    runTransactionMock.mockImplementation(async (_target, updater) => {
      expect(updater({ name: 'Existing', authUid: 'auth-1', currentTourId: 'TOUR_1' })).toBeUndefined();
      return { committed: false };
    });

    const { createDriver } = await import('./driverService');
    await expect(createDriver({ name: 'Replacement', code: 'D-ALICE' })).rejects.toThrow(/already in use/i);
  });
});
