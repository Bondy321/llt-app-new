import createNotificationPreferencesScreenStyles from './styles/NotificationPreferencesScreen.styles';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import {
  saveUserPreferences,
  getUserPreferences,
  registerForPushNotificationsAsync,
  primeNotificationPermissions,
} from '../services/notificationService';
import logger from '../services/loggerService';
import { parseTimestampMs } from '../services/timeUtils';
import { COLORS as THEME, SHADOWS } from '../theme';
import NotificationFeedCard from '../components/NotificationFeedCard';
import {
  DEFAULT_MARKETING_PREFERENCES,
  TOUR_NOTIFICATION_CATEGORIES,
  TOUR_NOTIFICATION_CATEGORY_KEYS,
} from '../utils/notificationCategories';

const {
  markAllNotificationsRead,
  markNotificationRead,
  subscribeToNotificationFeed,
} = require('../services/notificationInboxService');

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: THEME.primaryLight,
  primaryLight: THEME.primaryLight,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  tertiaryText: THEME.textMuted,
  appBackground: THEME.background,
  successGreen: THEME.success,
  successLight: THEME.successLight,
  warning: THEME.warning,
  warningLight: THEME.warningLight,
  danger: THEME.error,
  dangerLight: THEME.errorLight,
  border: THEME.border,
  headerBg: THEME.white,
};

const PreferenceSection = ({ title, subtitle, children, enabledCount, totalCount }) => (
  <View style={styles.section}>
    <View style={styles.sectionHeaderRow}>
      <View style={styles.sectionHeaderTextWrap}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      </View>
      {typeof enabledCount === 'number' && typeof totalCount === 'number' ? (
        <View style={styles.sectionCountPill}>
          <Text style={styles.sectionCountText}>{enabledCount}/{totalCount} on</Text>
        </View>
      ) : null}
    </View>
    <View style={styles.sectionContent}>{children}</View>
  </View>
);

const PreferenceHealthCard = ({
  opsEnabledCount,
  opsTotal,
  marketingEnabledCount,
  marketingTotal,
  isOnboarding,
}) => {
  const opsRatio = opsTotal ? opsEnabledCount / opsTotal : 0;
  const marketingRatio = marketingTotal ? marketingEnabledCount / marketingTotal : 0;
  const overallScore = Math.round(((opsRatio * 0.7) + (marketingRatio * 0.3)) * 100);

  const tone =
    overallScore >= 80
      ? { icon: 'star-circle', color: COLORS.successGreen, label: 'Excellent coverage' }
      : overallScore >= 55
        ? { icon: 'checkbox-marked-circle-outline', color: COLORS.warning, label: 'Good coverage' }
        : { icon: 'bell-alert-outline', color: COLORS.danger, label: 'Low coverage' };

  return (
    <View style={styles.healthCard}>
      <View style={styles.healthHeader}>
        <View style={styles.healthHeaderText}>
          <Text style={styles.healthTitle}>Notification readiness</Text>
          <Text style={styles.healthSubtitle}>
            {isOnboarding
              ? 'Turn on the updates you need while travelling.'
              : 'Keep your setup tuned for timely updates.'}
          </Text>
        </View>
        <View style={styles.healthScorePill}>
          <Text style={styles.healthScoreText}>{overallScore}%</Text>
        </View>
      </View>

      <View style={styles.healthProgressTrack}>
        <View style={[styles.healthProgressFill, { width: `${overallScore}%` }]} />
      </View>

      <View style={styles.healthMetaRow}>
        <View style={styles.healthMetaPill}>
          <MaterialCommunityIcons name={tone.icon} size={14} color={tone.color} />
          <Text style={[styles.healthMetaText, { color: tone.color }]}>{tone.label}</Text>
        </View>
        <Text style={styles.healthSummaryText}>
          Tour alerts {opsEnabledCount}/{opsTotal} · Interests {marketingEnabledCount}/{marketingTotal}
        </Text>
      </View>
    </View>
  );
};

const ToggleRow = ({
  label,
  description,
  icon,
  value,
  onValueChange,
  color = COLORS.primaryBlue,
  badge,
  disabled = false,
}) => (
  <View style={styles.toggleRow}>
    <View style={styles.labelContainer}>
      <View style={[styles.iconCircle, { backgroundColor: `${color}20` }]}>
        <MaterialCommunityIcons name={icon} size={20} color={color} />
      </View>
      <View style={styles.labelTextWrap}>
        <View style={styles.labelTitleRow}>
          <Text style={styles.labelText}>{label}</Text>
          {badge ? <Text style={styles.labelBadge}>{badge}</Text> : null}
        </View>
        {description ? <Text style={styles.labelDescription}>{description}</Text> : null}
      </View>
    </View>
    <Switch
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description || undefined}
      accessibilityState={{ checked: value, disabled }}
      trackColor={{ false: COLORS.border, true: color }}
      thumbColor={Platform.OS === 'ios' ? COLORS.white : value ? color : COLORS.white}
      ios_backgroundColor={COLORS.border}
      onValueChange={onValueChange}
      value={value}
      disabled={disabled}
    />
  </View>
);

export default function NotificationPreferencesScreen({
  onBack,
  userId,
  cacheOwnerId = userId,
  isOnboarding = false,
  audience = 'passenger',
  onComplete,
  returnTo,
  tourId,
  onNavigate,
  initialMarketingCategoryKey = null,
}) {
  const defaultOpsPrefs = {
    driver_updates: true,
    itinerary_changes: true,
    group_chat: true,
    group_photos: false,
  };

  const defaultMarketingPrefs = DEFAULT_MARKETING_PREFERENCES;

  const opsPreferenceMeta = {
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

  const marketingCategoryColors = {
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

  const marketingPreferenceMeta = TOUR_NOTIFICATION_CATEGORIES.reduce((meta, category) => {
    meta[category.key] = {
      label: category.label,
      description: category.description,
      icon: category.icon,
      color: marketingCategoryColors[category.key] || COLORS.primaryBlue,
    };
    return meta;
  }, {});

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [emptyStateMessage, setEmptyStateMessage] = useState('');
  const [statusBanner, setStatusBanner] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState('');
  const [testStatus, setTestStatus] = useState({ type: '', message: '' });
  const [permissionStatus, setPermissionStatus] = useState({ state: 'unavailable', description: '' });
  const [onboardingActionBusy, setOnboardingActionBusy] = useState(false);
  const [activeOpsPreset, setActiveOpsPreset] = useState('essential');
  const [activeMarketingPreset, setActiveMarketingPreset] = useState('none');
  const [marketingExpanded, setMarketingExpanded] = useState(false);
  const [notificationFeed, setNotificationFeed] = useState([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationFeedLoading, setNotificationFeedLoading] = useState(false);
  const [notificationFeedError, setNotificationFeedError] = useState('');
  const [notificationFeedStale, setNotificationFeedStale] = useState(false);
  const [notificationFeedRetryKey, setNotificationFeedRetryKey] = useState(0);
  const [notificationFeedBusy, setNotificationFeedBusy] = useState(false);

  // 1. Operational Alerts (During the tour)
  const [opsPrefs, setOpsPrefs] = useState(defaultOpsPrefs);

  // 2. Marketing Interests (Future tours)
  const [marketingPrefs, setMarketingPrefs] = useState(() => ({ ...defaultMarketingPrefs }));
  const [initialOpsPrefs, setInitialOpsPrefs] = useState(null);
  const [initialMarketingPrefs, setInitialMarketingPrefs] = useState(null);
  const mountedRef = useRef(true);
  const preferenceLoadSeqRef = useRef(0);
  const initialCategoryHandledRef = useRef(null);

  const hasChanges =
    initialOpsPrefs !== null &&
    initialMarketingPrefs !== null &&
    (JSON.stringify(opsPrefs) !== JSON.stringify(initialOpsPrefs) ||
      JSON.stringify(marketingPrefs) !== JSON.stringify(initialMarketingPrefs));

  const opsEnabledCount = useMemo(() => Object.values(opsPrefs).filter(Boolean).length, [opsPrefs]);
  const marketingEnabledCount = useMemo(() => Object.values(marketingPrefs).filter(Boolean).length, [marketingPrefs]);

  useEffect(() => {
    logger.trackScreen('NotificationPreferences', {
      isOnboarding,
      audience,
      returnTo: returnTo || null,
      hasUserId: Boolean(userId),
    });
  }, [audience, isOnboarding, returnTo, userId]);

  useEffect(() => () => {
    mountedRef.current = false;
    preferenceLoadSeqRef.current += 1;
  }, []);

  useEffect(() => {
    if (loading || isOnboarding || !initialMarketingCategoryKey) return;
    if (!TOUR_NOTIFICATION_CATEGORY_KEYS.includes(initialMarketingCategoryKey)) return;
    if (initialCategoryHandledRef.current === initialMarketingCategoryKey) return;

    initialCategoryHandledRef.current = initialMarketingCategoryKey;
    setMarketingExpanded(true);
    const category = TOUR_NOTIFICATION_CATEGORIES.find((item) => item.key === initialMarketingCategoryKey);
    setStatusBanner({
      type: 'info',
      message: category
        ? `Opened ${category.label} notification settings.`
        : 'Opened future-tour notification settings.',
    });
  }, [initialMarketingCategoryKey, isOnboarding, loading]);

  useEffect(() => {
    if (isOnboarding || !tourId || !userId) {
      setNotificationFeed([]);
      setNotificationUnreadCount(0);
      setNotificationFeedLoading(false);
      setNotificationFeedError('');
      setNotificationFeedStale(false);
      return undefined;
    }

    setNotificationFeedLoading(true);
    setNotificationFeedError('');
    try {
      return subscribeToNotificationFeed({
        tourId,
        userId,
        cacheOwnerId,
        readStateOwnerId: cacheOwnerId,
        onUpdate: ({ items, unreadCount, stale = false }) => {
          if (!mountedRef.current) return;
          setNotificationFeed(items);
          setNotificationUnreadCount(unreadCount);
          setNotificationFeedLoading(false);
          setNotificationFeedError('');
          setNotificationFeedStale(stale);
        },
        onError: (error, recovery = {}) => {
          if (!mountedRef.current) return;
          logger.warn('NotificationPreferences', 'Tour update feed failed', {
            error: error?.message || String(error),
          });
          setNotificationFeedLoading(false);
          setNotificationFeedStale(recovery.stale === true && recovery.hasItems === true);
          setNotificationFeedError(recovery.hasPersistedCache
            ? 'Live updates could not be refreshed. Saved updates are still shown below.'
            : recovery.hasItems
              ? 'Live updates could not be refreshed. Your current updates remain shown below.'
            : 'Tour updates could not be refreshed. Your alert preferences are still available below.');
        },
      });
    } catch (error) {
      logger.warn('NotificationPreferences', 'Tour update feed could not start', {
        error: error?.message || String(error),
      });
      setNotificationFeedLoading(false);
      setNotificationFeedError('Tour updates are temporarily unavailable.');
      return undefined;
    }
  }, [cacheOwnerId, isOnboarding, notificationFeedRetryKey, tourId, userId]);

  const handleRetryNotificationFeed = () => {
    setNotificationFeedLoading(true);
    setNotificationFeedError('');
    setNotificationFeedRetryKey((value) => value + 1);
  };

  const handleOpenNotification = async (item) => {
    if (!item) return;
    if (!item.isRead) {
      setNotificationFeed((current) => current.map((notice) => (
        notice.noticeId === item.noticeId
          ? { ...notice, isRead: true, readAtMs: Date.now() }
          : notice
      )));
      setNotificationUnreadCount((current) => Math.max(0, current - 1));
    }
    onNavigate?.(item.screen, {
      tourId: item.tourId,
      noticeId: item.noticeId,
      messageId: item.messageId,
      departureKey: item.departureKey,
      revision: item.revision,
      changedSections: item.changedSections,
      critical: item.critical === true,
      requiresAcknowledgement: item.requiresAcknowledgement === true,
      fromNotification: true,
    });
    if (!item.isRead) {
      try {
        await markNotificationRead({
          tourId,
          userId,
          readStateOwnerId: cacheOwnerId,
          noticeId: item.noticeId,
        });
      } catch (error) {
        logger.warn('NotificationPreferences', 'Tour update read state could not be saved', {
          noticeType: item.type,
          error: error?.message || String(error),
        });
      }
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    if (notificationFeedBusy || notificationUnreadCount === 0) return;
    setNotificationFeedBusy(true);
    try {
      await markAllNotificationsRead({
        tourId,
        userId,
        readStateOwnerId: cacheOwnerId,
        noticeIds: notificationFeed.filter((item) => !item.isRead).map((item) => item.noticeId),
      });
    } catch (error) {
      logger.warn('NotificationPreferences', 'Mark-all-read failed', {
        error: error?.message || String(error),
      });
      setNotificationFeedError('Updates could not be marked as read. Please retry.');
    } finally {
      if (mountedRef.current) setNotificationFeedBusy(false);
    }
  };

  const formatTimestamp = (isoDate) => {
    const parsedMs = parseTimestampMs(isoDate);
    if (!Number.isFinite(parsedMs)) return '';
    const date = new Date(parsedMs);
    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const loadPreferences = async () => {
    const requestSeq = ++preferenceLoadSeqRef.current;
    const canApplyRequest = () => mountedRef.current && requestSeq === preferenceLoadSeqRef.current;

    setLoading(true);
    setLoadError('');
    setEmptyStateMessage('');
    setStatusBanner(null);

    logger.info('NotificationPreferences', 'Preference load started', {
      hasUserId: Boolean(userId),
      isOnboarding,
      audience,
    });

    if (!userId) {
      logger.warn('NotificationPreferences', 'Preference load blocked without user id', {
        isOnboarding,
        audience,
      });
      if (canApplyRequest()) {
        setEmptyStateMessage('Sign in to manage notifications.');
        setLoading(false);
      }
      return;
    }

    try {
      const [permissionProbe, saved] = await Promise.all([
        primeNotificationPermissions({
          userId,
          requestIfNeeded: false,
          persistState: false,
        }),
        getUserPreferences(userId, { throwOnError: true }),
      ]);
      if (!canApplyRequest()) return;
      if (permissionProbe?.success) {
        setPermissionStatus(permissionProbe.data);
        logger.info('NotificationPreferences', 'Permission probe completed during load', {
          state: permissionProbe.data?.state,
          granted: permissionProbe.data?.granted,
          canAskAgain: permissionProbe.data?.canAskAgain,
          requestIfNeeded: false,
        });
      } else {
        logger.warn('NotificationPreferences', 'Permission probe failed during load', {
          error: permissionProbe?.error || 'unknown',
          requestIfNeeded: false,
        });
      }

      const nextOpsPrefs = saved?.ops
        ? { ...defaultOpsPrefs, ...saved.ops }
        : { ...defaultOpsPrefs };
      const nextMarketingPrefs = saved?.marketing
        ? { ...defaultMarketingPrefs, ...saved.marketing }
        : { ...defaultMarketingPrefs };

      setOpsPrefs(nextOpsPrefs);
      setMarketingPrefs(nextMarketingPrefs);
      setInitialOpsPrefs(nextOpsPrefs);
      setInitialMarketingPrefs(nextMarketingPrefs);
      logger.info('NotificationPreferences', 'Preference load completed', {
        opsEnabledCount: Object.values(nextOpsPrefs).filter(Boolean).length,
        marketingEnabledCount: Object.values(nextMarketingPrefs).filter(Boolean).length,
        hadSavedOpsPrefs: Boolean(saved?.ops),
        hadSavedMarketingPrefs: Boolean(saved?.marketing),
      });
    } catch (error) {
      logger.error('NotificationPreferences', 'Preference load failed', {
        error: error?.message || String(error),
      });
      if (canApplyRequest()) {
        setLoadError('We could not load your notification settings. Please try again.');
      }
    } finally {
      if (canApplyRequest()) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadPreferences();
  }, [userId]);

  const handleSave = async () => {
    if (saving || !userId) return;
    setSaving(true);
    setStatusBanner(null);
    logger.info('NotificationPreferences', 'Preference save started', {
      opsEnabledCount,
      marketingEnabledCount,
      hasChanges,
      permissionState: permissionStatus?.state || 'unknown',
    });

    try {
      const fullPreferences = {
        ops: opsPrefs,
        marketing: marketingPrefs,
        updatedAt: new Date().toISOString(),
      };

      const result = await saveUserPreferences(userId, fullPreferences);
      if (!mountedRef.current) return;

      if (result.success) {
        logger.info('NotificationPreferences', 'Preference save completed', {
          warning: result.warning || null,
          permissionState: result?.permissionState?.state || permissionStatus?.state || 'unknown',
          opsEnabledCount,
          marketingEnabledCount,
        });
        if (result?.permissionState) {
          setPermissionStatus(result.permissionState);
        }
        setInitialOpsPrefs({ ...opsPrefs });
        setInitialMarketingPrefs({ ...marketingPrefs });
        const savedAt = new Date().toISOString();
        setLastSavedAt(savedAt);
        setStatusBanner({
          type: 'success',
          message: result.warning || "Preferences saved. We'll only send notifications based on your choices.",
        });
      } else {
        logger.warn('NotificationPreferences', 'Preference save returned failure', {
          error: result.error || 'unknown',
          permissionState: permissionStatus?.state || 'unknown',
        });
        setStatusBanner({
          type: 'error',
          message: 'Could not save settings. Please check your internet connection and try again.',
        });
      }
    } catch (error) {
      logger.error('NotificationPreferences', 'Preference save threw', {
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        setStatusBanner({
          type: 'error',
          message: 'Unexpected error while saving preferences. Please retry.',
        });
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  };

  const completeOnboarding = async (status) => {
    logger.info('NotificationPreferences', 'Notification onboarding completing', {
      status,
      audience,
      returnTo: returnTo || null,
    });
    if (typeof onComplete === 'function') {
      await onComplete({
        status,
        audience,
        returnTo,
      });
      return;
    }
    onBack?.();
  };

  const handleEnableNow = async () => {
    if (!userId || onboardingActionBusy) return;
    setOnboardingActionBusy(true);
    setStatusBanner(null);
    logger.info('NotificationPreferences', 'Onboarding enable started', {
      audience,
      opsEnabledCount,
      marketingEnabledCount,
    });

    const permissionProbe = await primeNotificationPermissions({
      userId,
      requestIfNeeded: true,
      persistState: false,
    });
    if (!mountedRef.current) return;

    if (!permissionProbe?.success) {
      logger.warn('NotificationPreferences', 'Onboarding permission probe failed', {
        error: permissionProbe?.error || 'unknown',
      });
      setOnboardingActionBusy(false);
      setStatusBanner({
        type: 'error',
        message: 'Could not check permissions right now. Please try again.',
      });
      return;
    }

    setPermissionStatus(permissionProbe.data);
    logger.info('NotificationPreferences', 'Onboarding permission probe completed', {
      state: permissionProbe.data?.state,
      granted: permissionProbe.data?.granted,
      canAskAgain: permissionProbe.data?.canAskAgain,
    });

    const fullPreferences = {
      ops: opsPrefs,
      marketing: marketingPrefs,
      updatedAt: new Date().toISOString(),
    };

    const saveResult = await saveUserPreferences(userId, fullPreferences, {
      permissionState: permissionProbe.data,
    });
    if (!mountedRef.current) return;

    if (!saveResult.success) {
      logger.warn('NotificationPreferences', 'Onboarding preference save failed', {
        error: saveResult.error || 'unknown',
      });
      setOnboardingActionBusy(false);
      setStatusBanner({
        type: 'error',
        message: 'We could not save your preferences. Check your connection and retry.',
      });
      return;
    }

    if (saveResult?.permissionState) {
      setPermissionStatus(saveResult.permissionState);
    }

    setOnboardingActionBusy(false);
    logger.info('NotificationPreferences', 'Onboarding enable completed', {
      permissionState: saveResult?.permissionState?.state || permissionProbe.data?.state || 'unknown',
    });
    await completeOnboarding('completed');
  };

  const handleMaybeLater = async () => {
    logger.info('NotificationPreferences', 'Onboarding skipped', { audience, returnTo: returnTo || null });
    await completeOnboarding('skipped');
  };

  const applyOpsPreset = (preset) => {
    logger.debug('NotificationPreferences', 'Operational preset applied', { preset });
    setActiveOpsPreset(preset);
    if (preset === 'all') {
      setOpsPrefs({
        driver_updates: true,
        itinerary_changes: true,
        group_chat: true,
        group_photos: true,
      });
      return;
    }

    if (preset === 'essential') {
      setOpsPrefs({
        driver_updates: true,
        itinerary_changes: true,
        group_chat: true,
        group_photos: false,
      });
      return;
    }

    setOpsPrefs({
      driver_updates: false,
      itinerary_changes: false,
      group_chat: false,
      group_photos: false,
    });
  };

  const applyMarketingPreset = (preset) => {
    logger.debug('NotificationPreferences', 'Marketing preset applied', { preset });
    setActiveMarketingPreset(preset);
    const buildMarketingPrefs = (enabledKeys = []) => {
      const nextPrefs = { ...defaultMarketingPrefs };
      enabledKeys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(nextPrefs, key)) {
          nextPrefs[key] = true;
        }
      });
      return nextPrefs;
    };

    if (preset === 'recommended') {
      setMarketingPrefs(buildMarketingPrefs([
        'day_trips',
        'mystery_breaks',
        'scotland_highlands_islands',
        'european_breaks',
        'steam_train_tours',
      ]));
      return;
    }

    if (preset === 'all') {
      setMarketingPrefs(buildMarketingPrefs(TOUR_NOTIFICATION_CATEGORY_KEYS));
      return;
    }

    setMarketingPrefs({ ...defaultMarketingPrefs });
  };

  const onboardingCopy = {
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

  const activeOnboardingCopy = onboardingCopy[audience] || onboardingCopy.passenger;

  const permissionToneByState = {
    granted: { label: 'Enabled', color: COLORS.successGreen, icon: 'check-circle-outline' },
    denied: { label: 'Not enabled yet', color: COLORS.warning, icon: 'alert-outline' },
    blocked: { label: 'Blocked in device settings', color: COLORS.danger, icon: 'alert-circle-outline' },
    unavailable: { label: 'Unavailable on this device', color: COLORS.secondaryText, icon: 'cellphone-off' },
  };

  const permissionTone = permissionToneByState[permissionStatus?.state] || permissionToneByState.unavailable;

  const handleTestNotification = async () => {
    try {
      logger.info('NotificationPreferences', 'Test notification started', {
        permissionState: permissionStatus?.state || 'unknown',
      });
      setTestStatus({ type: 'progress', message: 'Checking notification permissions...' });
      
      const token = await registerForPushNotificationsAsync();
      if (!mountedRef.current) return;
      
      if (!token) {
        logger.warn('NotificationPreferences', 'Test notification blocked without token', {
          permissionState: permissionStatus?.state || 'unknown',
        });
        setTestStatus({
          type: 'error',
          message: 'Permission check failed. Enable notifications in device settings and retry.',
        });
        return;
      }

      setTestStatus({ type: 'progress', message: 'Sending a local test notification...' });

      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'System Check Passed',
          body: "Your device is correctly configured to receive Loch Lomond Travel updates.",
          sound: true,
          data: {
            screen: 'NotificationPreferences',
            notificationType: 'local_test',
            timestamp: Date.now(),
          },
        },
        trigger: null, // null means trigger immediately
      });
      if (!mountedRef.current) return;

      setTestStatus({
        type: 'success',
        message: 'Test notification sent successfully. If you did not see it, check OS notification settings.',
      });
      logger.info('NotificationPreferences', 'Test notification scheduled', {
        permissionState: permissionStatus?.state || 'unknown',
      });

    } catch (error) {
      logger.error('NotificationPreferences', 'Test notification failed', {
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        setTestStatus({
          type: 'error',
          message: 'Test notification could not be sent. Check OS notification settings and try again.',
        });
      }
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        <Text style={styles.loadingText}>Loading notification preferences...</Text>
      </View>
    );
  }

  if (loadError || emptyStateMessage) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Back">
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.darkText} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Notifications</Text>
          <View style={styles.headerButton} />
        </View>

        <View style={styles.emptyPanelContainer}>
          <View style={styles.emptyPanel}>
              <MaterialCommunityIcons
              name={loadError ? 'alert-circle-outline' : 'account-circle-outline'}
              size={34}
              color={loadError ? COLORS.danger : COLORS.primaryBlue}
            />
            <Text style={styles.emptyPanelTitle}>{loadError ? 'Something went wrong' : 'Not signed in'}</Text>
            <Text style={styles.emptyPanelMessage}>{loadError || emptyStateMessage}</Text>
            {loadError ? (
              <TouchableOpacity style={styles.retryButton} onPress={loadPreferences} accessibilityRole="button" accessibilityLabel="Retry loading notification preferences">
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.retryButton} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
                <Text style={styles.retryButtonText}>Back</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        {isOnboarding ? <View style={styles.headerButton} /> : (
          <TouchableOpacity onPress={onBack} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Back">
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.darkText} />
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>{isOnboarding ? 'Welcome' : 'Notifications'}</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContainer}>
        {isOnboarding ? (
          <LinearGradient
            colors={[`${COLORS.primaryBlue}F2`, COLORS.primaryLight]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <View style={styles.heroIconWrap}>
              <MaterialCommunityIcons name={activeOnboardingCopy.icon} size={28} color={COLORS.white} />
            </View>
            <Text style={styles.heroTitle}>{activeOnboardingCopy.title}</Text>
            <Text style={styles.heroSubtitle}>{activeOnboardingCopy.subtitle}</Text>

            <View style={styles.permissionBadgeRow}>
              <MaterialCommunityIcons name={permissionTone.icon} size={16} color={permissionTone.color} />
              <Text style={[styles.permissionBadgeText, { color: permissionTone.color }]}>{permissionTone.label}</Text>
            </View>

            <View style={styles.heroInfoCard}>
              <Text style={styles.heroInfoTitle}>{activeOnboardingCopy.cardTitle}</Text>
              <Text style={styles.heroInfoBody}>{activeOnboardingCopy.cardBody}</Text>
            </View>
          </LinearGradient>
        ) : null}

        {statusBanner ? (
          <View style={[
            styles.statusBanner,
            statusBanner.type === 'error'
              ? styles.errorBanner
              : statusBanner.type === 'info'
                ? styles.infoBanner
                : styles.successBanner,
          ]}>
            <Text style={styles.statusBannerText}>{statusBanner.message}</Text>
            {statusBanner.type === 'error' ? (
              <TouchableOpacity style={styles.inlineActionButton} onPress={handleSave} disabled={saving}>
                <Text style={styles.inlineActionButtonText}>{saving ? 'Retrying…' : 'Retry save'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {lastSavedAt ? (
          <Text style={styles.lastSavedText}>Last saved at {formatTimestamp(lastSavedAt)}</Text>
        ) : null}

        <Text style={styles.introText}>
          {isOnboarding
            ? 'Choose what you want to hear about. You can edit this anytime later.'
            : 'Customize your alerts. We promise not to spam you.'}
        </Text>

        <PreferenceHealthCard
          opsEnabledCount={opsEnabledCount}
          opsTotal={Object.keys(defaultOpsPrefs).length}
          marketingEnabledCount={marketingEnabledCount}
          marketingTotal={Object.keys(defaultMarketingPrefs).length}
          isOnboarding={isOnboarding}
        />

        {!isOnboarding ? (
          <View style={styles.permissionSummaryCard}>
            <View style={styles.permissionSummaryHeader}>
              <MaterialCommunityIcons name={permissionTone.icon} size={18} color={permissionTone.color} />
              <Text style={styles.permissionSummaryTitle}>Notification Permission</Text>
            </View>
            <Text style={[styles.permissionSummaryState, { color: permissionTone.color }]}>{permissionTone.label}</Text>
            {permissionStatus?.description ? (
              <Text style={styles.permissionSummaryBody}>{permissionStatus.description}</Text>
            ) : null}
          </View>
        ) : null}

        {!isOnboarding ? (
          <NotificationFeedCard
            items={notificationFeed}
            unreadCount={notificationUnreadCount}
            loading={notificationFeedLoading}
            error={notificationFeedError}
            stale={notificationFeedStale}
            busy={notificationFeedBusy}
            onOpen={handleOpenNotification}
            onMarkAll={handleMarkAllNotificationsRead}
            onRetry={handleRetryNotificationFeed}
          />
        ) : null}

        {/* SECTION 1: ON TOUR */}
        <PreferenceSection
          title="While On Tour"
          subtitle="Control operational updates during active tours."
          enabledCount={opsEnabledCount}
          totalCount={Object.keys(defaultOpsPrefs).length}
        >
          <View style={styles.presetRow}>
            <TouchableOpacity
              style={[styles.presetChip, activeOpsPreset === 'essential' && styles.presetChipActive]}
              onPress={() => applyOpsPreset('essential')}
              accessibilityRole="button"
              accessibilityLabel="Use essential tour notification settings"
              accessibilityState={{ selected: activeOpsPreset === 'essential' }}
            >
              <Text style={[styles.presetChipText, activeOpsPreset === 'essential' && styles.presetChipTextActive]}>Essential</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.presetChip, activeOpsPreset === 'all' && styles.presetChipActive]}
              onPress={() => applyOpsPreset('all')}
              accessibilityRole="button"
              accessibilityLabel="Turn all tour notifications on"
              accessibilityState={{ selected: activeOpsPreset === 'all' }}
            >
              <Text style={[styles.presetChipText, activeOpsPreset === 'all' && styles.presetChipTextActive]}>All on</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.presetChip, activeOpsPreset === 'none' && styles.presetChipActive]}
              onPress={() => applyOpsPreset('none')}
              accessibilityRole="button"
              accessibilityLabel="Turn all tour notifications off"
              accessibilityState={{ selected: activeOpsPreset === 'none' }}
            >
              <Text style={[styles.presetChipText, activeOpsPreset === 'none' && styles.presetChipTextActive]}>All off</Text>
            </TouchableOpacity>
          </View>
          {Object.entries(opsPreferenceMeta).map(([key, meta]) => (
            <ToggleRow
              key={key}
              label={meta.label}
              description={meta.description}
              icon={meta.icon}
              value={opsPrefs[key]}
              onValueChange={(v) => {
                logger.debug('NotificationPreferences', 'Operational preference toggled', { key, enabled: v });
                setOpsPrefs({ ...opsPrefs, [key]: v });
              }}
              color={meta.color}
              badge={meta.badge}
              disabled={saving || onboardingActionBusy}
            />
          ))}
        </PreferenceSection>

        {/* SECTION 2: FUTURE TOURS */}
        <PreferenceSection
          title="Future Tour Interests"
          subtitle="Choose the kinds of trips you want to hear about after this tour."
          enabledCount={marketingEnabledCount}
          totalCount={Object.keys(defaultMarketingPrefs).length}
        >
          <Text style={styles.subText}>
            We will only send future-tour announcements for categories you switch on.
          </Text>

          <TouchableOpacity
            style={styles.accordionTrigger}
            onPress={() => setMarketingExpanded((expanded) => !expanded)}
            activeOpacity={0.84}
            accessibilityRole="button"
            accessibilityState={{ expanded: marketingExpanded }}
          >
            <View style={styles.accordionIconWrap}>
              <MaterialCommunityIcons name="bell-plus-outline" size={20} color={COLORS.primaryBlue} />
            </View>
            <View style={styles.accordionTextWrap}>
              <Text style={styles.accordionTitle}>Upcoming tour alerts</Text>
              <Text style={styles.accordionSubtitle}>
                {marketingExpanded
                  ? 'Collapse your tour type choices.'
                  : 'Expand to choose the tour types you want to hear about.'}
              </Text>
            </View>
            <View style={styles.accordionMetaWrap}>
              <Text style={styles.accordionCountText}>
                {marketingEnabledCount > 0 ? `${marketingEnabledCount} selected` : 'None selected'}
              </Text>
              <MaterialCommunityIcons
                name={marketingExpanded ? 'chevron-up' : 'chevron-down'}
                size={22}
                color={COLORS.secondaryText}
              />
            </View>
          </TouchableOpacity>

          {marketingExpanded ? (
            <View style={styles.accordionContent}>
              <View style={styles.presetRow}>
                <TouchableOpacity
                  style={[styles.presetChip, activeMarketingPreset === 'recommended' && styles.presetChipActive]}
                  onPress={() => applyMarketingPreset('recommended')}
                  accessibilityRole="button"
                  accessibilityLabel="Use recommended interest notification settings"
                  accessibilityState={{ selected: activeMarketingPreset === 'recommended' }}
                >
                  <Text
                    style={[
                      styles.presetChipText,
                      activeMarketingPreset === 'recommended' && styles.presetChipTextActive,
                    ]}
                  >
                    Recommended
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.presetChip, activeMarketingPreset === 'all' && styles.presetChipActive]}
                  onPress={() => applyMarketingPreset('all')}
                  accessibilityRole="button"
                  accessibilityLabel="Turn all interest notifications on"
                  accessibilityState={{ selected: activeMarketingPreset === 'all' }}
                >
                  <Text style={[styles.presetChipText, activeMarketingPreset === 'all' && styles.presetChipTextActive]}>All on</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.presetChip, activeMarketingPreset === 'none' && styles.presetChipActive]}
                  onPress={() => applyMarketingPreset('none')}
                  accessibilityRole="button"
                  accessibilityLabel="Turn all interest notifications off"
                  accessibilityState={{ selected: activeMarketingPreset === 'none' }}
                >
                  <Text style={[styles.presetChipText, activeMarketingPreset === 'none' && styles.presetChipTextActive]}>All off</Text>
                </TouchableOpacity>
              </View>

              {Object.entries(marketingPreferenceMeta).map(([key, meta]) => (
                <ToggleRow
                  key={key}
                  label={meta.label}
                  description={meta.description}
                  icon={meta.icon}
                  value={marketingPrefs[key]}
                  onValueChange={(v) => {
                    logger.debug('NotificationPreferences', 'Marketing preference toggled', { key, enabled: v });
                    setActiveMarketingPreset('custom');
                    setMarketingPrefs({ ...marketingPrefs, [key]: v });
                  }}
                  color={meta.color}
                  badge={meta.badge}
                  disabled={saving || onboardingActionBusy}
                />
              ))}
            </View>
          ) : null}
        </PreferenceSection>

        {!isOnboarding && hasChanges ? (
          <LinearGradient
            colors={[COLORS.primaryBlue, COLORS.lightBlueAccent]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.saveCard}
          >
            <View style={styles.saveCardHeader}>
              <MaterialCommunityIcons name="content-save-check-outline" size={18} color={COLORS.white} />
              <Text style={styles.saveCardHeaderText}>Unsaved changes</Text>
            </View>
            <Text style={styles.saveCardBody}>Review complete. Save now to apply this experience across your account.</Text>
            <TouchableOpacity
              style={[styles.saveButton, styles.saveButtonOnGradient, saving && styles.disabledButton]}
              onPress={handleSave}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Save notification preferences"
              accessibilityState={{ disabled: saving, busy: saving }}
            >
              {saving ? (
                <ActivityIndicator color={COLORS.primaryBlue} />
              ) : (
                <Text style={styles.saveButtonTextOnGradient}>Save Preferences</Text>
              )}
            </TouchableOpacity>
          </LinearGradient>
        ) : !isOnboarding ? (
          <View style={styles.noChangesCard}>
            <MaterialCommunityIcons name="check-circle-outline" size={16} color={COLORS.secondaryText} />
            <Text style={styles.noChangesText}>No unsaved changes</Text>
          </View>
        ) : null}

        {isOnboarding ? (
          <View style={styles.onboardingActionWrap}>
            <TouchableOpacity
              style={[styles.saveButton, (onboardingActionBusy || saving) && styles.disabledButton]}
              onPress={handleEnableNow}
              disabled={onboardingActionBusy || saving}
              accessibilityRole="button"
              accessibilityLabel={activeOnboardingCopy.primaryCta}
              accessibilityState={{ disabled: onboardingActionBusy || saving, busy: onboardingActionBusy || saving }}
            >
              {(onboardingActionBusy || saving) ? (
                <ActivityIndicator color={COLORS.white} />
              ) : (
                <Text style={styles.saveButtonText}>{activeOnboardingCopy.primaryCta}</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryOnboardingButton}
              onPress={handleMaybeLater}
              disabled={onboardingActionBusy || saving}
              accessibilityRole="button"
              accessibilityLabel={activeOnboardingCopy.secondaryCta}
              accessibilityState={{ disabled: onboardingActionBusy || saving }}
            >
              <Text style={styles.secondaryOnboardingButtonText}>{activeOnboardingCopy.secondaryCta}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        
        {!isOnboarding ? (
          <TouchableOpacity
            style={styles.testButton}
            onPress={handleTestNotification}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Send a test notification"
            accessibilityState={{ disabled: saving }}
          >
            <MaterialCommunityIcons name="bell-check-outline" size={20} color={COLORS.secondaryText} />
            <Text style={styles.testButtonText}>Send a test notification</Text>
          </TouchableOpacity>
        ) : null}

        {testStatus.type ? (
          <View style={[
            styles.statusBanner,
            testStatus.type === 'error'
              ? styles.errorBanner
              : testStatus.type === 'success'
                ? styles.successBanner
                : styles.infoBanner,
          ]}>
            <Text style={styles.statusBannerText}>{testStatus.message}</Text>
            {testStatus.type === 'error' ? (
              <TouchableOpacity style={styles.inlineActionButton} onPress={handleTestNotification}>
                <Text style={styles.inlineActionButtonText}>Retry test</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <Text style={styles.privacyNote}>
          You can change these settings at any time.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = createNotificationPreferencesScreenStyles({ StyleSheet, COLORS, SHADOWS, THEME });
