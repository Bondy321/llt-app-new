const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNotificationFeed,
  markAllNotificationsRead,
  markNotificationRead,
  normalizeTourNotice,
  subscribeToNotificationFeed,
} = require('../services/notificationInboxService');
const {
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
    limitToLast: () => makeRef(path),
    on: (event, handler) => listeners.set(`${path}:${event}`, handler),
    off: (event, handler) => detached.push({ path, event, handler }),
  });
  const db = { ref: (path = '') => makeRef(path) };
  const updates = [];

  const unsubscribe = subscribeToNotificationFeed({
    tourId: 'TOUR_1',
    userId: 'user-1',
    db,
    auth: null,
    onUpdate: (next) => updates.push(next),
  });

  listeners.get('tour_notifications/TOUR_1:value')({ val: () => ({ notice_1: createNotice() }) });
  assert.equal(updates.length, 0);
  listeners.get('notification_read_state/TOUR_1/user-1:value')({ val: () => ({}) });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].unreadCount, 1);

  unsubscribe();
  assert.equal(detached.length, 2);
});

test('notification read mutations are scoped to the active tour and authenticated user path', async () => {
  const writes = [];
  const db = {
    ref: (path = '') => ({
      set: async (value) => writes.push({ type: 'set', path, value }),
      update: async (value) => writes.push({ type: 'update', path, value }),
    }),
  };

  await markNotificationRead({ tourId: 'TOUR_1', userId: 'user-1', noticeId: 'notice-1', db, auth: null, now: 1000 });
  const count = await markAllNotificationsRead({
    tourId: 'TOUR_1',
    userId: 'user-1',
    noticeIds: ['notice-1', 'notice-2', 'notice-2'],
    db,
    auth: null,
    now: 2000,
  });

  assert.equal(count, 2);
  assert.deepEqual(writes[0], {
    type: 'set',
    path: 'notification_read_state/TOUR_1/user-1/notice-1',
    value: 1000,
  });
  assert.deepEqual(writes[1].value, {
    'notification_read_state/TOUR_1/user-1/notice-1': 2000,
    'notification_read_state/TOUR_1/user-1/notice-2': 2000,
  });
});
