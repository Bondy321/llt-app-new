const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildNotificationFeed,
  clearNotificationFeedCache,
  feedCacheKey,
  loadNotificationFeedCache,
  markAllNotificationsRead,
  markNotificationRead,
  normalizeTourNotice,
  persistNotificationFeedCache,
  requestNotificationReadStateMigration,
  subscribeToNotificationFeed,
} = require('../services/notificationInboxService');
const {
  NOTIFICATION_RESPONSE_DISPOSITIONS,
  getNotificationResponseKey,
  resolveNotificationRoute,
} = require('../utils/notificationRouting');

const createNotice = (overrides = {}) => ({
  version: 1,
  type: 'announcement',
  title: 'Pickup update',
  body: 'Meet the coach ten minutes later.',
  tourId: 'TOUR_1',
  screen: 'Chat',
  sourceId: 'broadcast_1',
  priority: 'high',
  createdAt: '2026-08-12T10:00:00.000Z',
  createdAtMs: 1786525200000,
  ...overrides,
});

test('notification feed normalizes, orders, and overlays per-user read state', () => {
  const feed = buildNotificationFeed({
    notice_old: createNotice({ createdAtMs: 100, createdAt: '1970-01-01T00:00:00.100Z' }),
    notice_new: createNotice({ type: 'itinerary', screen: 'Itinerary', createdAtMs: 200, createdAt: '1970-01-01T00:00:00.200Z' }),
    invalid: { title: 'Missing required fields' },
  }, {
    notice_old: 300,
  });

  assert.deepEqual(feed.map((item) => item.id), ['notice_new', 'notice_old']);
  assert.equal(feed[0].isRead, false);
  assert.equal(feed[1].isRead, true);
  assert.equal(feed[1].messageId, 'broadcast_1');
  assert.equal(normalizeTourNotice('invalid', {}), null);
});

test('notification response routing accepts the active tour and rejects stale or unknown routes', () => {
  const response = {
    notification: {
      request: {
        identifier: 'response-1',
        content: {
          data: { screen: 'Chat', tourId: 'TOUR 1', messageId: 'message-1' },
        },
      },
    },
  };

  assert.deepEqual(resolveNotificationRoute(response, { activeTourId: 'TOUR_1', isDriver: true }), {
    accepted: true,
    screen: 'Chat',
    params: {
      tourId: 'TOUR_1',
      fromNotification: true,
      noticeId: null,
      messageId: 'message-1',
      isDriver: true,
      internalDriverChat: false,
    },
    responseKey: 'response-1',
  });
  assert.equal(resolveNotificationRoute(response, { activeTourId: 'OTHER' }).reason, 'TOUR_MISMATCH');
  assert.equal(resolveNotificationRoute({ data: { screen: 'Settings', tourId: 'TOUR_1' } }, { activeTourId: 'TOUR_1' }).reason, 'UNSUPPORTED_SCREEN');
  assert.equal(getNotificationResponseKey(response), 'response-1');
});

test('internal driver chat notification opens the exact internal thread message', () => {
  const route = resolveNotificationRoute({
    data: {
      screen: 'Chat',
      tourId: 'TOUR_1',
      messageId: 'int-1',
      internalDriverChat: true,
    },
  }, { activeTourId: 'TOUR_1', isDriver: true });

  assert.equal(route.accepted, true);
  assert.equal(route.screen, 'Chat');
  assert.equal(route.params.messageId, 'int-1');
  assert.equal(route.params.internalDriverChat, true);
  assert.equal(route.params.isDriver, true);
});

test('safety notification opens the active tour safety screen in the correct role', () => {
  const driverRoute = resolveNotificationRoute({
    data: { screen: 'SafetySupport', tourId: 'TOUR_1', notificationType: 'critical_safety_alert' },
  }, { activeTourId: 'TOUR_1', isDriver: true });
  assert.deepEqual(driverRoute.params, {
    tourId: 'TOUR_1',
    fromNotification: true,
    noticeId: null,
    mode: 'driver',
    from: 'DriverHome',
  });
  assert.equal(resolveNotificationRoute({
    data: { screen: 'SafetySupport', tourId: 'OTHER' },
  }, { activeTourId: 'TOUR_1', isDriver: true }).reason, 'TOUR_MISMATCH');
});

test('global marketing notification routes without an active tour and keeps its category context', () => {
  const response = {
    data: {
      screen: 'NotificationPreferences',
      notificationType: 'category_broadcast',
      categoryKey: 'day_trips',
      broadcastId: 'category-broadcast-1',
    },
  };

  const route = resolveNotificationRoute(response, { activeTourId: null, isDriver: false });
  assert.equal(route.accepted, true);
  assert.equal(route.screen, 'NotificationPreferences');
  assert.deepEqual(route.params, {
    fromNotification: true,
    noticeId: null,
    returnTo: 'TourHome',
    categoryKey: 'day_trips',
    broadcastId: 'category-broadcast-1',
  });
  assert.match(route.responseKey, /category-broadcast-1/);
  assert.equal(resolveNotificationRoute({
    data: {
      screen: 'NotificationPreferences',
      notificationType: 'category_broadcast',
      categoryKey: 'unknown_category',
      broadcastId: 'category-broadcast-2',
    },
  }, {}).reason, 'UNSUPPORTED_MARKETING_CATEGORY');
  assert.equal(resolveNotificationRoute({
    data: {
      screen: 'NotificationPreferences',
      notificationType: 'category_broadcast',
      categoryKey: 'day_trips',
    },
  }, {}).reason, 'INVALID_MARKETING_NOTIFICATION');
});

test('driver Tour Pack notifications route only for the active assigned driver and retain safe change metadata', () => {
  const response = { data: { screen: 'DriverTourPack', tourId: 'TOUR_1', departureKey: '2026-09-10::TOUR_1', revision: 4, changedSections: 'timeline,seats,bad', critical: true, requiresAcknowledgement: true } };
  const accepted = resolveNotificationRoute(response, { activeTourId: 'TOUR_1', isDriver: true });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.params.changedSections, ['timeline', 'seats']);
  assert.equal(accepted.params.requiresAcknowledgement, true);
  assert.equal(resolveNotificationRoute(response, { activeTourId: 'TOUR_1', isDriver: false }).reason, 'DRIVER_ONLY');
  assert.equal(resolveNotificationRoute({ data: { ...response.data, departureKey: '2026-09-10::OTHER' } }, { activeTourId: 'TOUR_1', isDriver: true }).reason, 'DRIVER_PACK_IDENTITY_MISMATCH');
  assert.equal(resolveNotificationRoute({ data: { ...response.data, revision: 0 } }, { activeTourId: 'TOUR_1', isDriver: true }).reason, 'INVALID_DRIVER_PACK_NOTIFICATION');
});

test('driver Tour Pack inbox notices reject malformed identity and PII-bearing notification copy', () => {
  const safe = normalizeTourNotice('pack-1', createNotice({ type: 'driver_tour_pack', screen: 'DriverTourPack', title: 'Operational information changed', body: 'Open the app to review changes.', departureKey: '2026-09-10::TOUR_1', revision: 2, changedSections: 'timeline', critical: true, requiresAcknowledgement: true }));
  assert.equal(safe.departureKey, '2026-09-10::TOUR_1');
  assert.deepEqual(safe.changedSections, ['timeline']);
  assert.equal(normalizeTourNotice('bad-pack', createNotice({ type: 'driver_tour_pack', screen: 'DriverTourPack', departureKey: 'invalid', revision: 2 })), null);
  assert.equal(normalizeTourNotice('pii-pack', createNotice({ type: 'driver_tour_pack', screen: 'DriverTourPack', title: 'Call 07123 456789', departureKey: '2026-09-10::TOUR_1', revision: 2 })), null);
});

test('notification feed subscription combines bounded notices and read state then cleans up both listeners', () => {
  const listeners = new Map();
  const detached = [];
  const makeRef = (path) => ({
    path,
    orderByChild: () => makeRef(path),
    orderByValue: () => makeRef(path),
    limitToLast: () => makeRef(path),
    on: (event, handler) => listeners.set(`${path}:${event}`, handler),
    off: (event, handler) => detached.push({ path, event, handler }),
  });
  const db = { ref: (path = '') => makeRef(path) };
  const updates = [];

  const unsubscribe = subscribeToNotificationFeed({
    tourId: 'TOUR_1',
    userId: 'user-1',
    cacheOwnerId: 'principal-1',
    readStateOwnerId: 'principal-1',
    db,
    auth: null,
    cacheStorage: {
      getItemAsync: async () => null,
      multiSetAsync: async () => true,
    },
    onUpdate: (next) => updates.push(next),
  });

  listeners.get('tour_notifications/TOUR_1:value')({ val: () => ({ notice_1: createNotice() }) });
  assert.equal(updates.length, 0);
  listeners.get('notification_read_state/TOUR_1/principal-1:value')({ val: () => ({}) });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].unreadCount, 1);

  unsubscribe();
  assert.equal(detached.length, 2);
});

test('notification response disposition distinguishes hydration from established rejection', () => {
  const chat = { data: { screen: 'Chat', tourId: 'TOUR_1', messageId: 'message-1' } };
  const transientTour = resolveNotificationRoute(chat, {
    activeTourId: null,
    sessionContextSettled: false,
  });
  assert.equal(transientTour.reason, 'NO_ACTIVE_TOUR');
  assert.equal(transientTour.disposition, NOTIFICATION_RESPONSE_DISPOSITIONS.TRANSIENTLY_DEFERRED);

  const settledTour = resolveNotificationRoute(chat, {
    activeTourId: null,
    sessionContextSettled: true,
  });
  assert.equal(settledTour.reason, 'NO_ACTIVE_TOUR');
  assert.equal(settledTour.disposition, NOTIFICATION_RESPONSE_DISPOSITIONS.DEFINITIVELY_REJECTED);

  const driverPack = { data: {
    screen: 'DriverTourPack', tourId: 'TOUR_1', departureKey: '2026-09-10::TOUR_1', revision: 1,
  } };
  assert.equal(resolveNotificationRoute(driverPack, {
    activeTourId: 'TOUR_1', isDriver: false, roleContextSettled: false,
  }).disposition, NOTIFICATION_RESPONSE_DISPOSITIONS.TRANSIENTLY_DEFERRED);
  assert.equal(resolveNotificationRoute(driverPack, {
    activeTourId: 'TOUR_1', isDriver: false, roleContextSettled: true,
  }).disposition, NOTIFICATION_RESPONSE_DISPOSITIONS.DEFINITIVELY_REJECTED);
});

test('notification detail routes require bounded identifiers, authority and a live expiry', () => {
  const marketing = resolveNotificationRoute({ data: {
    screen: 'MarketingNotificationDetail', notificationType: 'category_broadcast',
    categoryKey: 'day_trips', broadcastId: 'broadcast-1', expiresAtMs: Date.now() + 60_000,
  } }, { hasAuth: true });
  assert.equal(marketing.accepted, true);
  assert.equal(marketing.params.broadcastId, 'broadcast-1');
  assert.equal(resolveNotificationRoute({ data: {
    screen: 'MarketingNotificationDetail', notificationType: 'category_broadcast',
    categoryKey: 'day_trips', broadcastId: 'broadcast-1', expiresAtMs: Date.now() + 60_000,
  } }, { hasAuth: false }).reason, 'NO_AUTH');
  const operationsSafety = resolveNotificationRoute({ data: {
    screen: 'SafetyAlertDetail', tourId: 'TOUR_1', eventId: 'alert-1', expiresAtMs: Date.now() + 60_000,
  } }, { activeTourId: null, hasAuth: true, isDriver: false, sessionContextSettled: true });
  assert.equal(operationsSafety.accepted, true);
  assert.equal(operationsSafety.params.from, 'Login');
  assert.equal(resolveNotificationRoute({ data: {
    screen: 'SafetyAlertDetail', tourId: 'TOUR_1', eventId: 'alert-1', expiresAtMs: Date.now() + 60_000,
  } }, { hasAuth: false, authContextSettled: true }).reason, 'NO_AUTH');
  assert.equal(resolveNotificationRoute({ data: {
    screen: 'SafetyAlertDetail', tourId: 'TOUR_1', eventId: 'alert-1', expiresAtMs: Date.now() - 1,
  } }, { activeTourId: 'TOUR_1', isDriver: true }).reason, 'EXPIRED');
});

test('mobile safety detail exposes escalation and confirms the irreversible resolve action', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'screens', 'SafetyAlertDetailScreen.js'), 'utf8');
  assert.match(source, /updateStatus\('escalate'\)/u);
  assert.match(source, /Alert\.alert\(/u);
  assert.match(source, /Only mark this resolved when the response is complete/u);
  assert.match(source, /onPress: \(\) => updateStatus\('resolve'\)/u);
});

test('notification feed cache is versioned, identity scoped, bounded, and clearable', async () => {
  const values = new Map();
  const storage = {
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
    multiSetAsync: async (entries) => { entries.forEach(([key, value]) => values.set(key, value)); return true; },
    multiDeleteAsync: async (keys) => { keys.forEach((key) => values.delete(key)); return true; },
  };
  const items = buildNotificationFeed({ notice_1: createNotice() }, { notice_1: 1786525300000 });

  await persistNotificationFeedCache({
    tourId: 'TOUR_1',
    userId: 'user-1',
    cacheOwnerId: 'principal-1',
    items,
    storage,
    now: 1786525400000,
  });
  const cached = await loadNotificationFeedCache({
    tourId: 'TOUR_1',
    userId: 'user-1',
    cacheOwnerId: 'principal-1',
    storage,
    now: 1786525401000,
  });

  assert.equal(cached.items.length, 1);
  assert.equal(cached.items[0].isRead, true);
  assert.equal(values.has(feedCacheKey('TOUR_1', 'user-1', 'principal-1')), true);
  assert.equal(await clearNotificationFeedCache({ userId: 'user-1', storage }), 1);
  assert.equal(values.has(feedCacheKey('TOUR_1', 'user-1', 'principal-1')), false);
});

test('notification cache cannot cross application identities that reuse one anonymous auth uid', async () => {
  const values = new Map();
  const storage = {
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
    multiSetAsync: async (entries) => { entries.forEach(([key, value]) => values.set(key, value)); return true; },
    multiDeleteAsync: async (keys) => { keys.forEach((key) => values.delete(key)); return true; },
  };
  const items = buildNotificationFeed({ notice_1: createNotice() }, {});
  await persistNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'shared-auth', cacheOwnerId: 'passenger-a', items, storage, now: 1000,
  });

  assert.equal(await loadNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'shared-auth', cacheOwnerId: 'passenger-b', storage, now: 1100,
  }), null);
  assert.equal((await loadNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'shared-auth', cacheOwnerId: 'passenger-a', storage, now: 1100,
  })).items.length, 1);
});

test('notification cache revocation blocks a late listener write and invalidates orphaned cache data', async () => {
  const values = new Map();
  const storage = {
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
    multiSetAsync: async (entries) => { entries.forEach(([key, value]) => values.set(key, value)); return true; },
    multiDeleteAsync: async (keys) => { keys.forEach((key) => values.delete(key)); return true; },
  };
  const items = buildNotificationFeed({ notice_1: createNotice() }, {});
  await persistNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'revoked-auth', cacheOwnerId: 'passenger-a', items, storage, now: 1000,
    expectedGeneration: 0,
  });
  values.set('index_v1_revoked-auth', '{corrupt');
  await clearNotificationFeedCache({ userId: 'revoked-auth', storage });

  const lateSaved = await persistNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'revoked-auth', cacheOwnerId: 'passenger-a', items, storage, now: 1200,
    expectedGeneration: 0,
  });
  assert.equal(lateSaved, false);
  assert.equal(await loadNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'revoked-auth', cacheOwnerId: 'passenger-a', storage, now: 1300,
  }), null);
});

test('notification cache privacy cleanup retries transient durable storage failures', async () => {
  const values = new Map();
  let generationWriteAttempts = 0;
  let deleteAttempts = 0;
  const storage = {
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => {
      generationWriteAttempts += 1;
      if (generationWriteAttempts < 3) throw new Error('transient generation write failure');
      values.set(key, value);
    },
    multiSetAsync: async (entries) => { entries.forEach(([key, value]) => values.set(key, value)); return true; },
    multiDeleteAsync: async (keys) => {
      deleteAttempts += 1;
      if (deleteAttempts < 2) throw new Error('transient delete failure');
      keys.forEach((key) => values.delete(key));
      return true;
    },
  };
  const items = buildNotificationFeed({ notice_1: createNotice() }, {});
  await persistNotificationFeedCache({
    tourId: 'TOUR_1', userId: 'privacy-retry-auth', cacheOwnerId: 'passenger-a', items, storage, now: 1000,
  });

  await clearNotificationFeedCache({ userId: 'privacy-retry-auth', storage });

  assert.equal(generationWriteAttempts, 3);
  assert.equal(deleteAttempts, 2);
  assert.equal(values.has(feedCacheKey('TOUR_1', 'privacy-retry-auth', 'passenger-a')), false);
});

test('notification feed presents cached updates and preserves them when one live listener fails', async () => {
  const listeners = new Map();
  const errors = new Map();
  const makeRef = (path) => ({
    orderByChild: () => makeRef(path),
    orderByValue: () => makeRef(path),
    limitToLast: () => makeRef(path),
    on: (event, handler, errorHandler) => {
      listeners.set(`${path}:${event}`, handler);
      errors.set(`${path}:${event}`, errorHandler);
    },
    off: () => {},
  });
  const cachedItems = buildNotificationFeed({ notice_1: createNotice() }, {});
  const cacheStorage = {
    getItemAsync: async (key) => key.startsWith('feed_v1_') ? JSON.stringify({
      version: 1,
      tourId: 'TOUR_1',
      userId: 'user-recovery',
      cacheOwnerId: 'passenger-recovery',
      generation: 0,
      cachedAtMs: 1786525400000,
      items: cachedItems,
    }) : null,
    multiSetAsync: async () => true,
  };
  const updates = [];
  const failures = [];

  const unsubscribe = subscribeToNotificationFeed({
    tourId: 'TOUR_1',
    userId: 'user-recovery',
    cacheOwnerId: 'passenger-recovery',
    db: { ref: (path = '') => makeRef(path) },
    auth: null,
    cacheStorage,
    now: 1786525401000,
    onUpdate: (value) => updates.push(value),
    onError: (error, recovery) => failures.push({ error, recovery }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  errors.get('notification_read_state/TOUR_1/passenger-recovery:value')(new Error('offline'));

  assert.equal(updates[0].source, 'cache');
  assert.equal(updates[0].stale, true);
  assert.equal(updates[0].items.length, 1);
  assert.equal(failures[0].recovery.hasPersistedCache, true);
  unsubscribe();
});

test('notification read mutations are scoped to the active tour and canonical principal path', async () => {
  const writes = [];
  const db = {
    ref: (path = '') => ({
      set: async (value) => writes.push({ type: 'set', path, value }),
      update: async (value) => writes.push({ type: 'update', path, value }),
    }),
  };

  await markNotificationRead({
    tourId: 'TOUR_1',
    userId: 'shared-auth',
    readStateOwnerId: 'passenger-a',
    noticeId: 'notice-1',
    db,
    auth: null,
    now: 1000,
  });
  const count = await markAllNotificationsRead({
    tourId: 'TOUR_1',
    userId: 'shared-auth',
    readStateOwnerId: 'passenger-a',
    noticeIds: ['notice-1', 'notice-2', 'notice-2'],
    db,
    auth: null,
    now: 2000,
  });

  assert.equal(count, 2);
  assert.deepEqual(writes[0], {
    type: 'set',
    path: 'notification_read_state/TOUR_1/passenger-a/notice-1',
    value: 1000,
  });
  assert.deepEqual(writes[1].value, {
    'notification_read_state/TOUR_1/passenger-a/notice-1': 2000,
    'notification_read_state/TOUR_1/passenger-a/notice-2': 2000,
  });
});

test('notification read-state migration requests are exact and skipped for legacy UID principals', async () => {
  const writes = [];
  const db = { ref: (path) => ({ set: async (value) => writes.push({ path, value }) }) };
  assert.equal(await requestNotificationReadStateMigration({
    tourId: 'TOUR_1',
    userId: 'shared-auth',
    readStateOwnerId: 'passenger-a',
    db,
    auth: null,
    now: 1234,
  }), true);
  assert.deepEqual(writes, [{
    path: 'notification_read_migration_requests/TOUR_1/shared-auth',
    value: { version: 1, principalId: 'passenger-a', requestedAtMs: 1234 },
  }]);
  assert.equal(await requestNotificationReadStateMigration({
    tourId: 'TOUR_1',
    userId: 'shared-auth',
    readStateOwnerId: 'shared-auth',
    db,
    auth: null,
    now: 1235,
  }), false);
  assert.equal(writes.length, 1);
});

test('cache clearing revokes live listeners before they can recreate passenger data', async () => {
  const values = new Map();
  const listeners = new Map();
  const detached = [];
  const storage = {
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    multiSetAsync: async (entries) => { entries.forEach(([key, value]) => values.set(key, value)); return true; },
    multiDeleteAsync: async (keys) => { keys.forEach((key) => values.delete(key)); return true; },
  };
  const makeRef = (path) => ({
    orderByChild: () => makeRef(path),
    orderByValue: () => makeRef(path),
    limitToLast: () => makeRef(path),
    on: (event, handler) => listeners.set(`${path}:${event}`, handler),
    off: (event, handler) => detached.push({ path, event, handler }),
  });
  const updates = [];

  subscribeToNotificationFeed({
    tourId: 'TOUR_1',
    userId: 'logout-race-auth',
    cacheOwnerId: 'passenger-a',
    readStateOwnerId: 'passenger-a',
    db: { ref: (path = '') => makeRef(path) },
    auth: null,
    cacheStorage: storage,
    onUpdate: (value) => updates.push(value),
  });
  const noticeHandler = listeners.get('tour_notifications/TOUR_1:value');
  const readHandler = listeners.get('notification_read_state/TOUR_1/passenger-a:value');
  noticeHandler({ val: () => ({ notice_1: createNotice() }) });
  readHandler({ val: () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1);

  await clearNotificationFeedCache({ userId: 'logout-race-auth', storage });
  noticeHandler({ val: () => ({ notice_2: createNotice({ sourceId: 'broadcast_2' }) }) });
  readHandler({ val: () => ({ notice_2: 2000 }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updates.length, 1);
  assert.equal(detached.length, 2);
  assert.equal(values.has(feedCacheKey('TOUR_1', 'logout-race-auth', 'passenger-a')), false);
});
