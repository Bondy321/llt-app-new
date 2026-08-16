const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-chat-delivery',
  storageBucket: 'demo-llt-chat-delivery.appspot.com',
});

const { __testables } = require('../functions/index.js');

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
