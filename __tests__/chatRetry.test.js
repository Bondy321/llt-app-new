const test = require('node:test');
const assert = require('node:assert');
const { canRetryFailedMessage } = require('../utils/chatRetry');

test('canRetryFailedMessage returns true for failed text messages authored by current user', () => {
  const result = canRetryFailedMessage(
    {
      id: 'msg-1',
      senderId: 'user-1',
      status: 'failed',
      type: 'text',
      text: 'Bus is delayed 5 mins',
    },
    'user-1'
  );

  assert.equal(result, true);
});

test('canRetryFailedMessage rejects non-failed or non-text messages', () => {
  assert.equal(
    canRetryFailedMessage(
      { id: 'msg-2', senderId: 'user-1', status: 'sent', type: 'text', text: 'Done' },
      'user-1'
    ),
    false
  );

  assert.equal(
    canRetryFailedMessage(
      { id: 'msg-3', senderId: 'user-1', status: 'failed', type: 'image', text: 'Photo' },
      'user-1'
    ),
    false
  );
});

test('canRetryFailedMessage rejects messages not authored by the active user', () => {
  const result = canRetryFailedMessage(
    { id: 'msg-4', senderId: 'user-2', status: 'failed', type: 'text', text: 'Need pickup' },
    'user-1'
  );

  assert.equal(result, false);
});
