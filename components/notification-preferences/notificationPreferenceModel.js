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

export const ONBOARDING_COPY = {
    passenger: {
      title: 'Stay in the loop on your tour',
      subtitle: 'Turn on notifications so you get pickup timing changes, driver announcements, and group updates without opening the app.',
      icon: 'bus-clock',
      cardTitle: 'Recommended for passengers',
      cardBody: 'We will use notifications only for the updates you choose below. You can change everything later in Settings.',
      primaryCta: 'Enable notifications',
      secondaryCta: 'Maybe later',
    },
    driver: {
      title: 'Enable critical driver alerts',
      subtitle: 'Driver notifications are essential for itinerary changes, operational updates, and urgent HQ messages while on the road.',
      icon: 'steering',
      cardTitle: 'Recommended for drivers',
      cardBody: 'To keep operations smooth, keep Driver Announcements and Itinerary Updates switched on.',
      primaryCta: 'Enable driver alerts',
      secondaryCta: 'Skip for now',
    },
  };


export const PERMISSION_TONE_BY_STATE = {
    granted: { label: 'Enabled', color: COLORS.successGreen, icon: 'check-circle-outline' },
    provisional: { label: 'Enabled quietly', color: COLORS.primaryBlue, icon: 'bell-outline' },
    ephemeral: { label: 'Enabled temporarily', color: COLORS.warning, icon: 'clock-outline' },
    denied: { label: 'Not enabled yet', color: COLORS.warning, icon: 'alert-outline' },
    blocked: { label: 'Blocked in device settings', color: COLORS.danger, icon: 'alert-circle-outline' },
    unavailable: { label: 'Unavailable on this device', color: COLORS.secondaryText, icon: 'cellphone-off' },
  };
