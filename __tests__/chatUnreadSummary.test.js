const test = require('node:test');
const assert = require('node:assert');
const { buildUnreadSummary, formatRelativeTimeLabel, parseTimestampMs } = require('../utils/chatUnreadSummary');

test('parseTimestampMs supports numeric and ISO strings', () => {
  assert.equal(parseTimestampMs(1700000000000), 1700000000000);
  assert.equal(parseTimestampMs('1700000000000'), 1700000000000);
  assert.ok(Number.isFinite(parseTimestampMs('2026-03-26T09:00:00.000Z')));
  assert.equal(parseTimestampMs('not-a-date'), null);
});

test('formatRelativeTimeLabel formats expected buckets', () => {
  const now = Date.parse('2026-03-26T12:00:00.000Z');

  assert.equal(formatRelativeTimeLabel('2026-03-26T11:59:30.000Z', now), 'just now');
  assert.equal(formatRelativeTimeLabel('2026-03-26T11:52:00.000Z', now), '8m ago');
  assert.equal(formatRelativeTimeLabel('2026-03-26T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelativeTimeLabel('2026-03-25T11:00:00.000Z', now), 'yesterday');
});

test('buildUnreadSummary excludes self messages and returns latest sender metadata', () => {
  const messages = [
    { id: 'm-1', senderId: 'driver-1', senderName: 'Driver Bondy', timestamp: '2026-03-26T10:00:00.000Z' },
    { id: 'm-2', senderId: 'user-5', senderName: 'Alex', timestamp: '2026-03-26T10:05:00.000Z' },
    { id: 'm-3', senderId: 'me-22', senderName: 'You', timestamp: '2026-03-26T10:07:00.000Z' },
    { id: 'm-4', senderId: 'user-8', senderName: 'Sam', timestamp: '2026-03-26T10:08:00.000Z' },
  ];

  const summary = buildUnreadSummary(messages, {
    lastSeenTimestamp: '2026-03-26T10:03:00.000Z',
    currentUserId: 'me-22',
    now: Date.parse('2026-03-26T10:10:00.000Z'),
  });

  assert.deepEqual(summary, {
    count: 2,
    latestSender: 'Sam',
    latestTimestamp: '2026-03-26T10:08:00.000Z',
    latestRelativeLabel: '2m ago',
  });
});

test('buildUnreadSummary returns null when lastSeen timestamp is unavailable', () => {
  const summary = buildUnreadSummary(
    [{ id: 'm-1', senderId: 'u-1', senderName: 'Alex', timestamp: '2026-03-26T10:00:00.000Z' }],
    { lastSeenTimestamp: null, currentUserId: 'u-2' }
  );

  assert.equal(summary, null);
});
