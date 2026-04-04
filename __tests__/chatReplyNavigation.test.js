const test = require('node:test');
const assert = require('node:assert');

const {
  stripReplyIdDecorators,
  collectMessageIdCandidates,
  buildReplyTargetIndex,
  resolveReplyTargetIndex,
} = require('../utils/chatReplyNavigation');

test('stripReplyIdDecorators normalizes prefixed and path-like ids', () => {
  assert.equal(stripReplyIdDecorators('message-msg-42'), 'msg-42');
  assert.equal(stripReplyIdDecorators('message-message-msg-42'), 'msg-42');
  assert.equal(stripReplyIdDecorators('chats/tour-1/messages/msg-99'), 'msg-99');
});

test('collectMessageIdCandidates supports legacy prefixed and canonical ids', () => {
  const candidates = collectMessageIdCandidates('message-msg-42');
  assert.deepEqual(candidates.sort(), ['message-msg-42', 'msg-42']);

  const canonical = collectMessageIdCandidates('msg-77');
  assert.deepEqual(canonical.sort(), ['message-msg-77', 'msg-77']);
});

test('resolveReplyTargetIndex resolves using message id and idempotency key aliases', () => {
  const groupedMessages = [
    { type: 'date', id: 'date-row' },
    {
      type: 'message',
      id: 'message-msg-1',
      data: { id: 'msg-1', text: 'First', idempotencyKey: 'offline-a' },
    },
    {
      type: 'message',
      id: 'message-msg-2',
      data: { id: 'msg-2', text: 'Second', idempotencyKey: 'offline-b' },
    },
  ];

  const replyIndex = buildReplyTargetIndex(groupedMessages);

  assert.equal(resolveReplyTargetIndex('msg-1', replyIndex), 1);
  assert.equal(resolveReplyTargetIndex('message-msg-1', replyIndex), 1);
  assert.equal(resolveReplyTargetIndex('offline-b', replyIndex), 2);
  assert.equal(resolveReplyTargetIndex('message-offline-b', replyIndex), 2);
  assert.equal(resolveReplyTargetIndex('chats/tour/messages/offline-b', replyIndex), 2);
  assert.equal(resolveReplyTargetIndex('missing-id', replyIndex), -1);
});
