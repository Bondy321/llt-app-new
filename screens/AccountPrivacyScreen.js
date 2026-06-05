import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  DATA_REQUEST_EMAIL,
  PRIVACY_POLICY_URL,
  deleteCurrentAccount,
} from '../services/accountDeletionService';
import logger, { maskIdentifier } from '../services/loggerService';
import { COLORS, FONT_WEIGHT, RADIUS, SHADOWS, SPACING } from '../theme';

const getAccountLabel = ({ bookingData, isDriverSession }) => {
  const rawId = typeof bookingData?.id === 'string' ? bookingData.id.trim() : '';
  if (isDriverSession) return rawId || 'Driver account';
  return rawId || 'Tour account';
};

const openUrl = async (url, label) => {
  try {
    await Linking.openURL(url);
    return true;
  } catch (error) {
    logger.warn('AccountPrivacy', 'External link failed', {
      label,
      error: error?.message || String(error),
    });
    Alert.alert('Could not open link', 'Please try again when you have an internet connection.');
    return false;
  }
};

const RowButton = ({ icon, title, subtitle, onPress, destructive = false, disabled = false, rightAccessory = null }) => (
  <TouchableOpacity
    style={[styles.rowButton, destructive && styles.rowButtonDanger, disabled && styles.disabled]}
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.82}
    accessibilityRole="button"
    accessibilityLabel={title}
  >
    <View style={[styles.rowIcon, destructive && styles.rowIconDanger]}>
      <MaterialCommunityIcons
        name={icon}
        size={22}
        color={destructive ? COLORS.error : COLORS.primary}
      />
    </View>
    <View style={styles.rowBody}>
      <Text style={[styles.rowTitle, destructive && styles.dangerText]}>{title}</Text>
      {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
    </View>
    {rightAccessory || (
      <MaterialCommunityIcons
        name="chevron-right"
        size={22}
        color={destructive ? COLORS.error : COLORS.textMuted}
      />
    )}
  </TouchableOpacity>
);

export default function AccountPrivacyScreen({
  onBack,
  onLogout,
  onAccountDeleted,
  tourData,
  bookingData,
  canonicalIdentity,
  identityBinding,
  isDriverSession = false,
  sessionStorage,
  sessionKeys,
}) {
  const [deleting, setDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const accountLabel = getAccountLabel({ bookingData, isDriverSession });

  const handleDeleteConfirmed = async () => {
    setDeleting(true);
    setStatusMessage('Deleting your app account...');

    const result = await deleteCurrentAccount({
      tourData,
      bookingData,
      canonicalIdentity,
      identityBinding,
      isDriverSession,
      sessionStorage,
      sessionKeys,
    });

    setDeleting(false);

    if (!result.success) {
      setStatusMessage('');
      Alert.alert('Account deletion failed', result.error || 'Please check your connection and try again.');
      return;
    }

    const warningText = result.warnings?.length
      ? ' Some shared tour records may require manual review by Loch Lomond Travel.'
      : '';

    setStatusMessage('Account deleted.');
    Alert.alert(
      'Account deleted',
      `Your app account and local app data were deleted.${warningText}`,
      [
        {
          text: 'Done',
          onPress: () => onAccountDeleted?.(result),
        },
      ]
    );
  };

  const handleDeletePress = () => {
    logger.info('AccountPrivacy', 'Delete account confirmation opened', {
      accountLabel: maskIdentifier(accountLabel),
      isDriverSession,
    });

    Alert.alert(
      'Delete account?',
      'This removes your app account, notification preferences, local offline data, and your active-tour app content where possible. Your travel booking may still be retained by Loch Lomond Travel where required.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: handleDeleteConfirmed,
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Account & privacy</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <LinearGradient
          colors={[COLORS.primary, COLORS.primaryDark]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          <View style={styles.heroIcon}>
            <MaterialCommunityIcons name="account-shield" size={28} color={COLORS.white} />
          </View>
          <Text style={styles.heroTitle}>Your app account</Text>
          <Text style={styles.heroSubtitle}>{accountLabel}</Text>
        </LinearGradient>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Privacy</Text>
          <RowButton
            icon="file-document-outline"
            title="Privacy Policy"
            subtitle="View how Loch Lomond Travel handles personal data."
            onPress={() => openUrl(PRIVACY_POLICY_URL, 'privacy_policy')}
          />
          <RowButton
            icon="email-outline"
            title="Data request support"
            subtitle="Ask about access, correction, retention, or booking-record deletion."
            onPress={() => openUrl(`mailto:${DATA_REQUEST_EMAIL}`, 'data_request_email')}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account actions</Text>
          <RowButton
            icon="logout-variant"
            title="Log out"
            subtitle="Keep this app account and return to sign-in."
            onPress={onLogout}
            disabled={deleting}
          />
          <RowButton
            icon="account-remove-outline"
            title="Delete account"
            subtitle="Remove this app account and app-stored data from this device and active tour."
            onPress={handleDeletePress}
            destructive
            disabled={deleting}
            rightAccessory={deleting ? <ActivityIndicator color={COLORS.error} /> : null}
          />
        </View>

        <View style={styles.notice}>
          <MaterialCommunityIcons name="information-outline" size={20} color={COLORS.primary} />
          <Text style={styles.noticeText}>
            Deleting your account removes the app account used for this device. Travel booking records may be kept by Loch Lomond Travel where they are needed for operations, safety, legal, or accounting reasons.
          </Text>
        </View>

        {statusMessage ? (
          <View style={styles.statusPanel}>
            <ActivityIndicator color={COLORS.primary} animating={deleting} />
            <Text style={styles.statusText}>{statusMessage}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    minHeight: 56,
    paddingHorizontal: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 18,
    color: COLORS.textPrimary,
    fontWeight: FONT_WEIGHT.bold,
  },
  content: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  hero: {
    borderRadius: RADIUS.lg,
    padding: SPACING.xl,
    ...SHADOWS.md,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.md,
  },
  heroTitle: {
    color: COLORS.white,
    fontSize: 22,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  heroSubtitle: {
    color: COLORS.primaryMuted,
    fontSize: 14,
    fontWeight: FONT_WEIGHT.semibold,
    marginTop: SPACING.xs,
  },
  section: {
    gap: SPACING.sm,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: FONT_WEIGHT.bold,
    marginBottom: SPACING.xs,
  },
  rowButton: {
    minHeight: 76,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    backgroundColor: COLORS.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  rowButtonDanger: {
    borderColor: COLORS.error,
    backgroundColor: COLORS.errorLight,
  },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryMuted,
  },
  rowIconDanger: {
    backgroundColor: COLORS.white,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: FONT_WEIGHT.bold,
  },
  rowSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  dangerText: {
    color: COLORS.error,
  },
  disabled: {
    opacity: 0.65,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: '#93C5FD',
    padding: SPACING.md,
  },
  noticeText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  statusPanel: {
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  statusText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: FONT_WEIGHT.semibold,
  },
});
