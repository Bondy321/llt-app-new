const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-chat-delivery',
  storageBucket: 'demo-llt-chat-delivery.appspot.com',
});

const { __testables } = require('../functions/index.js');
const { resolveNotificationRoute } = require('../utils/notificationRouting');

test('notification validation accepts captionless image messages but rejects malformed images', () => {
  const base = {
    senderId: 'driver:BONDY',
    senderStableId: 'driver:BONDY',
    senderName: 'Driver Bondy',
    text: '',
    type: 'image',
  };

  assert.equal(__testables.validateMessageData({ ...base, imageUrl: 'https://example.com/photo.jpg' }).valid, true);
  assert.equal(__testables.validateMessageData(base).valid, false);
  assert.equal(__testables.validateMessageData({ ...base, type: 'text' }).valid, false);
});

test('captionless photo notifications use a useful passenger-facing preview', () => {
  assert.deepEqual(__testables.buildChatNotificationContent({
    tourName: 'Highland Explorer',
    messageData: { senderName: 'Alex', type: 'image', text: '' },
  }), {
    title: 'New message in Highland Explorer',
    body: 'Alex: Shared a photo',
  });
});

test('chat sender delivery resolution recognizes passengers and coherently assigned drivers', async () => {
  const passengerIds = await __testables.resolveChatSenderDeliveryIds({
    tourId: 'TOUR_1',
    participants: { 'passenger-auth': true },
    messageData: { senderId: 'pax:1', senderStableId: 'pax:1' },
    loadIdentityBindings: async () => ({ 'passenger-auth': true, outsider: true }),
  });
  assert.deepEqual(passengerIds, ['passenger-auth']);

  const driverIds = await __testables.resolveChatSenderDeliveryIds({
    tourId: 'TOUR_1',
    manifestData: { assigned_drivers: { BONDY: true } },
    messageData: { senderId: 'driver:BONDY', senderStableId: 'driver:BONDY', isDriver: true },
    loadProfile: async () => ({ authUid: 'driver-auth', currentTourId: 'TOUR_1' }),
  });
  assert.deepEqual(driverIds, ['driver-auth']);

  const staleDriverIds = await __testables.resolveChatSenderDeliveryIds({
    tourId: 'TOUR_1',
    manifestData: { assigned_drivers: { BONDY: true } },
    messageData: { senderId: 'driver:BONDY', senderStableId: 'driver:BONDY', isDriver: true },
    loadProfile: async () => ({ authUid: 'driver-auth', currentTourId: 'OTHER_TOUR' }),
  });
  assert.deepEqual(staleDriverIds, []);
});

test('internal driver chat push navigation opens the internal chat and exact message', () => {
  assert.deepEqual(__testables.buildPushNavigationData({
    screen: 'Chat',
    tourId: 'TOUR_1',
    messageId: 'msg-1',
    notificationType: 'internal_chat_message',
    internalDriverChat: true,
    timestamp: 123,
  }), {
    screen: 'Chat',
    tourId: 'TOUR_1',
    messageId: 'msg-1',
    notificationType: 'internal_chat_message',
    internalDriverChat: true,
    timestamp: 123,
  });
});

test('real notification producers create payloads accepted by the mobile router', () => {
  const chatPayload = __testables.buildPushNavigationData({
    screen: 'Chat',
    tourId: 'TOUR_1',
    messageId: 'msg-1',
    notificationType: 'chat_message',
  });
  assert.equal(Number.isSafeInteger(chatPayload.timestamp), true);
  assert.deepEqual(resolveNotificationRoute({ data: chatPayload }, {
    activeTourId: 'TOUR_1',
    isDriver: false,
  }), {
    accepted: true,
    screen: 'Chat',
    params: {
      tourId: 'TOUR_1',
      fromNotification: true,
      noticeId: null,
      messageId: 'msg-1',
      isDriver: false,
      internalDriverChat: false,
    },
    responseKey: 'msg-1',
  });

  const broadcastPayload = __testables.buildPushNavigationData({
    screen: 'NotificationPreferences',
    notificationType: 'category_broadcast',
    categoryKey: 'day_trips',
    broadcastId: 'broadcast-1',
  });
  assert.deepEqual(resolveNotificationRoute({ data: broadcastPayload }, {
    activeTourId: null,
    isDriver: false,
  }), {
    accepted: true,
    screen: 'NotificationPreferences',
    params: {
      fromNotification: true,
      noticeId: null,
      returnTo: 'TourHome',
      categoryKey: 'day_trips',
      broadcastId: 'broadcast-1',
    },
    responseKey: `NotificationPreferences:unknown:unknown:unknown:broadcast-1:day_trips:${broadcastPayload.timestamp}`,
  });

  const driverPackPayload = __testables.buildPushNavigationData({
    screen: 'DriverTourPack',
    tourId: '5001D_1',
    departureKey: '2026-09-10::5001D_1',
    revision: 4,
    changedSections: ['pickups', 'timeline'],
    notificationType: 'driver_tour_pack',
  });
  assert.deepEqual(resolveNotificationRoute({ data: driverPackPayload }, {
    activeTourId: '5001D_1',
    isDriver: true,
  }), {
    accepted: true,
    screen: 'DriverTourPack',
    params: {
      tourId: '5001D_1',
      fromNotification: true,
      noticeId: null,
      departureKey: '2026-09-10::5001D_1',
      revision: 4,
      changedSections: ['pickups', 'timeline'],
      critical: false,
      requiresAcknowledgement: false,
    },
    responseKey: `DriverTourPack:5001D_1:unknown:unknown:unknown:unknown:${driverPackPayload.timestamp}`,
  });
});

test('mobile notification routing rejects credentials, unknown fields, and invalid timestamps', () => {
  const validPayload = __testables.buildPushNavigationData({
    screen: 'Chat',
    tourId: 'TOUR_1',
    messageId: 'msg-1',
    timestamp: 123,
  });
  const forbiddenFields = ['bookingRef', 'email', 'phone', 'signedUrl', 'token', 'unsupported'];
  forbiddenFields.forEach((field) => {
    assert.equal(resolveNotificationRoute({
      data: { ...validPayload, [field]: 'secret' },
    }, { activeTourId: 'TOUR_1' }).reason, 'INVALID_PAYLOAD', field);
  });
  ['123', 0, -1, 1.5, null].forEach((timestamp) => {
    assert.equal(resolveNotificationRoute({
      data: { ...validPayload, timestamp },
    }, { activeTourId: 'TOUR_1' }).reason, 'INVALID_PAYLOAD', String(timestamp));
  });
});
