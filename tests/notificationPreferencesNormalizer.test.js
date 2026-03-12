const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  extractPreferenceSource,
  hasOwn,
  normalizeNotificationPreferences,
} = require('../services/notificationPreferencesNormalizer');

test('normalizeNotificationPreferences returns defaults for non-object input', () => {
  const normalized = normalizeNotificationPreferences(null);

  assert.equal(normalized.chatNotifications, true);
  assert.equal(normalized.itineraryNotifications, true);
  assert.deepEqual(normalized.ops, DEFAULT_NOTIFICATION_PREFERENCES.ops);
  assert.deepEqual(normalized.marketing, DEFAULT_NOTIFICATION_PREFERENCES.marketing);
});

test('normalizeNotificationPreferences maps legacy toggles to canonical ops fields', () => {
  const normalized = normalizeNotificationPreferences({
    chatNotifications: false,
    itineraryNotifications: false,
  });

  assert.equal(normalized.ops.group_chat, false);
  assert.equal(normalized.ops.itinerary_changes, false);
  assert.equal(normalized.chatNotifications, false);
  assert.equal(normalized.itineraryNotifications, false);
});

test('normalizeNotificationPreferences handles nested wrappers and coercion', () => {
  const normalized = normalizeNotificationPreferences({
    preferences: {
      ops: {
        group_photos: 'ON',
      },
      marketing: {
        steam_trains: 1,
        hiking_nature: 0,
      },
      messageNotifications: 'disabled',
      tripUpdates: 'enabled',
    },
  });

  assert.equal(normalized.ops.group_chat, false);
  assert.equal(normalized.ops.itinerary_changes, true);
  assert.equal(normalized.ops.group_photos, true);
  assert.equal(normalized.marketing.steam_trains, true);
  assert.equal(normalized.marketing.hiking_nature, false);
});

test('extractPreferenceSource unwraps preferences envelope and hasOwn remains safe', () => {
  const source = extractPreferenceSource({
    notificationPreferences: { ops: { group_chat: false } },
  });

  assert.equal(source.ops.group_chat, false);
  assert.equal(hasOwn(source, 'ops'), true);
  assert.equal(hasOwn(null, 'ops'), false);
});
