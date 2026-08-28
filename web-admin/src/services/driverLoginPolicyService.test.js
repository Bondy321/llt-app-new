import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({ auth: {} }));
vi.mock('./adminActionService', () => ({ postAdminAction: vi.fn() }));

import { postAdminAction } from './adminActionService';
import { getDriverLoginPolicy, setDriverLoginPolicy } from './driverLoginPolicyService';

describe('driverLoginPolicyService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the explicit default-off policy without exposing backend audit fields', async () => {
    postAdminAction.mockResolvedValueOnce({
      success: true,
      policy: {
        enforceSingleDevice: false,
        generation: 0,
        revision: 0,
        updatedAtMs: null,
        isDefault: true,
        updatedByHash: 'server-only',
      },
    });

    await expect(getDriverLoginPolicy()).resolves.toEqual({
      enforceSingleDevice: false,
      generation: 0,
      revision: 0,
      updatedAtMs: null,
      isDefault: true,
    });
    expect(postAdminAction).toHaveBeenCalledWith('getDriverLoginPolicy', {}, expect.any(Object));
  });

  it('uses optimistic revision control and returns cleanup progress when enabling', async () => {
    postAdminAction.mockResolvedValueOnce({
      success: true,
      changed: true,
      policy: {
        enforceSingleDevice: true,
        generation: 1,
        revision: 1,
        updatedAtMs: 1_800_000_000_000,
        isDefault: false,
      },
      cleanup: { queued: 2, cleaned: 1, pending: 1 },
    });

    await expect(setDriverLoginPolicy({ enforceSingleDevice: true, expectedRevision: 0 }))
      .resolves.toEqual(expect.objectContaining({
        changed: true,
        cleanup: { queued: 2, cleaned: 1, pending: 1 },
      }));
    expect(postAdminAction).toHaveBeenCalledWith(
      'setDriverLoginPolicy',
      { enforceSingleDevice: true, expectedRevision: 0 },
      expect.any(Object),
    );
  });

  it('rejects malformed policy responses instead of guessing a security setting', async () => {
    postAdminAction.mockResolvedValueOnce({
      success: true,
      policy: { enforceSingleDevice: 'false', generation: 0, revision: 0, updatedAtMs: null },
    });
    await expect(getDriverLoginPolicy()).rejects.toThrow(/invalid driver login policy/i);
  });

  it('rejects malformed cleanup progress instead of displaying invented counts', async () => {
    postAdminAction.mockResolvedValueOnce({
      success: true,
      changed: true,
      policy: {
        enforceSingleDevice: true,
        generation: 1,
        revision: 1,
        updatedAtMs: 1_800_000_000_000,
        isDefault: false,
      },
      cleanup: { queued: '2', cleaned: 1, pending: -1 },
    });
    await expect(setDriverLoginPolicy({ enforceSingleDevice: true, expectedRevision: 0 }))
      .rejects.toThrow(/invalid driver session cleanup progress/i);
  });
});
