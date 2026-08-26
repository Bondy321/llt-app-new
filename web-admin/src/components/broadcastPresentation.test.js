import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUS_META,
  normalizeBroadcastMessage,
  presentSkipReasons,
} from '../features/broadcasts/components/broadcastPresentation';

describe('broadcast delivery presentation', () => {
  it('keeps ticket acceptance distinct from provider acceptance', () => {
    expect(DELIVERY_STATUS_META.ticket_accepted.label).toMatch(/ticket/i);
    expect(DELIVERY_STATUS_META.provider_accepted.label).toMatch(/provider/i);
    expect(DELIVERY_STATUS_META.delivered.label).toMatch(/legacy/i);
  });

  it('normalizes safe delivery fields without accepting token-shaped data', () => {
    const value = normalizeBroadcastMessage('T1', 'B1', {
      message: 'Departure changed',
      createdAtMs: 1000,
      deliveryJobId: 'nj_safe',
      skipReasons: { no_token: 2, opted_out: 1 },
      pushToken: 'ExponentPushToken[never-rendered]',
    });
    expect(value.deliveryJobId).toBe('nj_safe');
    expect(value).not.toHaveProperty('pushToken');
    expect(presentSkipReasons(value.skipReasons)).toBe('2 no token, 1 opted out');
  });
});
