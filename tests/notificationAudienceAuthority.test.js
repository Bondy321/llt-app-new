const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-audience-authority' });

const {
  loadNotificationAudiencePage,
  normalizeNotificationDevice,
} = require('../functions/src/domains/notifications/notificationAudiencePage');
const {
  buildMigrationState,
  buildNotificationDeviceProjection,
  closeAdminApps,
  parseArgs,
} = require('../functions/scripts/migrateNotificationDevices');

const token = 'ExponentPushToken[canonical-authority-token]';

const snapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value ?? null,
});

const createAudienceDb = ({ users = {}, devices = {}, migration = {} } = {}) => ({
  ref(pathName) {
    if (pathName === 'users') {
      let after = null;
      let limit = Infinity;
      const query = {
        orderByKey: () => query,
        startAfter: (value) => { after = value; return query; },
        limitToFirst: (value) => { limit = value; return query; },
        once: async () => snapshot(Object.fromEntries(Object.entries(users)
          .filter(([uid]) => !after || uid > after)
          .slice(0, limit))),
      };
      return query;
    }
    if (pathName === 'notification_migrations/device_registry_v1') {
      return { once: async () => snapshot(migration) };
    }
    if (pathName.startsWith('notification_devices/')) {
      const uid = pathName.split('/').at(-1);
      return { once: async () => snapshot(devices[uid]) };
    }
    throw new Error(`Unexpected path ${pathName}`);
  },
});

test('canonical explicit values never fall back to legacy delivery authority', () => {
  const legacy = {
    pushToken: token,
    pushTokenStatus: 'ACTIVE',
    pushPermissionState: 'granted',
    deviceOS: 'ios',
    preferences: { marketing: { day_trips: true } },
  };
  const cases = [
    { pushToken: null, status: 'inactive', permissionState: 'granted', operationalEligible: false },
    { pushToken: token, status: 'active', permissionState: 'denied', operationalEligible: false },
    { pushToken: token, status: 'active', permissionState: 'blocked', operationalEligible: false },
    { pushToken: null, status: 'revoked', permissionState: 'unavailable', operationalEligible: false },
  ];
  cases.forEach((device) => {
    const normalized = normalizeNotificationDevice({ authUid: 'uid-1', source: 'device', device }, legacy);
    assert.equal(normalized.pushToken, typeof device.pushToken === 'string' ? device.pushToken : '');
    assert.equal(normalized.permissionState, device.permissionState);
    assert.equal(normalized.operationalEligible, false);
    assert.deepEqual(normalized.marketingPreferences, {});
  });
});

test('legacy phase excludes every UID that has a canonical record', async () => {
  const db = createAudienceDb({
    users: { canonical: { pushToken: token }, legacyOnly: { pushToken: token } },
    devices: { canonical: { pushToken: null, operationalEligible: false } },
  });
  const page = await loadNotificationAudiencePage(db, 'users|', 100);
  assert.deepEqual(page.candidates.map((candidate) => candidate.authUid), ['legacyOnly']);
});

test('completed migration switch disables the legacy audience phase', async () => {
  const db = createAudienceDb({
    users: { legacyOnly: { pushToken: token } },
    migration: { completed: true, legacyFallbackEnabled: false },
  });
  const page = await loadNotificationAudiencePage(db, 'users|', 100);
  assert.deepEqual(page, { phase: 'users', candidates: [], nextCursor: null, exhausted: true });
});

test('migration cutoff is explicit and projections preserve normal logout marketing semantics', () => {
  assert.equal(parseArgs(['--apply', '--disable-legacy-fallback']).disableLegacyFallback, true);
  const projection = buildNotificationDeviceProjection({
    authUid: 'uid-1',
    profile: {
      pushToken: token,
      pushTokenStatus: 'ACTIVE',
      pushPermissionState: 'granted',
      preferences: { marketing: { day_trips: true } },
    },
    session: null,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(projection.device.operationalEligible, false);
  assert.equal(projection.device.marketingEligible, true);
});

test('migration CLI closes every Firebase Admin app so the process can terminate', async () => {
  const deleted = [];
  await closeAdminApps({
    apps: [
      { delete: async () => deleted.push('primary') },
      { delete: async () => deleted.push('secondary') },
    ],
  });
  assert.deepEqual(deleted.sort(), ['primary', 'secondary']);
});

test('migration state initializes safely when the RTDB transaction starts from null', () => {
  assert.deepEqual(buildMigrationState({
    current: null,
    disableLegacyFallback: false,
    migrationComplete: true,
    nextCursor: null,
    nowMs: 1_800_000_000_000,
  }), {
    schemaVersion: 1,
    completed: true,
    legacyFallbackEnabled: true,
    lastCursor: null,
    updatedAtMs: 1_800_000_000_000,
    completedAtMs: 1_800_000_000_000,
  });
});
