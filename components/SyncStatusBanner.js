import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import offlineSyncService from '../services/offlineSyncService';
import { COLORS as THEME, RADIUS, SPACING, SHADOWS, FONT_WEIGHT } from '../theme';

const FONT_WEIGHTS = FONT_WEIGHT || {
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};

const SEVERITY_STYLES = {
  success: {
    backgroundColor: THEME.sync.success.background,
    borderColor: THEME.sync.success.border,
    iconColor: THEME.sync.success.foreground,
    textColor: THEME.sync.success.foreground,
    mutedTextColor: THEME.sync.success.foregroundMuted,
    accentColor: THEME.sync.success.foreground,
  },
  warning: {
    backgroundColor: THEME.sync.warning.background,
    borderColor: THEME.sync.warning.border,
    iconColor: THEME.sync.warning.foreground,
    textColor: THEME.sync.warning.foreground,
    mutedTextColor: THEME.sync.warning.foregroundMuted,
    accentColor: THEME.sync.warning.foreground,
  },
  critical: {
    backgroundColor: THEME.sync.critical.background,
    borderColor: THEME.sync.critical.border,
    iconColor: THEME.sync.critical.foreground,
    textColor: THEME.sync.critical.foreground,
    mutedTextColor: THEME.sync.critical.foregroundMuted,
    accentColor: THEME.sync.critical.foreground,
  },
  error: {
    backgroundColor: THEME.sync.critical.background,
    borderColor: THEME.sync.critical.border,
    iconColor: THEME.sync.critical.foreground,
    textColor: THEME.sync.critical.foreground,
    mutedTextColor: THEME.sync.critical.foregroundMuted,
    accentColor: THEME.sync.critical.foreground,
  },
  info: {
    backgroundColor: THEME.sync.info.background,
    borderColor: THEME.sync.info.border,
    iconColor: THEME.sync.info.foreground,
    textColor: THEME.sync.info.foreground,
    mutedTextColor: THEME.sync.info.foregroundMuted,
    accentColor: THEME.sync.info.foreground,
  },
};

const SEVERITY_PROGRESS = {
  success: 100,
  warning: 55,
  critical: 20,
  error: 20,
  info: 75,
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
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.88 } : {};

  const progressValue = useMemo(() => {
    const mapped = SEVERITY_PROGRESS[state.severity] ?? SEVERITY_PROGRESS.info;
    if (!showRetry) {
      return Math.min(mapped + 10, 100);
    }
    return mapped;
  }, [showRetry, state.severity]);

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
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${state.label}. Open sync details.` : undefined}
      {...wrapperProps}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <View style={[styles.iconWrap, { backgroundColor: `${severityStyle.iconColor}20` }]}>
            <MaterialCommunityIcons
              name={state.icon || 'information-outline'}
              size={16}
              color={severityStyle.iconColor}
            />
          </View>
          <View style={styles.titleWrap}>
            <Text style={[styles.label, { color: severityStyle.textColor }]}>{state.label}</Text>
            {!!state.description && (
              <Text style={[styles.description, { color: severityStyle.textColor }]}>{state.description}</Text>
            )}
          </View>
        </View>

        {showRetry ? (
          <TouchableOpacity
            style={[styles.retryButton, { borderColor: `${severityStyle.iconColor}66` }]}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
          >
            <MaterialCommunityIcons name="refresh" size={14} color={severityStyle.iconColor} />
            <Text style={[styles.retryText, { color: severityStyle.iconColor }]}>{retryLabel}</Text>
          </TouchableOpacity>
        ) : (
          <View style={[styles.healthPill, { borderColor: `${severityStyle.iconColor}44` }]}>
            <Text style={[styles.healthPillText, { color: severityStyle.iconColor }]}>Stable</Text>
          </View>
        )}
      </View>

      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${progressValue}%`,
              backgroundColor: severityStyle.accentColor,
            },
          ]}
        />
      </View>

      {!!outcomeText && <Text style={[styles.outcomeText, { color: severityStyle.mutedTextColor }]}>{outcomeText}</Text>}

      {state.showLastSync && (
        <View style={styles.metaRow}>
          <MaterialCommunityIcons name="clock-check-outline" size={13} color={severityStyle.mutedTextColor} />
          <Text style={[styles.lastSyncText, { color: severityStyle.mutedTextColor }]}>
            Last successful sync {relativeLastSync}
          </Text>
        </View>
      )}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.sm,
    ...SHADOWS.sm,
  },
  compact: {
    paddingVertical: SPACING.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flex: 1,
    gap: SPACING.sm,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: RADIUS.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 1,
  },
  titleWrap: {
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: FONT_WEIGHTS.bold,
    marginBottom: 2,
  },
  description: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: FONT_WEIGHTS.medium,
  },
  progressTrack: {
    marginTop: SPACING.sm,
    height: 6,
    borderRadius: RADIUS.full,
    backgroundColor: THEME.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: RADIUS.full,
  },
  outcomeText: {
    marginTop: SPACING.xs,
    fontSize: 12,
    fontWeight: FONT_WEIGHTS.semibold,
  },
  metaRow: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  lastSyncText: {
    fontSize: 11,
    fontWeight: FONT_WEIGHTS.medium,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  retryText: {
    fontSize: 11,
    fontWeight: FONT_WEIGHTS.bold,
  },
  healthPill: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  healthPillText: {
    fontSize: 10,
    fontWeight: FONT_WEIGHTS.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
