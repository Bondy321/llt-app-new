import {
  ActivityIndicator, Platform, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import createNotificationPreferencesScreenStyles from '../../screens/styles/NotificationPreferencesScreen.styles';
import { COLORS as THEME, SHADOWS } from '../../theme';
import NotificationFeedCard from '../NotificationFeedCard';
import { COLORS } from './notificationPreferenceTheme';

const styles = createNotificationPreferencesScreenStyles({ StyleSheet, COLORS, SHADOWS, THEME });

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
  permissionStatus,
  deviceReadiness,
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
          <Text style={styles.healthSubtitle}>
            Permission: {permissionStatus?.state || 'unavailable'} · Device token: {deviceReadiness?.tokenHealthy ? 'ready' : 'not registered'}
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


export default function NotificationPreferencesView({
  activeMarketingPreset,
  activeOnboardingCopy,
  activeOpsPreset,
  applyMarketingPreset,
  applyOpsPreset,
  emptyStateMessage,
  deviceReadiness,
  formatTimestamp,
  handleEnableNow,
  handleMarkAllNotificationsRead,
  handleMaybeLater,
  handleOpenNotification,
  handleOpenSettings,
  handleRetryNotificationFeed,
  handleSave,
  handleTestNotification,
  hasChanges,
  isOnboarding,
  lastSavedAt,
  loadError,
  loadPreferences,
  loading,
  marketingEnabledCount,
  marketingExpanded,
  marketingPreferenceMeta,
  marketingPrefs,
  notificationFeed,
  notificationFeedBusy,
  notificationFeedError,
  notificationFeedLoading,
  notificationFeedStale,
  notificationUnreadCount,
  onBack,
  onboardingActionBusy,
  opsEnabledCount,
  opsPreferenceMeta,
  opsPrefs,
  permissionStatus,
  permissionTone,
  saving,
  setMarketingExpanded,
  setMarketingPrefs,
  setOpsPrefs,
  statusBanner,
  testStatus,
}) {
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
          permissionStatus={permissionStatus}
          deviceReadiness={deviceReadiness}
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
            {permissionStatus?.state === 'blocked' ? (
              <TouchableOpacity
                style={styles.testButton}
                onPress={handleOpenSettings}
                accessibilityRole="button"
                accessibilityLabel="Open device notification settings"
              >
                <Text style={styles.testButtonText}>Open device settings</Text>
              </TouchableOpacity>
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

            {permissionStatus?.state === 'blocked' ? (
              <TouchableOpacity
                style={styles.secondaryOnboardingButton}
                onPress={handleOpenSettings}
                disabled={onboardingActionBusy || saving}
                accessibilityRole="button"
                accessibilityLabel="Open device notification settings"
              >
                <Text style={styles.secondaryOnboardingButtonText}>Open device settings</Text>
              </TouchableOpacity>
            ) : null}

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
            accessibilityLabel="Send a local display test notification"
            accessibilityState={{ disabled: saving }}
          >
            <MaterialCommunityIcons name="bell-check-outline" size={20} color={COLORS.secondaryText} />
            <Text style={styles.testButtonText}>Run local display test</Text>
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
