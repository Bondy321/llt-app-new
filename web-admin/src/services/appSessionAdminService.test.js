import { describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('./adminActionService', () => ({ postAdminAction: vi.fn() }));

import { postAdminAction } from './adminActionService';
import {
  maskAppSessionId,
  normalizeAdminAppSession,
  revokeAppSession,
} from './appSessionAdminService';

const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;

describe('appSessionAdminService', () => {
  it('normalises active session display data without exposing the principal', () => {
    const session = normalizeAdminAppSession({
      schemaVersion: 1,
      status: 'active',
      sessionId: SESSION_ID,
      principalType: 'driver',
      principalId: 'driver:D-100',
      tourId: 'TOUR_1',
      driverId: 'D-100',
      issuedAtMs: 100,
      expiresAtMs: 2_000,
      sessionRevision: 2,
    }, 1_000);

    expect(session).toEqual(expect.objectContaining({
      sessionId: SESSION_ID,
      principalType: 'driver',
      tourId: 'TOUR_1',
      isExpired: false,
    }));
    expect(session).not.toHaveProperty('principalId');
  });

  it('accepts Firebase-shaped sessions when a nullable child was omitted', () => {
    const unassignedDriver = normalizeAdminAppSession({
      schemaVersion: 1,
      status: 'active',
      sessionId: SESSION_ID,
      principalType: 'driver',
      principalId: 'driver:D-100',
      driverId: 'D-100',
      issuedAtMs: 100,
      expiresAtMs: 2_000,
      sessionRevision: 2,
    }, 1_000);

    expect(unassignedDriver).toEqual(expect.objectContaining({
      principalType: 'driver',
      tourId: null,
      driverId: 'D-100',
    }));
  });

  it('masks the middle of a valid session ID', () => {
    expect(maskAppSessionId(SESSION_ID)).toBe(`sess_v1_aaa…aaaaaa`);
    expect(maskAppSessionId('bad')).toBe('Unavailable');
  });

  it('requires a reason and sends an expected-session compare-and-revoke request', async () => {
    await expect(revokeAppSession({ authUid: 'uid-1', sessionId: SESSION_ID, reason: '' }))
      .rejects.toThrow(/reason/i);

    postAdminAction.mockResolvedValueOnce({ success: true });
    await revokeAppSession({ authUid: 'uid-1', sessionId: SESSION_ID, reason: 'lost_device' });
    expect(postAdminAction).toHaveBeenCalledWith(
      'revokeAppSession',
      { authUid: 'uid-1', expectedSessionId: SESSION_ID, reason: 'lost_device' },
      expect.any(Object),
    );
  });
});
