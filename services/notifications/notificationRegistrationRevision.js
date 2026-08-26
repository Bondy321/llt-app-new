import AsyncStorage from '@react-native-async-storage/async-storage';

const REVISION_KEY_PREFIX = '@LLT:notification-registration-revision:v1:';
let allocationChain = Promise.resolve();
const testRevisionValues = new Map();
const defaultStorage = process.env.NODE_ENV === 'test' ? {
  getItem: async (key) => testRevisionValues.get(key) ?? null,
  setItem: async (key, value) => { testRevisionValues.set(key, value); },
} : AsyncStorage;

const safeUid = (value) => (
  typeof value === 'string' && value.trim() ? value.trim().replace(/[^A-Za-z0-9_-]/g, '_') : null
);

export const notificationRegistrationRevisionKey = (authUid) => {
  const uid = safeUid(authUid);
  return uid ? `${REVISION_KEY_PREFIX}${uid}` : null;
};

export const allocateNotificationRegistrationRevision = ({
  authUid,
  storage = defaultStorage,
  now = () => Date.now(),
} = {}) => {
  const key = notificationRegistrationRevisionKey(authUid);
  if (!key) return Promise.reject(new Error('A current authenticated UID is required.'));
  const allocation = allocationChain.then(async () => {
    const previous = Number(await storage.getItem(key).catch(() => 0));
    // Millisecond time plus a bounded sequence leaves room for concurrent
    // lifecycle writes while staying within Number.MAX_SAFE_INTEGER.
    const clockRevision = Math.min(Number.MAX_SAFE_INTEGER - 1, now() * 1_000);
    // Leave a server-owned revision lane between client mutations. Session
    // cleanup/revocation can advance the stored revision while this client is
    // offline; the next client write must be strictly newer, not merely equal.
    const previousRevision = Number.isSafeInteger(previous)
      ? Math.min(Number.MAX_SAFE_INTEGER - 1, previous + 1_024)
      : 1;
    const next = Math.max(previousRevision, clockRevision);
    // Server-side session binding remains authoritative if local persistence is
    // temporarily unavailable; do not block logout/revoke on a storage fault.
    await storage.setItem(key, String(next)).catch(() => undefined);
    return next;
  });
  allocationChain = allocation.catch(() => undefined);
  return allocation;
};

export const __resetNotificationRegistrationRevisionForTests = () => {
  allocationChain = Promise.resolve();
  testRevisionValues.clear();
};
