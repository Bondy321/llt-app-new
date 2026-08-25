import { COLORS } from './notificationPreferenceTheme';
import { DEFAULT_MARKETING_PREFERENCES, TOUR_NOTIFICATION_CATEGORIES } from '../../utils/notificationCategories';

export const DEFAULT_OPS_PREFERENCES = {
    driver_updates: true,
    itinerary_changes: true,
    group_chat: true,
    group_photos: false,
  };

export const DEFAULT_MARKETING_PREFERENCES_MODEL = DEFAULT_MARKETING_PREFERENCES;

export const OPS_PREFERENCE_META = {
    driver_updates: {
      label: 'Driver Announcements',
      description: 'Critical updates from your driver and operations team.',
      icon: 'bullhorn-outline',
      color: COLORS.warning,
      badge: 'Essential',
    },
    itinerary_changes: {
      label: 'Itinerary Updates',
      description: 'Timing changes, stop swaps, and schedule adjustments.',
      icon: 'clock-time-four-outline',
      color: COLORS.primaryBlue,
      badge: 'Essential',
    },
    group_chat: {
      label: 'Group Chat Messages',
      description: 'New messages in your tour conversation.',
      icon: 'chat-processing-outline',
      color: COLORS.primaryLight,
    },
    group_photos: {
      label: 'New Photo Uploads',
      description: 'Alerts when your group shares new memories.',
      icon: 'image-multiple-outline',
      color: COLORS.successGreen,
    },
  };

const MARKETING_CATEGORY_COLORS = {
    day_trips: COLORS.successGreen,
    mystery_breaks: COLORS.primaryLight,
    scotland_highlands_islands: COLORS.primaryBlue,
    isle_of_ireland: COLORS.successGreen,
    european_breaks: COLORS.primaryLight,
    steam_train_tours: COLORS.primaryBlue,
    cruises_ferries: COLORS.primaryLight,
    theatre_concerts: COLORS.warning,
    sporting_breaks: COLORS.successGreen,
    history_military_breaks: COLORS.warning,
  };

export const MARKETING_PREFERENCE_META = TOUR_NOTIFICATION_CATEGORIES.reduce((meta, category) => {
    meta[category.key] = {
      label: category.label,
      description: category.description,
      icon: category.icon,
      color: MARKETING_CATEGORY_COLORS[category.key] || COLORS.primaryBlue,
    };
    return meta;
  }, {});


