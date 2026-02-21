import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { saveUserPreferences, getUserPreferences, registerForPushNotificationsAsync } from '../services/notificationService';
import { COLORS as THEME } from '../theme';

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  successGreen: THEME.success,
  headerBg: THEME.white,
};

const PreferenceSection = ({ title, children }) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionContent}>{children}</View>
  </View>
);

const ToggleRow = ({ label, icon, value, onValueChange, color = COLORS.primaryBlue }) => (
  <View style={styles.toggleRow}>
    <View style={styles.labelContainer}>
      <View style={[styles.iconCircle, { backgroundColor: `${color}20` }]}>
        <MaterialCommunityIcons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.labelText}>{label}</Text>
    </View>
    <Switch
      trackColor={{ false: '#CBD5E0', true: color }}
      thumbColor={Platform.OS === 'ios' ? '#FFF' : value ? color : '#f4f3f4'}
      ios_backgroundColor="#CBD5E0"
      onValueChange={onValueChange}
      value={value}
    />
  </View>
);

export default function NotificationPreferencesScreen({ onBack, userId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [emptyStateMessage, setEmptyStateMessage] = useState('');
  const [statusBanner, setStatusBanner] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState('');
  const [testStatus, setTestStatus] = useState({ type: '', message: '' });

  // 1. Operational Alerts (During the tour)
  const [opsPrefs, setOpsPrefs] = useState({
    driver_updates: true, // Driver announcements
    itinerary_changes: true, // Schedule changes
    group_chat: true, // All chat messages
    group_photos: false, // New photo uploads (can be spammy)
  });

  // 2. Marketing Interests (Future tours)
  const [marketingPrefs, setMarketingPrefs] = useState({
    steam_trains: false,
    mystery_tours: false,
    scotland_classics: false,
    vip_experiences: false,
    hiking_nature: false,
  });
  const [initialOpsPrefs, setInitialOpsPrefs] = useState(null);
  const [initialMarketingPrefs, setInitialMarketingPrefs] = useState(null);

  const hasChanges =
    initialOpsPrefs !== null &&
    initialMarketingPrefs !== null &&
    (JSON.stringify(opsPrefs) !== JSON.stringify(initialOpsPrefs) ||
      JSON.stringify(marketingPrefs) !== JSON.stringify(initialMarketingPrefs));

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
      const saved = await getUserPreferences(userId);
      const nextOpsPrefs = saved?.ops ? { ...opsPrefs, ...saved.ops } : { ...opsPrefs };
      const nextMarketingPrefs = saved?.marketing ? { ...marketingPrefs, ...saved.marketing } : { ...marketingPrefs };

      if (saved) {
        if (saved.ops) setOpsPrefs(nextOpsPrefs);
        if (saved.marketing) setMarketingPrefs(nextMarketingPrefs);
      }
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
    
    // Combine all preferences into a clean object structure
    const fullPreferences = {
      ops: opsPrefs,
      marketing: marketingPrefs,
      updatedAt: new Date().toISOString()
    };

    const result = await saveUserPreferences(userId, fullPreferences);

    setSaving(false);

    if (result.success) {
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
  };

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
              color={loadError ? '#E53E3E' : COLORS.primaryBlue}
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
        <TouchableOpacity onPress={onBack} style={styles.headerButton}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.darkText} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={styles.headerButton} /> 
      </View>

      <ScrollView contentContainerStyle={styles.scrollContainer}>
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
          Customize your alerts. We promise not to spam you.
        </Text>

        {/* SECTION 1: ON TOUR */}
        <PreferenceSection title="While On Tour">
          <ToggleRow
            label="Driver Announcements"
            icon="bullhorn-outline"
            value={opsPrefs.driver_updates}
            onValueChange={(v) => setOpsPrefs({ ...opsPrefs, driver_updates: v })}
            color="#E67E22" // Orange for importance
          />
          <ToggleRow
            label="Itinerary Updates"
            icon="clock-time-four-outline"
            value={opsPrefs.itinerary_changes}
            onValueChange={(v) => setOpsPrefs({ ...opsPrefs, itinerary_changes: v })}
          />
          <ToggleRow
            label="Group Chat Messages"
            icon="chat-processing-outline"
            value={opsPrefs.group_chat}
            onValueChange={(v) => setOpsPrefs({ ...opsPrefs, group_chat: v })}
          />
          <ToggleRow
            label="New Photo Uploads"
            icon="image-multiple-outline"
            value={opsPrefs.group_photos}
            onValueChange={(v) => setOpsPrefs({ ...opsPrefs, group_photos: v })}
          />
        </PreferenceSection>

        {/* SECTION 2: FUTURE TOURS */}
        <PreferenceSection title="Future Tour Interests">
          <Text style={styles.subText}>
            Be the first to know when we release dates for these specific experiences:
          </Text>
          
          <ToggleRow
            label="Steam Train Journeys"
            icon="train"
            value={marketingPrefs.steam_trains}
            onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, steam_trains: v })}
            color={COLORS.primaryBlue}
          />
          <ToggleRow
            label="Mystery Tours"
            icon="incognito"
            value={marketingPrefs.mystery_tours}
            onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, mystery_tours: v })}
            color="#9B59B6" // Purple for mystery
          />
          <ToggleRow
            label="Classic Scotland"
            icon="castle"
            value={marketingPrefs.scotland_classics}
            onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, scotland_classics: v })}
          />
          <ToggleRow
            label="VIP & Luxury"
            icon="star-face"
            value={marketingPrefs.vip_experiences}
            onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, vip_experiences: v })}
            color="#F1C40F" // Gold
          />
           <ToggleRow
            label="Hiking & Nature"
            icon="pine-tree"
            value={marketingPrefs.hiking_nature}
            onValueChange={(v) => setMarketingPrefs({ ...marketingPrefs, hiking_nature: v })}
            color="#27AE60" // Green
          />
        </PreferenceSection>

        {hasChanges ? (
          <TouchableOpacity
            style={[styles.saveButton, saving && styles.disabledButton]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={COLORS.white} />
            ) : (
              <Text style={styles.saveButtonText}>Save Preferences</Text>
            )}
          </TouchableOpacity>
        ) : (
          <View style={styles.noChangesCard}>
            <MaterialCommunityIcons name="check-circle-outline" size={16} color={COLORS.secondaryText} />
            <Text style={styles.noChangesText}>No unsaved changes</Text>
          </View>
        )}
        
        <TouchableOpacity
          style={styles.testButton}
          onPress={handleTestNotification}
          disabled={saving}
        >
          <MaterialCommunityIcons name="bell-check-outline" size={20} color={COLORS.secondaryText} />
          <Text style={styles.testButtonText}>Test Notification System</Text>
        </TouchableOpacity>

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
    borderBottomColor: '#E2E8F0',
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
  introText: {
    fontSize: 16,
    color: COLORS.secondaryText,
    marginBottom: 20,
    textAlign: 'center',
  },
  statusBanner: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
  },
  successBanner: {
    backgroundColor: `${COLORS.successGreen}12`,
    borderColor: `${COLORS.successGreen}55`,
  },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
  },
  infoBanner: {
    backgroundColor: `${COLORS.primaryBlue}12`,
    borderColor: `${COLORS.primaryBlue}55`,
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 16,
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
    alignItems: 'center',
  },
  labelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelText: {
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: '500',
  },
  saveButton: {
    backgroundColor: COLORS.primaryBlue,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
    shadowColor: COLORS.primaryBlue,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  disabledButton: {
    opacity: 0.7,
  },
  noChangesCard: {
    marginTop: 10,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
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
    color: '#A0AEC0',
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
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
