import React, { useState, useEffect, useMemo } from 'react';
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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import {
  saveUserPreferences,
  getUserPreferences,
  registerForPushNotificationsAsync,
  primeNotificationPermissions,
} from '../services/notificationService';
import { COLORS as THEME, SHADOWS } from '../theme';

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
  isOnboarding = false,
  audience = 'passenger',
  onComplete,
  returnTo,
}) {
  const defaultOpsPrefs = {
    driver_updates: true,
    itinerary_changes: true,
    group_chat: true,
    group_photos: false,
  };

  const defaultMarketingPrefs = {
    steam_trains: false,
    mystery_tours: false,
    scotland_classics: false,
    vip_experiences: false,
    hiking_nature: false,
  };

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

  const marketingPreferenceMeta = {
    steam_trains: {
      label: 'Steam Train Journeys',
      description: 'Scenic heritage rail adventures across Scotland.',
      icon: 'train',
      color: COLORS.primaryBlue,
    },
    mystery_tours: {
      label: 'Mystery Tours',
      description: 'Surprise destinations with curated premium experiences.',
      icon: 'incognito',
      color: COLORS.primaryLight,
    },
    scotland_classics: {
      label: 'Classic Scotland',
      description: 'Castles, lochs, and signature heritage routes.',
      icon: 'castle',
      color: COLORS.primaryBlue,
    },
    vip_experiences: {
      label: 'VIP & Luxury',
      description: 'High-touch premium experiences and limited departures.',
      icon: 'star-face',
      color: COLORS.warning,
      badge: 'Premium',
    },
    hiking_nature: {
      label: 'Hiking & Nature',
      description: 'Outdoor-focused trips through Highlands and scenic trails.',
      icon: 'pine-tree',
      color: COLORS.successGreen,
    },
  };

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
  const [activeMarketingPreset, setActiveMarketingPreset] = useState('recommended');

  // 1. Operational Alerts (During the tour)
  const [opsPrefs, setOpsPrefs] = useState(defaultOpsPrefs);

  // 2. Marketing Interests (Future tours)
  const [marketingPrefs, setMarketingPrefs] = useState(defaultMarketingPrefs);
  const [initialOpsPrefs, setInitialOpsPrefs] = useState(null);
  const [initialMarketingPrefs, setInitialMarketingPrefs] = useState(null);

  const hasChanges =
    initialOpsPrefs !== null &&
    initialMarketingPrefs !== null &&
    (JSON.stringify(opsPrefs) !== JSON.stringify(initialOpsPrefs) ||
      JSON.stringify(marketingPrefs) !== JSON.stringify(initialMarketingPrefs));

  const opsEnabledCount = useMemo(() => Object.values(opsPrefs).filter(Boolean).length, [opsPrefs]);
  const marketingEnabledCount = useMemo(() => Object.values(marketingPrefs).filter(Boolean).length, [marketingPrefs]);

  const formatTimestamp = (isoDate) => {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const loadPreferences = async () => {
    setLoading(true);
    setLoadError('');
    setEmptyStateMessage('');
    setStatusBanner(null);

    if (!userId) {
      setEmptyStateMessage('Sign in to manage notifications.');
      setLoading(false);
      return;
    }

    try {
      const permissionProbe = await primeNotificationPermissions({
        userId,
        requestIfNeeded: false,
      });
      if (permissionProbe?.success) {
        setPermissionStatus(permissionProbe.data);
      }

      const saved = await getUserPreferences(userId, { throwOnError: true });
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
    } catch (error) {
      setLoadError('We could not load your notification settings. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPreferences();
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    setStatusBanner(null);

    try {
      const fullPreferences = {
        ops: opsPrefs,
        marketing: marketingPrefs,
        updatedAt: new Date().toISOString(),
      };

      const result = await saveUserPreferences(userId, fullPreferences);

      if (result.success) {
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
        setStatusBanner({
          type: 'error',
          message: 'Could not save settings. Please check your internet connection and try again.',
        });
      }
    } catch (error) {
      setStatusBanner({
        type: 'error',
        message: 'Unexpected error while saving preferences. Please retry.',
      });
    } finally {
      setSaving(false);
    }
  };

  const completeOnboarding = async (status) => {
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
    if (!userId) return;
    setOnboardingActionBusy(true);
    setStatusBanner(null);

    const permissionProbe = await primeNotificationPermissions({
      userId,
      requestIfNeeded: true,
    });

    if (!permissionProbe?.success) {
      setOnboardingActionBusy(false);
      setStatusBanner({
        type: 'error',
        message: permissionProbe?.error || 'Could not check permissions right now. Please try again.',
      });
      return;
    }

    setPermissionStatus(permissionProbe.data);

    const fullPreferences = {
      ops: opsPrefs,
      marketing: marketingPrefs,
      updatedAt: new Date().toISOString(),
    };

    const saveResult = await saveUserPreferences(userId, fullPreferences);

    if (!saveResult.success) {
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
    await completeOnboarding('completed');
  };

  const handleMaybeLater = async () => {
    await completeOnboarding('skipped');
  };

  const applyOpsPreset = (preset) => {
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
    setActiveMarketingPreset(preset);
    if (preset === 'recommended') {
      setMarketingPrefs({
        steam_trains: true,
        mystery_tours: true,
        scotland_classics: true,
        vip_experiences: false,
        hiking_nature: true,
      });
      return;
    }

    if (preset === 'all') {
      setMarketingPrefs({
        steam_trains: true,
        mystery_tours: true,
        scotland_classics: true,
        vip_experiences: true,
        hiking_nature: true,
      });
      return;
    }

    setMarketingPrefs({
      steam_trains: false,
      mystery_tours: false,
      scotland_classics: false,
      vip_experiences: false,
      hiking_nature: false,
    });
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
      setTestStatus({ type: 'progress', message: 'Checking notification permissions…' });
      
      const token = await registerForPushNotificationsAsync();
      
      if (!token) {
        setTestStatus({
          type: 'error',
          message: 'Permission check failed. Enable notifications in device settings and retry.',
        });
        return;
      }

      setTestStatus({ type: 'progress', message: 'Sending a local test notification…' });

      await Notifications.scheduleNotificationAsync({
        content: {
          title: "System Check Passed! ✅",
          body: "Your device is correctly configured to receive Loch Lomond Travel updates.",
          sound: true,
        },
        trigger: null, // null means trigger immediately
      });

      setTestStatus({
        type: 'success',
        message: 'Test notification sent successfully. If you did not see it, check OS notification settings.',
      });

    } catch (error) {
      setTestStatus({
        type: 'error',
        message: `Test failed: ${error.message || 'Unknown error'}`,
      });
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
          <TouchableOpacity onPress={onBack} style={styles.headerButton}>
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
              <TouchableOpacity style={styles.retryButton} onPress={loadPreferences}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.retryButton} onPress={onBack}>
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
          <TouchableOpacity onPress={onBack} style={styles.headerButton}>
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
          <View style={[styles.statusBanner, statusBanner.type === 'error' ? styles.errorBanner : styles.successBanner]}>
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
            >
              <Text style={[styles.presetChipText, activeOpsPreset === 'essential' && styles.presetChipTextActive]}>Essential</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.presetChip, activeOpsPreset === 'all' && styles.presetChipActive]}
              onPress={() => applyOpsPreset('all')}
            >
              <Text style={[styles.presetChipText, activeOpsPreset === 'all' && styles.presetChipTextActive]}>All on</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.presetChip, activeOpsPreset === 'none' && styles.presetChipActive]}
              onPress={() => applyOpsPreset('none')}
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
              onValueChange={(v) => setOpsPrefs({ ...opsPrefs, [key]: v })}
              color={meta.color}
              badge={meta.badge}
              disabled={saving || onboardingActionBusy}
            />
          ))}
        </PreferenceSection>

        {/* SECTION 2: FUTURE TOURS */}
        <PreferenceSection
          title="Future Tour Interests"
          subtitle="Tell us what you want to hear about after this trip."
          enabledCount={marketingEnabledCount}
          totalCount={Object.keys(defaultMarketingPrefs).length}
        >
          <Text style={styles.subText}>
            Be the first to know when we release dates for these specific experiences:
          </Text>

          <View style={styles.presetRow}>
            <TouchableOpacity
              style={[styles.presetChip, activeMarketingPreset === 'recommended' && styles.presetChipActive]}
              onPress={() => applyMarketingPreset('recommended')}
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
            >
              <Text style={[styles.presetChipText, activeMarketingPreset === 'all' && styles.presetChipTextActive]}>All on</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.presetChip, activeMarketingPreset === 'none' && styles.presetChipActive]}
              onPress={() => applyMarketingPreset('none')}
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
              onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, [key]: v })}
              color={meta.color}
              badge={meta.badge}
              disabled={saving || onboardingActionBusy}
            />
          ))}
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
          >
            <MaterialCommunityIcons name="bell-check-outline" size={20} color={COLORS.secondaryText} />
            <Text style={styles.testButtonText}>Test Notification System</Text>
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: COLORS.secondaryText,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.headerBg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
  },
  headerButton: {
    padding: 4,
    minWidth: 40,
  },
  scrollContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  heroCard: {
    borderRadius: 18,
    padding: 20,
    marginBottom: 20,
    ...SHADOWS.lg,
  },
  heroIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.white,
    lineHeight: 29,
  },
  heroSubtitle: {
    marginTop: 10,
    fontSize: 15,
    color: 'rgba(255,255,255,0.95)',
    lineHeight: 22,
  },
  permissionBadgeRow: {
    marginTop: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: COLORS.white,
  },
  permissionBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  heroInfoCard: {
    marginTop: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    padding: 12,
  },
  heroInfoTitle: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 14,
  },
  heroInfoBody: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.95)',
    fontSize: 13,
    lineHeight: 18,
  },
  introText: {
    fontSize: 16,
    color: COLORS.secondaryText,
    marginBottom: 20,
    textAlign: 'center',
  },
  healthCard: {
    backgroundColor: COLORS.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    marginBottom: 18,
  },
  healthHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  healthHeaderText: { flex: 1 },
  healthTitle: {
    color: COLORS.darkText,
    fontSize: 15,
    fontWeight: '700',
  },
  healthSubtitle: {
    marginTop: 4,
    color: COLORS.secondaryText,
    fontSize: 12,
    lineHeight: 18,
  },
  healthScorePill: {
    borderRadius: 999,
    backgroundColor: THEME.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.lightBlueAccent,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  healthScoreText: {
    color: COLORS.primaryBlue,
    fontWeight: '800',
    fontSize: 12,
  },
  healthProgressTrack: {
    marginTop: 10,
    height: 8,
    borderRadius: 999,
    backgroundColor: COLORS.appBackground,
    overflow: 'hidden',
  },
  healthProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: COLORS.primaryBlue,
  },
  healthMetaRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  healthMetaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.appBackground,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  healthMetaText: {
    fontSize: 12,
    fontWeight: '700',
  },
  healthSummaryText: {
    color: COLORS.secondaryText,
    fontSize: 12,
    fontWeight: '600',
  },
  statusBanner: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
  },
  successBanner: {
    backgroundColor: COLORS.successLight,
    borderColor: COLORS.successGreen,
  },
  errorBanner: {
    backgroundColor: COLORS.dangerLight,
    borderColor: COLORS.danger,
  },
  infoBanner: {
    backgroundColor: THEME.primaryMuted,
    borderColor: COLORS.lightBlueAccent,
  },
  statusBannerText: {
    color: COLORS.darkText,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  inlineActionButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: COLORS.primaryBlue,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineActionButtonText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '700',
  },
  lastSavedText: {
    fontSize: 13,
    color: COLORS.secondaryText,
    textAlign: 'center',
    marginBottom: 8,
  },
  section: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
    ...SHADOWS.md,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 16,
    alignItems: 'flex-start',
  },
  sectionHeaderTextWrap: {
    flex: 1,
  },
  sectionSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: COLORS.secondaryText,
    lineHeight: 18,
  },
  sectionCountPill: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: COLORS.appBackground,
  },
  sectionCountText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '700',
  },
  sectionContent: {
    gap: 16,
  },
  subText: {
    fontSize: 14,
    color: COLORS.secondaryText,
    marginBottom: 12,
    lineHeight: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  labelContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    flex: 1,
  },
  labelTextWrap: { flex: 1 },
  labelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelText: {
    fontSize: 15,
    color: COLORS.darkText,
    fontWeight: '600',
  },
  labelDescription: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.secondaryText,
  },
  labelBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primaryBlue,
    backgroundColor: THEME.primaryMuted,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  saveButton: {
    backgroundColor: COLORS.primaryBlue,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
    ...SHADOWS.lg,
  },
  saveCard: {
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
    ...SHADOWS.lg,
  },
  saveCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  saveCardHeaderText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '800',
  },
  saveCardBody: {
    color: 'rgba(255,255,255,0.92)',
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
  },
  saveButtonOnGradient: {
    marginTop: 12,
    backgroundColor: COLORS.white,
    marginBottom: 0,
  },
  saveButtonTextOnGradient: {
    color: COLORS.primaryBlue,
    fontSize: 17,
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.7,
  },
  noChangesCard: {
    marginTop: 10,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  noChangesText: {
    color: COLORS.secondaryText,
    fontSize: 14,
    fontWeight: '600',
  },
  saveButtonText: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '700',
  },
  onboardingActionWrap: {
    marginTop: 8,
  },
  secondaryOnboardingButton: {
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 12,
    backgroundColor: COLORS.white,
  },
  secondaryOnboardingButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.secondaryText,
  },
  // New Styles for Test Button
  testButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    padding: 10,
    gap: 8,
  },
  testButtonText: {
    color: COLORS.secondaryText,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  privacyNote: {
    textAlign: 'center',
    marginTop: 20,
    fontSize: 13,
    color: COLORS.tertiaryText,
  },
  permissionSummaryCard: {
    backgroundColor: COLORS.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    marginBottom: 18,
  },
  permissionSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  permissionSummaryTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  permissionSummaryState: {
    marginTop: 8,
    fontSize: 16,
    fontWeight: '700',
  },
  permissionSummaryBody: {
    marginTop: 4,
    fontSize: 13,
    color: COLORS.secondaryText,
    lineHeight: 18,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  presetChip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.appBackground,
  },
  presetChipActive: {
    borderColor: COLORS.primaryBlue,
    backgroundColor: THEME.primaryMuted,
  },
  presetChipText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '700',
  },
  presetChipTextActive: {
    color: COLORS.primaryBlue,
  },
  emptyPanelContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  emptyPanel: {
    width: '100%',
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    ...SHADOWS.md,
  },
  emptyPanelTitle: {
    marginTop: 12,
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
  },
  emptyPanelMessage: {
    marginTop: 8,
    fontSize: 14,
    color: COLORS.secondaryText,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: COLORS.primaryBlue,
  },
  retryButtonText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 14,
  },
});
