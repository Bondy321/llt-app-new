import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import offlineSyncService from '../services/offlineSyncService';
import { COLORS as THEME, RADIUS, SPACING } from '../theme';

const SEVERITY_STYLES = {
  success: {
    backgroundColor: THEME.successLight,
    borderColor: `${THEME.success}66`,
    iconColor: THEME.success,
    textColor: THEME.textPrimary,
  },
  warning: {
    backgroundColor: THEME.warningLight,
    borderColor: `${THEME.warning}66`,
    iconColor: THEME.warning,
    textColor: THEME.textPrimary,
  },
  critical: {
    backgroundColor: THEME.errorLight,
    borderColor: `${THEME.error}66`,
    iconColor: THEME.error,
    textColor: THEME.textPrimary,
  },
  error: {
    backgroundColor: THEME.errorLight,
    borderColor: `${THEME.error}66`,
    iconColor: THEME.error,
    textColor: THEME.textPrimary,
  },
  info: {
    backgroundColor: THEME.primaryMuted,
    borderColor: `${THEME.primary}66`,
    iconColor: THEME.primary,
    textColor: THEME.textPrimary,
  },
};

export default function SyncStatusBanner({
  state,
  outcomeText,
  lastSyncAt,
  onRetry,
  retryLabel = 'Retry now',
  onPress,
  compact = false,
}) {
  if (!state) return null;

  const severityStyle = SEVERITY_STYLES[state.severity] || SEVERITY_STYLES.info;
  const showRetry = Boolean(state.canRetry && onRetry);
  const relativeLastSync = state.showLastSync
    ? offlineSyncService.formatLastSyncRelative(lastSyncAt)
    : null;

  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.85 } : {};

  return (
    <Wrapper
      style={[
        styles.container,
        compact && styles.compact,
        {
          backgroundColor: severityStyle.backgroundColor,
          borderColor: severityStyle.borderColor,
        },
      ]}
      {...wrapperProps}
    >
      <MaterialCommunityIcons
        name={state.icon || 'information-outline'}
        size={18}
        color={severityStyle.iconColor}
        style={styles.icon}
      />
      <View style={styles.content}>
        <Text style={[styles.label, { color: severityStyle.textColor }]}>{state.label}</Text>
        {!!state.description && (
          <Text style={[styles.description, { color: severityStyle.textColor }]}>{state.description}</Text>
        )}
        {!!outcomeText && <Text style={styles.outcomeText}>{outcomeText}</Text>}
        {state.showLastSync && (
          <Text style={styles.lastSyncText}>Last successful sync {relativeLastSync}</Text>
        )}
        {showRetry && (
          <TouchableOpacity
            style={[styles.retryButton, { borderColor: `${severityStyle.iconColor}55` }]}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
          >
            <Text style={[styles.retryText, { color: severityStyle.iconColor }]}>{retryLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  compact: {
    paddingVertical: SPACING.xs,
  },
  icon: {
    marginTop: 2,
  },
  content: {
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
  },
  outcomeText: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
    color: THEME.textSecondary,
  },
  lastSyncText: {
    marginTop: 3,
    fontSize: 11,
    color: THEME.textSecondary,
  },
  retryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
