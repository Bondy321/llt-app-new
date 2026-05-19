const test = require('node:test');
const assert = require('node:assert');
const {
  buildChatTimelineItems,
  getOldestMessageCursor,
  mergeMessagesById,
  shouldShowSenderForMessage,
} = require('../utils/chatTimeline');

test('buildChatTimelineItems groups by date and injects unread separator once', () => {
  const messages = [
    { id: 'a', senderId: 'user-a', senderName: 'A', timestamp: '2026-03-18T09:00:00.000Z', text: 'before' },
    { id: 'b', senderId: 'user-b', senderName: 'B', timestamp: '2026-03-18T09:05:00.000Z', text: 'after' },
    { id: 'c', senderId: 'user-b', senderName: 'B', timestamp: '2026-03-19T09:00:00.000Z', text: 'next day' },
  ];

  const timeline = buildChatTimelineItems(messages, {
    lastSeenTimestamp: '2026-03-18T09:02:00.000Z',
    isMessageOwned: (message) => message.senderId === 'user-a',
  });

  assert.equal(timeline.filter((item) => item.type === 'date').length, 2);
  assert.equal(timeline.filter((item) => item.type === 'unread-separator').length, 1);
  assert.deepEqual(
    timeline.filter((item) => item.type === 'message').map((item) => item.data.id),
    ['a', 'b', 'c']
  );
});

test('shouldShowSenderForMessage only shows first incoming message in a short sender cluster', () => {
  const first = { id: 'first', senderId: 'guide-1', senderName: 'Guide', timestamp: '2026-03-18T09:00:00.000Z' };
  const second = { id: 'second', senderId: 'guide-1', senderName: 'Guide', timestamp: '2026-03-18T09:04:00.000Z' };
  const later = { id: 'later', senderId: 'guide-1', senderName: 'Guide', timestamp: '2026-03-18T09:10:30.000Z' };

  assert.equal(shouldShowSenderForMessage(first, null, { isOwnMessage: false }), true);
  assert.equal(shouldShowSenderForMessage(second, first, { isOwnMessage: false, previousIsOwnMessage: false }), false);
  assert.equal(shouldShowSenderForMessage(later, second, { isOwnMessage: false, previousIsOwnMessage: false }), true);
});

test('mergeMessagesById de-dupes optimistic and server messages by idempotency key', () => {
  const existing = [
    { id: 'local-1', idempotencyKey: 'msg-1', text: 'Hello', status: 'sending', timestamp: '2026-03-18T09:00:00.000Z' },
    { id: 'other', text: 'Other', status: 'sent', timestamp: '2026-03-18T09:01:00.000Z' },
  ];
  const incoming = [
    { id: 'msg-1', idempotencyKey: 'msg-1', text: 'Hello', status: 'sent', timestamp: '2026-03-18T09:00:01.000Z' },
  ];

  const merged = mergeMessagesById(existing, incoming);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'msg-1');
  assert.equal(merged[0].status, 'sent');
  assert.deepEqual(merged.map((message) => message.id), ['msg-1', 'other']);
});

test('getOldestMessageCursor uses the oldest message after sorting ascending', () => {
  const cursor = getOldestMessageCursor([
    { id: 'newer', timestamp: '2026-03-18T10:00:00.000Z' },
    { id: 'older', timestamp: '2026-03-18T09:00:00.000Z' },
  ]);

  assert.deepEqual(cursor, {
    beforeTimestamp: '2026-03-18T09:00:00.000Z',
    beforeMessageId: 'older',
  });
});
