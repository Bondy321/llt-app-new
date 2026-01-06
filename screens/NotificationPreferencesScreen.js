import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  ScrollView,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform
} from 'react-native';
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

  useEffect(() => {
    loadPreferences();
  }, []);

  const loadPreferences = async () => {
    if (!userId) return;
    const saved = await getUserPreferences(userId);
    if (saved) {
      // Merge saved preferences with defaults (handles new keys added later)
      if (saved.ops) setOpsPrefs(prev => ({ ...prev, ...saved.ops }));
      if (saved.marketing) setMarketingPrefs(prev => ({ ...prev, ...saved.marketing }));
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    
    // Combine all preferences into a clean object structure
    const fullPreferences = {
      ops: opsPrefs,
      marketing: marketingPrefs,
      updatedAt: new Date().toISOString()
    };

    const result = await saveUserPreferences(userId, fullPreferences);

    setSaving(false);

    if (result.success) {
      Alert.alert(
        "Preferences Saved",
        "We'll only send you notifications based on your choices.",
        [{ text: "OK", onPress: onBack }]
      );
    } else {
      Alert.alert("Error", "Could not save settings. Please check your internet connection.");
    }
  };

  // --- NEW TEST FUNCTION ---
  const handleTestNotification = async () => {
    try {
      setSaving(true); // Reusing saving state to show activity indicator
      
      // 1. Verify we can get a token (checks permissions)
      const token = await registerForPushNotificationsAsync();
      
      if (!token) {
        Alert.alert(
          "Permission Issue", 
          "Could not verify notification permissions. Please check your device settings."
        );
        setSaving(false);
        return;
      }

      // 2. Schedule a local notification immediately
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "System Check Passed! ✅",
          body: "Your device is correctly configured to receive Loch Lomond Travel updates.",
          sound: true,
        },
        trigger: null, // null means trigger immediately
      });

      // Optional: Log the token to console if you need to copy it for backend testing later
      console.log('Test Notification Triggered. Token:', token);
      
    } catch (error) {
      Alert.alert("Test Failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
      </View>
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
        
        {/* --- NEW DIAGNOSTICS BUTTON --- */}
        <TouchableOpacity
          style={styles.testButton}
          onPress={handleTestNotification}
          disabled={saving}
        >
          <MaterialCommunityIcons name="bell-check-outline" size={20} color={COLORS.secondaryText} />
          <Text style={styles.testButtonText}>Test Notification System</Text>
        </TouchableOpacity>

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
});