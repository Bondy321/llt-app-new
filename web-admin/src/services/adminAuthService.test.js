import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  get: vi.fn(),
  ref: vi.fn((_database, path) => ({ path })),
}));

vi.mock('firebase/database', () => databaseMocks);

import {
  OPERATIONS_ADMIN_UID,
  hasOperationsAdminAccess,
} from './adminAuthService';

describe('hasOperationsAdminAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts the primary operations account without a database round trip', async () => {
    await expect(hasOperationsAdminAccess({}, { uid: OPERATIONS_ADMIN_UID })).resolves.toBe(true);
    expect(databaseMocks.get).not.toHaveBeenCalled();
  });

  it('accepts only an explicit true delegated-admin record', async () => {
    databaseMocks.get.mockResolvedValueOnce({ val: () => true });
    await expect(hasOperationsAdminAccess({}, { uid: 'delegate-1' })).resolves.toBe(true);
    expect(databaseMocks.ref).toHaveBeenCalledWith({}, 'admin_users/delegate-1');

    databaseMocks.get.mockResolvedValueOnce({ val: () => null });
    await expect(hasOperationsAdminAccess({}, { uid: 'passenger-1' })).resolves.toBe(false);
  });

  it('fails closed when the authorization lookup is denied or unavailable', async () => {
    databaseMocks.get.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await expect(hasOperationsAdminAccess({}, { uid: 'unknown-1' })).resolves.toBe(false);
    await expect(hasOperationsAdminAccess({}, null)).resolves.toBe(false);
  });
});
