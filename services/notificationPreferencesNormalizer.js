const DEFAULT_NOTIFICATION_PREFERENCES = {
  ops: {
    driver_updates: true,
    itinerary_changes: true,
    group_chat: true,
    group_photos: false,
  },
  marketing: {
    steam_trains: false,
    mystery_tours: false,
    scotland_classics: false,
    vip_experiences: false,
    hiking_nature: false,
  },
};

const DEFAULT_LEGACY_NOTIFICATION_FLAGS = {
  chatNotifications: true,
  itineraryNotifications: true,
};

const extractPreferenceSource = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {};
  }

  return (
    preferences.preferences ||
    preferences.notificationPreferences ||
    preferences.notifications ||
    preferences
  );
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const toBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'enabled' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === 'disabled' || normalized === 'off') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
};

const normalizeNotificationPreferences = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {
      ...DEFAULT_LEGACY_NOTIFICATION_FLAGS,
      ops: { ...DEFAULT_NOTIFICATION_PREFERENCES.ops },
      marketing: { ...DEFAULT_NOTIFICATION_PREFERENCES.marketing },
    };
  }

  const source = extractPreferenceSource(preferences);

  const chatRaw =
    source.chatNotifications ??
    source.chatNotification ??
    source.chat ??
    source.messages ??
    source.messageNotifications;

  const itineraryRaw =
    source.itineraryNotifications ??
    source.itineraryNotification ??
    source.itinerary ??
    source.schedule ??
    source.tripUpdates;

  const normalizedOps = {
    driver_updates: toBoolean(
      source?.ops?.driver_updates,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.driver_updates
    ),
    itinerary_changes: toBoolean(
      source?.ops?.itinerary_changes ?? itineraryRaw,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.itinerary_changes
    ),
    group_chat: toBoolean(
      source?.ops?.group_chat ?? chatRaw,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_chat
    ),
    group_photos: toBoolean(
      source?.ops?.group_photos,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_photos
    ),
  };

  const normalizedMarketing = {
    steam_trains: toBoolean(
      source?.marketing?.steam_trains,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.steam_trains
    ),
    mystery_tours: toBoolean(
      source?.marketing?.mystery_tours,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.mystery_tours
    ),
    scotland_classics: toBoolean(
      source?.marketing?.scotland_classics,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.scotland_classics
    ),
    vip_experiences: toBoolean(
      source?.marketing?.vip_experiences,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.vip_experiences
    ),
    hiking_nature: toBoolean(
      source?.marketing?.hiking_nature,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.hiking_nature
    ),
  };

  const normalizedLegacy = {
    chatNotifications: normalizedOps.group_chat,
    itineraryNotifications: normalizedOps.itinerary_changes,
  };

  return {
    ...normalizedLegacy,
    ops: normalizedOps,
    marketing: normalizedMarketing,
  };
};

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_LEGACY_NOTIFICATION_FLAGS,
  extractPreferenceSource,
  hasOwn,
  normalizeNotificationPreferences,
};
