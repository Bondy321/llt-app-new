const test = require('node:test');
const assert = require('node:assert');
const { normalizeSearchQuery, buildChatSearchResults } = require('../utils/chatSearch');

test('normalizeSearchQuery trims and lowercases', () => {
  assert.equal(normalizeSearchQuery('  HelLo  '), 'hello');
  assert.equal(normalizeSearchQuery(''), '');
  assert.equal(normalizeSearchQuery(null), '');
});

test('buildChatSearchResults matches sender names and message text', () => {
  const results = buildChatSearchResults(
    [
      { id: 'm1', text: 'Meet at 8 AM by the loch', senderName: 'Driver Alex' },
      { id: 'm2', text: 'Thanks for the update', senderName: 'Sam' },
      { id: 'm3', text: 'Loch view is unreal', senderName: 'Ari' },
    ],
    'loch'
  );

  assert.deepEqual(results, [
    { id: 'm1', matchCount: 1 },
    { id: 'm3', matchCount: 1 },
  ]);
});

test('buildChatSearchResults counts repeated matches', () => {
  const results = buildChatSearchResults(
    [{ id: 'm1', text: 'bus bus BUS', senderName: 'Bus Driver' }],
    'bus'
  );

  assert.deepEqual(results, [{ id: 'm1', matchCount: 4 }]);
});
