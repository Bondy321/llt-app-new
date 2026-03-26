import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, RADIUS, SPACING } from '../theme';

export default function DriverHomeScreen({ driverData, onLogout, onNavigate }) {
  const activeTourId = driverData?.assignedTourId || driverData?.currentTourId || null;
  const hasTour = Boolean(activeTourId);

  const quickActions = hasTour
    ? [
        {
          key: 'manifest',
          title: 'Passenger Manifest',
          subtitle: 'Boarding status, seat checks, and no-show controls.',
          icon: 'clipboard-list-outline',
          color: COLORS.primary,
          action: () => onNavigate('PassengerManifest', { tourId: activeTourId }),
          cta: 'Open manifest',
        },
        {
          key: 'chat',
          title: 'Driver & Group Chat',
          subtitle: 'Coordinate with HQ and passengers in real time.',
          icon: 'chat-processing-outline',
          color: COLORS.accent,
          action: () => onNavigate('Chat', { tourId: activeTourId, isDriver: true }),
          cta: 'Open chat',
        },
        {
          key: 'itinerary',
          title: 'Live Itinerary',
          subtitle: 'Review timings, route updates, and stop sequence.',
          icon: 'map-clock-outline',
          color: COLORS.success,
          action: () => onNavigate('DriverItinerary', { tourId: activeTourId }),
          cta: 'Open itinerary',
        },
      ]
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <LinearGradient
          colors={[COLORS.primary, COLORS.primaryLight || COLORS.primary]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View style={styles.heroIconWrap}>
            <MaterialCommunityIcons name="steering" size={24} color={COLORS.white} />
          </View>
          <Text style={styles.heroTitle}>Driver Console</Text>
          <Text style={styles.heroSubtitle}>
            Web mission control for QA and dispatch support when mobile devices are unavailable.
          </Text>
          <View style={styles.heroPill}>
            <MaterialCommunityIcons
              name={hasTour ? 'check-decagram' : 'clock-alert-outline'}
              size={14}
              color={hasTour ? COLORS.success : COLORS.warning}
            />
            <Text style={[styles.heroPillText, { color: hasTour ? COLORS.success : COLORS.warning }]}>
              {hasTour ? 'Tour assigned and ready' : 'Awaiting dispatch assignment'}
            </Text>
          </View>
        </LinearGradient>

        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Driver Profile</Text>
            <Text style={styles.statValue}>{driverData?.name || driverData?.id || 'Unknown driver'}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Current Tour</Text>
            <Text style={styles.statValue}>{activeTourId || 'Not assigned'}</Text>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Quick Actions</Text>
          <Text style={styles.panelSubtitle}>
            Access the most important operational tools from web with one click.
          </Text>

          {hasTour ? (
            <View style={styles.actionsColumn}>
              {quickActions.map((action) => (
                <TouchableOpacity key={action.key} style={styles.actionCard} onPress={action.action} activeOpacity={0.85}>
                  <View style={[styles.actionIconCircle, { backgroundColor: `${action.color}18` }]}>
                    <MaterialCommunityIcons name={action.icon} size={20} color={action.color} />
                  </View>
                  <View style={styles.actionTextWrap}>
                    <Text style={styles.actionTitle}>{action.title}</Text>
                    <Text style={styles.actionSubtitle}>{action.subtitle}</Text>
                    <Text style={[styles.actionCta, { color: action.color }]}>{action.cta}</Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <View style={styles.emptyStateCard}>
              <MaterialCommunityIcons name="bus-clock" size={26} color={COLORS.warning} />
              <Text style={styles.emptyStateTitle}>No active tour yet</Text>
              <Text style={styles.emptyStateBody}>
                Once dispatch assigns a tour, your manifest and driver workflows will appear automatically.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.footerActions}>
          <TouchableOpacity style={styles.secondaryButton} onPress={onLogout}>
            <MaterialCommunityIcons name="logout" size={18} color={COLORS.textPrimary} />
            <Text style={styles.secondaryButtonText}>Log out securely</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
    gap: SPACING.md,
  },
  heroCard: {
    borderRadius: RADIUS.xl,
    padding: SPACING.xl,
    gap: SPACING.sm,
  },
  heroIconWrap: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  heroTitle: {
    color: COLORS.white,
    fontSize: 26,
    fontWeight: '800',
  },
  heroSubtitle: {
    color: 'rgba(255,255,255,0.94)',
    fontSize: 15,
    lineHeight: 22,
  },
  heroPill: {
    marginTop: SPACING.xs,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: SPACING.xs + 1,
  },
  heroPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
  },
  statLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: SPACING.xs,
  },
  statValue: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  panel: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  panelTitle: {
    color: COLORS.textPrimary,
    fontSize: 22,
    fontWeight: '700',
  },
  panelSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  actionsColumn: {
    gap: SPACING.sm,
  },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    backgroundColor: COLORS.background,
  },
  actionIconCircle: {
    width: 38,
    height: 38,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTextWrap: {
    flex: 1,
    gap: 2,
  },
  actionTitle: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  actionSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actionCta: {
    marginTop: SPACING.xs,
    fontSize: 12,
    fontWeight: '700',
  },
  emptyStateCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    alignItems: 'flex-start',
    gap: SPACING.xs,
    backgroundColor: COLORS.background,
  },
  emptyStateTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyStateBody: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  footerActions: {
    marginTop: SPACING.xs,
  },
  secondaryButton: {
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    flexDirection: 'row',
    gap: SPACING.xs,
    backgroundColor: COLORS.surface,
  },
  secondaryButtonText: {
    color: COLORS.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
});
