export const TOUR_NOTIFICATION_CATEGORIES = [
  { key: 'day_trips', label: 'Day Trips' },
  { key: 'mystery_breaks', label: 'Mystery Breaks' },
  { key: 'scotland_highlands_islands', label: 'Scotland, Highlands & Islands' },
  { key: 'isle_of_ireland', label: 'Isle of Ireland' },
  { key: 'european_breaks', label: 'European Breaks' },
  { key: 'steam_train_tours', label: 'Steam Train Tours' },
  { key: 'cruises_ferries', label: 'Cruises & Ferries' },
  { key: 'theatre_concerts', label: 'Theatre & Concerts' },
  { key: 'sporting_breaks', label: 'Sporting Breaks' },
  { key: 'history_military_breaks', label: 'History & Military Breaks' },
];

export const TOUR_NOTIFICATION_CATEGORY_OPTIONS = TOUR_NOTIFICATION_CATEGORIES.map((category) => ({
  value: category.key,
  label: category.label,
}));

export const getTourNotificationCategoryLabel = (categoryKey) => (
  TOUR_NOTIFICATION_CATEGORIES.find((category) => category.key === categoryKey)?.label || categoryKey
);
