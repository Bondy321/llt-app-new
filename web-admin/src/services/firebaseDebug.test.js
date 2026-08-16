import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isFirebaseDebugEnabled,
  sanitizeDebugValue,
} from './firebaseDebug';

describe('firebaseDebug', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honours an explicit production-safe disable switch', () => {
    vi.stubEnv('VITE_FIREBASE_DEBUG_LOGS', 'false');
    expect(isFirebaseDebugEnabled()).toBe(false);
  });

  it('requires an explicit true switch to enable production diagnostics', () => {
    vi.stubEnv('VITE_FIREBASE_DEBUG_LOGS', 'true');
    expect(isFirebaseDebugEnabled()).toBe(true);
  });

  it('redacts identity and token-shaped values before diagnostics reach the console', () => {
    const sanitized = sanitizeDebugValue({
      email: 'passenger@example.com',
      authorization: 'Bearer secret-value',
      pushToken: 'ExponentPushToken[private-token]',
      nested: { userId: 'ABCDEFGHIJKLMNOPQRSTUVWX' },
    });

    expect(JSON.stringify(sanitized)).not.toContain('passenger@example.com');
    expect(JSON.stringify(sanitized)).not.toContain('secret-value');
    expect(JSON.stringify(sanitized)).not.toContain('private-token');
    expect(JSON.stringify(sanitized)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
  });
});
