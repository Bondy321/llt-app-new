const test = require('node:test');
const assert = require('node:assert');
const { sendMessage } = require('../services/chatService');

const createMockRealtimeDb = () => {
  const refCalls = [];

  return {
    refCalls,
    ref(path) {
      const context = { path, setCalls: [], pushCalls: [] };

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
  assert.deepEqual(refCall.setCalls[0], {
    text: 'Hello',
    senderName: 'Alex',
    senderId: 'user-1',
    timestamp: result.message.timestamp,
    isDriver: true,
  });
});

test('sendMessage rejects empty content', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await sendMessage('tour-abc', '   ', { name: 'Tester' }, mockDb);

  assert.equal(result.success, false);
  assert.ok(mockDb.refCalls.length === 0);
});
