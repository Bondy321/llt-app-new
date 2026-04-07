require('@babel/register')({
  presets: ['babel-preset-expo'],
  extensions: ['.js', '.jsx'],
  ignore: [/node_modules/],
});

const test = require('node:test');
const assert = require('node:assert/strict');
const loggerServicePath = require.resolve('../services/loggerService');
require.cache[loggerServicePath] = {
  id: loggerServicePath,
  filename: loggerServicePath,
  loaded: true,
  exports: {
    maskIdentifier: (value) => value,
  },
};
const { migrateRecentChatMessagesForStableIdentity } = require('../services/chatIdentityMigrationService');

const TOUR_ID = 'TOUR_STABLE_001';
const STABLE_PASSENGER_ID = 'pax:BOOKING-001';
const DEVICE_A_UID = 'auth:device-a';
const DEVICE_B_UID = 'auth:device-b';

const deepClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const createMockRealtimeDb = (initialData = {}) => {
  const state = deepClone(initialData) || {};

  const normalizePath = (path = '') => path.split('/').filter(Boolean);

  const getValue = (path = '') => {
    const parts = normalizePath(path);
    if (parts.length === 0) return state;
    return parts.reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), state);
  };

  const setValue = (path, value) => {
    const parts = normalizePath(path);
    if (parts.length === 0) {
      throw new Error('Root set is not supported in mock db');
    }

    let cursor = state;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }

    const lastKey = parts[parts.length - 1];
    if (value === null || value === undefined) {
      delete cursor[lastKey];
      return;
    }

    cursor[lastKey] = deepClone(value);
  };

  const applyMultiPathUpdate = (updates) => {
    Object.entries(updates).forEach(([path, value]) => setValue(path, value));
  };

  const buildSnapshot = (path = '', valueOverride) => {
    const hasOverride = arguments.length === 2;
    const raw = hasOverride ? valueOverride : getValue(path);
    const snapshotValue = raw === undefined ? null : deepClone(raw);

    return {
      val: () => deepClone(snapshotValue),
      exists: () => snapshotValue !== null,
      child: (childPath) => {
        const fullPath = [path, childPath].filter(Boolean).join('/');
        return buildSnapshot(fullPath);
      },
      forEach: (callback) => {
        if (!snapshotValue || typeof snapshotValue !== 'object') return false;
        Object.entries(snapshotValue).forEach(([key, childValue]) => {
          callback({
            key,
            val: () => deepClone(childValue),
            exists: () => childValue !== null && childValue !== undefined,
          });
        });
        return true;
      },
    };
  };

  const buildRef = (path = '') => ({
    set: async (value) => {
      setValue(path, value);
      return value;
    },
    update: async (patch) => {
      if (!path) {
        applyMultiPathUpdate(patch || {});
        return patch;
      }

      const current = getValue(path);
      const base = current && typeof current === 'object' ? deepClone(current) : {};
      setValue(path, { ...base, ...(patch || {}) });
      return patch;
    },
    remove: async () => {
      setValue(path, null);
    },
    once: async (eventType) => {
      assert.equal(eventType, 'value');
      return buildSnapshot(path);
    },
    orderByChild: () => ({
      limitToLast: (limit) => ({
        once: async (eventType) => {
          assert.equal(eventType, 'value');
          const full = getValue(path) || {};
          const entries = Object.entries(full)
            .filter(([, value]) => value && typeof value === 'object')
            .sort(([, a], [, b]) => (a.timestamp || 0) - (b.timestamp || 0))
            .slice(-limit);

          return buildSnapshot(path, Object.fromEntries(entries));
        },
      }),
    }),
  });

  return {
    _state: state,
    ref(path = '') {
      return buildRef(path);
    },
  };
};

const createRuleAssumptionHarness = ({ db, tourId, stablePassengerId }) => {
  const canActAsPrincipal = (authUid, principalId) => {
    if (!authUid || !principalId) return false;
    if (authUid === principalId) return true;

    const stableFromUsers = db._state.users?.[authUid]?.stablePassengerId;
    const photoOwnerFromUsers = db._state.users?.[authUid]?.privatePhotoOwnerId;
    const identityBinding = db._state.identity_bindings?.[principalId]?.[authUid] === true;

    return stableFromUsers === principalId || photoOwnerFromUsers === principalId || identityBinding;
  };

  const ensureAllowed = (authUid, principalId) => {
    assert.equal(canActAsPrincipal(authUid, principalId), true, `Denied principal write: ${authUid} -> ${principalId}`);
  };

  return {
    async writeChatMessage(authUid, text) {
      ensureAllowed(authUid, stablePassengerId);
      const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await db.ref(`chats/${tourId}/messages/${id}`).set({
        senderId: authUid,
        senderStableId: stablePassengerId,
        senderType: 'passenger',
        text,
        timestamp: Date.now(),
      });
      return id;
    },
    async writeReaction(authUid, messageId, emoji = '👍') {
      ensureAllowed(authUid, stablePassengerId);
      await db.ref(`chats/${tourId}/messages/${messageId}/reactions/${emoji}/${stablePassengerId}`).set(true);
    },
    async writeTyping(authUid) {
      ensureAllowed(authUid, stablePassengerId);
      await db.ref(`chats/${tourId}/typing/${stablePassengerId}`).set({ online: true, timestamp: Date.now() });
    },
    async writePresence(authUid) {
      ensureAllowed(authUid, stablePassengerId);
      await db.ref(`chats/${tourId}/presence/${stablePassengerId}`).set({ online: true, lastSeen: Date.now() });
    },
    async writePrivatePhoto(authUid, photoId, url) {
      ensureAllowed(authUid, stablePassengerId);
      await db.ref(`private_tour_photos/${tourId}/${stablePassengerId}/${photoId}`).set({
        url,
        userId: stablePassengerId,
        timestamp: Date.now(),
      });
    },
    readMessages() {
      return db._state.chats?.[tourId]?.messages || {};
    },
    readPrivatePhotos(authUid) {
      ensureAllowed(authUid, stablePassengerId);
      return db._state.private_tour_photos?.[tourId]?.[stablePassengerId] || {};
    },
  };
};

const seedIdentity = () => ({
  users: {
    [DEVICE_A_UID]: {
      stablePassengerId: STABLE_PASSENGER_ID,
      privatePhotoOwnerId: STABLE_PASSENGER_ID,
    },
    [DEVICE_B_UID]: {
      stablePassengerId: STABLE_PASSENGER_ID,
      privatePhotoOwnerId: STABLE_PASSENGER_ID,
    },
  },
  identity_bindings: {
    [STABLE_PASSENGER_ID]: {
      [DEVICE_A_UID]: true,
      [DEVICE_B_UID]: true,
    },
  },
  chats: {
    [TOUR_ID]: {
      messages: {
        legacy_from_device_a: {
          senderId: DEVICE_A_UID,
          text: 'legacy payload from uid only',
          timestamp: 1710000000000,
        },
        already_stable: {
          senderId: DEVICE_B_UID,
          senderStableId: STABLE_PASSENGER_ID,
          senderType: 'passenger',
          text: 'already stable',
          timestamp: 1710000001000,
        },
      },
    },
  },
});

test('integration: two devices sharing stable identity can collaborate across chat/photo/realtime status scopes', async () => {
  const db = createMockRealtimeDb(seedIdentity());
  const harness = createRuleAssumptionHarness({ db, tourId: TOUR_ID, stablePassengerId: STABLE_PASSENGER_ID });

  const messageIdFromA = await harness.writeChatMessage(DEVICE_A_UID, 'hello from device A');
  const messageIdFromB = await harness.writeChatMessage(DEVICE_B_UID, 'hello from device B');

  const messages = harness.readMessages();
  assert.equal(messages[messageIdFromA].senderStableId, STABLE_PASSENGER_ID);
  assert.equal(messages[messageIdFromB].senderStableId, STABLE_PASSENGER_ID);

  await harness.writePrivatePhoto(DEVICE_A_UID, 'photo_a', 'https://cdn.local/photo-a.jpg');
  const photosSeenByB = harness.readPrivatePhotos(DEVICE_B_UID);
  assert.equal(photosSeenByB.photo_a.userId, STABLE_PASSENGER_ID);

  await harness.writeReaction(DEVICE_B_UID, messageIdFromA, '🔥');
  await harness.writeTyping(DEVICE_A_UID);
  await harness.writePresence(DEVICE_B_UID);

  assert.equal(
    db._state.chats[TOUR_ID].messages[messageIdFromA].reactions['🔥'][STABLE_PASSENGER_ID],
    true,
  );
  assert.equal(db._state.chats[TOUR_ID].typing[STABLE_PASSENGER_ID].online, true);
  assert.equal(db._state.chats[TOUR_ID].presence[STABLE_PASSENGER_ID].online, true);
});

test('integration: migration backfills legacy UID-only messages to stable passenger identity', async () => {
  const db = createMockRealtimeDb(seedIdentity());
  const logs = [];
  const logger = {
    info: (component, message, data) => logs.push({ level: 'info', component, message, data }),
    warn: (component, message, data) => logs.push({ level: 'warn', component, message, data }),
  };

  await db.ref(`chats/${TOUR_ID}/messages/foreign_legacy`).set({
    senderId: 'auth:foreign',
    text: 'should stay untouched',
    timestamp: 1710000000500,
  });

  await migrateRecentChatMessagesForStableIdentity({
    tourId: TOUR_ID,
    stablePassengerId: STABLE_PASSENGER_ID,
    realtimeDb: db,
    logger,
  });

  const migrated = db._state.chats[TOUR_ID].messages.legacy_from_device_a;
  const untouched = db._state.chats[TOUR_ID].messages.foreign_legacy;
  const alreadyStable = db._state.chats[TOUR_ID].messages.already_stable;

  assert.equal(migrated.senderStableId, STABLE_PASSENGER_ID);
  assert.equal(migrated.senderType, 'passenger');
  assert.equal(alreadyStable.senderStableId, STABLE_PASSENGER_ID);
  assert.equal(untouched.senderStableId, undefined);

  const metricLog = logs.find((entry) => entry.message === 'Migration metrics');
  assert.ok(metricLog, 'Expected migration metrics log to be emitted');
  assert.equal(metricLog.data.patchedCount, 1);
});
