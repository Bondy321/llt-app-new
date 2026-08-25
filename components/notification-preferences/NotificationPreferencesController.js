import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as Notifications from 'expo-notifications';
import {
  saveUserPreferences,
  getUserPreferences,
  registerForPushNotificationsAsync,
  primeNotificationPermissions,
} from '../../services/notificationService';
import logger from '../../services/loggerService';
import {
  TOUR_NOTIFICATION_CATEGORIES,
  TOUR_NOTIFICATION_CATEGORY_KEYS,
} from '../../utils/notificationCategories';

import NotificationPreferencesView from './NotificationPreferencesView';
import useNotificationFeedController from './useNotificationFeedController';
import {
  DEFAULT_MARKETING_PREFERENCES_MODEL as defaultMarketingPrefs,
  DEFAULT_OPS_PREFERENCES as defaultOpsPrefs,
  MARKETING_PREFERENCE_META as marketingPreferenceMeta,
  OPS_PREFERENCE_META as opsPreferenceMeta,
} from './notificationPreferenceModel';
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

  // 1. Operational Alerts (During the tour)
  const [opsPrefs, setOpsPrefs] = useState(defaultOpsPrefs);

  // 2. Marketing Interests (Future tours)
  const [marketingPrefs, setMarketingPrefs] = useState(() => ({ ...defaultMarketingPrefs }));
  const [initialOpsPrefs, setInitialOpsPrefs] = useState(null);
  const [initialMarketingPrefs, setInitialMarketingPrefs] = useState(null);
  const mountedRef = useRef(true);
  const preferenceLoadSeqRef = useRef(0);
  const initialCategoryHandledRef = useRef(null);
  const notificationFeed = useNotificationFeedController({
    cacheOwnerId,
    isOnboarding,
    mountedRef,
    onNavigate,
    tourId,
    userId,
  });

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

  const loadPreferences = useCallback(async () => {
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
  }, [audience, isOnboarding, userId]);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

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

  return (
    <NotificationPreferencesView
      activeMarketingPreset={activeMarketingPreset}
      activeOnboardingCopy={activeOnboardingCopy}
      activeOpsPreset={activeOpsPreset}
      applyMarketingPreset={applyMarketingPreset}
      applyOpsPreset={applyOpsPreset}
      emptyStateMessage={emptyStateMessage}
      formatTimestamp={notificationFeed.formatTimestamp}
      handleEnableNow={handleEnableNow}
      handleMarkAllNotificationsRead={notificationFeed.markAllRead}
      handleMaybeLater={handleMaybeLater}
      handleOpenNotification={notificationFeed.open}
      handleRetryNotificationFeed={notificationFeed.retry}
      handleSave={handleSave}
      handleTestNotification={handleTestNotification}
      hasChanges={hasChanges}
      isOnboarding={isOnboarding}
      lastSavedAt={lastSavedAt}
      loadError={loadError}
      loadPreferences={loadPreferences}
      loading={loading}
      marketingEnabledCount={marketingEnabledCount}
      marketingExpanded={marketingExpanded}
      marketingPreferenceMeta={marketingPreferenceMeta}
      marketingPrefs={marketingPrefs}
      notificationFeed={notificationFeed.items}
      notificationFeedBusy={notificationFeed.busy}
      notificationFeedError={notificationFeed.error}
      notificationFeedLoading={notificationFeed.loading}
      notificationFeedStale={notificationFeed.stale}
      notificationUnreadCount={notificationFeed.unreadCount}
      onBack={onBack}
      onboardingActionBusy={onboardingActionBusy}
      opsEnabledCount={opsEnabledCount}
      opsPreferenceMeta={opsPreferenceMeta}
      opsPrefs={opsPrefs}
      permissionStatus={permissionStatus}
      permissionTone={permissionTone}
      saving={saving}
      setMarketingExpanded={setMarketingExpanded}
      setMarketingPrefs={setMarketingPrefs}
      setOpsPrefs={setOpsPrefs}
      statusBanner={statusBanner}
      testStatus={testStatus}
    />
  );
}
