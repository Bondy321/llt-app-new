export const TOUR_NOTIFICATION_CATEGORIES = [
  {
    key: 'day_trips',
    label: 'Day Trips',
    description: 'Short escapes, scenic days out, and easy coach trips.',
    icon: 'calendar-today',
  },
  {
    key: 'mystery_breaks',
    label: 'Mystery Breaks',
    description: 'Surprise destinations and hand-picked short breaks.',
    icon: 'incognito',
  },
  {
    key: 'scotland_highlands_islands',
    label: 'Scotland, Highlands & Islands',
    description: 'Lochs, castles, coastlines, islands, and Highland routes.',
    icon: 'image-filter-hdr',
  },
  {
    key: 'isle_of_ireland',
    label: 'Isle of Ireland',
    description: 'Breaks across Ireland, Northern Ireland, and coastal routes.',
    icon: 'leaf-maple',
  },
  {
    key: 'european_breaks',
    label: 'European Breaks',
    description: 'Continental holidays, city breaks, and seasonal escapes.',
    icon: 'earth',
  },
  {
    key: 'steam_train_tours',
    label: 'Steam Train Tours',
    description: 'Heritage rail journeys and scenic steam train experiences.',
    icon: 'train',
  },
  {
    key: 'cruises_ferries',
    label: 'Cruises & Ferries',
    description: 'Sailings, ferry-inclusive holidays, and waterside breaks.',
    icon: 'ferry',
  },
  {
    key: 'theatre_concerts',
    label: 'Theatre & Concerts',
    description: 'Shows, concerts, entertainment trips, and event packages.',
    icon: 'theater',
  },
  {
    key: 'sporting_breaks',
    label: 'Sporting Breaks',
    description: 'Sport fixtures, race days, and special sporting events.',
    icon: 'trophy-outline',
  },
  {
    key: 'history_military_breaks',
    label: 'History & Military Breaks',
    description: 'Battlefields, museums, heritage sites, and military history.',
    icon: 'shield-cross-outline',
  },
];

export const TOUR_NOTIFICATION_CATEGORY_KEYS = TOUR_NOTIFICATION_CATEGORIES.map((category) => category.key);

export const DEFAULT_MARKETING_PREFERENCES = TOUR_NOTIFICATION_CATEGORY_KEYS.reduce((preferences, key) => {
  preferences[key] = false;
  return preferences;
}, {});

export const LEGACY_MARKETING_PREFERENCE_ALIASES = {
  mystery_breaks: ['mystery_tours'],
  scotland_highlands_islands: ['scotland_classics', 'hiking_nature'],
  steam_train_tours: ['steam_trains'],
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

export const parsePreferenceBoolean = (value, fallback) => {
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

export const hasMarketingPreferenceInput = (marketingSource, categoryKey) => {
  if (!marketingSource || typeof marketingSource !== 'object') {
    return false;
  }

  if (hasOwn(marketingSource, categoryKey)) {
    return true;
  }

  return (LEGACY_MARKETING_PREFERENCE_ALIASES[categoryKey] || []).some((legacyKey) => (
    hasOwn(marketingSource, legacyKey)
  ));
};

export const readMarketingPreferenceInput = (marketingSource, categoryKey, fallback = false) => {
  if (!marketingSource || typeof marketingSource !== 'object') {
    return fallback;
  }

  if (hasOwn(marketingSource, categoryKey)) {
    return parsePreferenceBoolean(marketingSource[categoryKey], fallback);
  }

  const legacyKeys = LEGACY_MARKETING_PREFERENCE_ALIASES[categoryKey] || [];
  for (const legacyKey of legacyKeys) {
    if (hasOwn(marketingSource, legacyKey)) {
      return parsePreferenceBoolean(marketingSource[legacyKey], fallback);
    }
  }

  return fallback;
};

export const normalizeMarketingPreferences = (marketingSource = {}, fallbackPreferences = DEFAULT_MARKETING_PREFERENCES) => (
  TOUR_NOTIFICATION_CATEGORY_KEYS.reduce((preferences, key) => {
    const fallback = typeof fallbackPreferences?.[key] === 'boolean'
      ? fallbackPreferences[key]
      : DEFAULT_MARKETING_PREFERENCES[key];

    preferences[key] = readMarketingPreferenceInput(marketingSource, key, fallback);
    return preferences;
  }, {})
);
