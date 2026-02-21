const test = require('node:test');
const assert = require('node:assert');
const { sendMessage, markChatAsRead, markInternalChatAsRead } = require('../services/chatService');

const createMockRealtimeDb = () => {
  const refCalls = [];

  return {
    refCalls,
    ref(path) {
      const context = { path, setCalls: [], pushCalls: [] };

      context.set = async (value) => {
        context.setCalls.push(value);
        return value;
      };

      context.push = () => {
        const key = `msg-${context.pushCalls.length + 1}`;
        const refObject = {
          key,
          async set(value) {
            context.setCalls.push(value);
            return value;
          },
        };

        context.pushCalls.push(refObject);
        return refObject;
      };

      refCalls.push(context);
      return context;
    },
  };
};

test('sendMessage builds payload with sender info and driver flag', async () => {
  const mockDb = createMockRealtimeDb();
  const senderInfo = { name: 'Alex', userId: 'user-1', isDriver: true };

  const result = await sendMessage('tour-123', ' Hello ', senderInfo, mockDb);

  assert.equal(result.success, true);
  assert.ok(result.message.id);
  assert.equal(result.message.text, 'Hello');
  assert.equal(result.message.senderName, 'Alex');
  assert.equal(result.message.senderId, 'user-1');
  assert.equal(result.message.isDriver, true);
  assert.ok(new Date(result.message.timestamp).getTime());

  const refCall = mockDb.refCalls[0];
  assert.ok(refCall);
  assert.equal(refCall.setCalls[0].text, 'Hello');
  assert.equal(refCall.setCalls[0].senderName, 'Alex');
  assert.equal(refCall.setCalls[0].senderId, 'user-1');
  assert.equal(refCall.setCalls[0].timestamp, result.message.timestamp);
  assert.equal(refCall.setCalls[0].isDriver, true);
});

test('sendMessage rejects empty content', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await sendMessage('tour-abc', '   ', { name: 'Tester' }, mockDb);

  assert.equal(result.success, false);
  assert.ok(mockDb.refCalls.length === 0);
});


test('markChatAsRead writes timestamp to chat lastRead path', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await markChatAsRead('tour-77', 'user-22', mockDb);

  assert.equal(result.success, true);
  const refCall = mockDb.refCalls[0];
  assert.equal(refCall.path, 'chats/tour-77/lastRead/user-22');
  assert.ok(new Date(refCall.setCalls[0]).getTime());
});

test('markInternalChatAsRead writes timestamp to internal chat lastRead path', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await markInternalChatAsRead('tour-88', 'driver-3', mockDb);

  assert.equal(result.success, true);
  const refCall = mockDb.refCalls[0];
  assert.equal(refCall.path, 'internal_chats/tour-88/lastRead/driver-3');
  assert.ok(new Date(refCall.setCalls[0]).getTime());
});
