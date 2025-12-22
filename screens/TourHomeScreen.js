// screens/TourHomeScreen.js
import React, { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Image,
  Modal,
  Linking,
  Alert,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import TodaysAgendaCard from '../components/TodaysAgendaCard';
import { MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { colors, spacing, radius, shadows, text as textStyles } from '../theme';

// Brand Colors
const palette = colors;

const COLORS = {
  primaryBlue: palette.primary,
  lightBlueAccent: palette.primaryMuted,
  lightBlue: palette.primaryMuted,
  coralAccent: palette.accent,
  white: palette.surface,
  darkText: palette.ink,
  cardBackground: palette.surface,
  appBackground: palette.background,
};

export default function TourHomeScreen({ tourCode, tourData, bookingData, onNavigate, onLogout }) {
  const [manifestStatus, setManifestStatus] = useState(null);

  const bookingRef = useMemo(() => bookingData?.id, [bookingData?.id]);

  useEffect(() => {
    if (!realtimeDb || !tourCode || !bookingRef) return undefined;

    const sanitizedTourId = tourCode.replace(/\s+/g, '_');
    const manifestRef = realtimeDb.ref(`tour_manifests/${sanitizedTourId}/bookings/${bookingRef}`);

    const handleSnapshot = (snapshot) => {
      const value = snapshot.val();
      setManifestStatus(value?.status || null);
    };

    manifestRef.on('value', handleSnapshot);

    return () => {
      manifestRef.off('value', handleSnapshot);
    };
  }, [tourCode, bookingRef]);

  const manifestStatusMeta = useMemo(() => {
    switch (manifestStatus) {
      case MANIFEST_STATUS.BOARDED:
        return {
          title: 'Boarding confirmed',
          message: 'You are checked in for today\'s tour. If your plans change, let the driver know.',
          tone: '#2ECC71',
          badge: 'On board'
        };
      case MANIFEST_STATUS.NO_SHOW:
        return {
          title: 'Marked as no-show',
          message:
            'The driver has you marked as missing. Call the driver or operations immediately so they can wait or guide you to the pickup.',
          tone: COLORS.coralAccent,
          badge: 'Action needed'
        };
      case MANIFEST_STATUS.PARTIAL:
        return {
          title: 'Partially boarded',
          message:
            'Some passengers on your booking are still missing. Check everyone is at the pickup point before departure.',
          tone: '#F5A524',
          badge: 'Almost ready'
        };
      case MANIFEST_STATUS.PENDING:
      default:
        return {
          title: 'Awaiting check-in',
          message: 'Stay close to your pickup spot. The driver will mark you on board when you meet.',
          tone: COLORS.primaryBlue,
          badge: 'Stand by'
        };
    }
  }, [manifestStatus]);

  const isNoShow = manifestStatus === MANIFEST_STATUS.NO_SHOW;

  const handleCallDriver = () => {
    if (!tourData?.driverPhone) {
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }

    const phone = tourData.driverPhone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${phone}`);
  };

  const handleMessageDriver = () => {
    if (!tourData?.driverPhone) {
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }

    const phone = tourData.driverPhone.replace(/[^+\d]/g, '');
    Linking.openURL(`sms:${phone}`);
  };

  const menuItems = [
    { id: 'Photobook', title: 'My Photos', icon: 'image-album', color: COLORS.primaryBlue },
    { id: 'GroupPhotobook', title: 'Group Photo Album', icon: 'image-multiple', color: '#16a085' },
    { id: 'Itinerary', title: 'Tour Itinerary', icon: 'map-legend', color: '#3498DB' },
    { id: 'Chat', title: 'Group Chat', icon: 'chat-processing-outline', color: '#2ECC71' },
    { id: 'Map', title: 'Driver Location', icon: 'map-marker-radius-outline', color: COLORS.coralAccent },
    { id: 'SafetySupport', title: 'Safety & Support', icon: 'shield-check', color: '#8e44ad' },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.header}>
            <Image source={require('../assets/images/app-icon-llt.png')} style={styles.logoImage} />
            <View style={styles.headerTextContainer}>
              <Text style={styles.greeting}>{tourData?.name || 'Active Tour'}</Text>
              <Text style={styles.tourCodeDisplay}>{tourCode}</Text>
            </View>
            <View style={{flexDirection: 'row', gap: 10}}>
              {/* Notification Button */}
              <TouchableOpacity 
                 style={styles.logoutButton} 
                 onPress={() => onNavigate('NotificationPreferences')}
              >
                 <MaterialCommunityIcons name="bell-ring-outline" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>

              {/* Logout Button */}
              <TouchableOpacity style={styles.logoutButton} onPress={onLogout} activeOpacity={0.7}>
                <MaterialCommunityIcons name="logout-variant" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.statusCard}>
            <View style={styles.statusHeader}>
              <View style={[styles.statusBadge, { backgroundColor: `${manifestStatusMeta.tone}1A` }]}> 
                <Text style={[styles.statusBadgeText, { color: manifestStatusMeta.tone }]}>{manifestStatusMeta.badge}</Text>
              </View>
              <Text style={styles.statusTitle}>{manifestStatusMeta.title}</Text>
            </View>
            <Text style={styles.statusMessage}>{manifestStatusMeta.message}</Text>
            <View style={styles.statusActions}>
              <TouchableOpacity style={styles.actionButton} onPress={handleCallDriver}>
                <MaterialCommunityIcons name="phone" size={18} color={COLORS.white} />
                <Text style={styles.actionButtonText}>Call driver</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.secondaryActionButton]}
                onPress={() => onNavigate('SafetySupport')}
              >
                <MaterialCommunityIcons name="shield-check" size={18} color={COLORS.primaryBlue} />
                <Text style={[styles.actionButtonText, { color: COLORS.primaryBlue }]}>Safety & support</Text>
              </TouchableOpacity>
            </View>
          </View>

          {tourData && (
            <View style={styles.welcomeCard}>
              <Text style={styles.welcomeText}>
                Welcome{bookingData?.passengerNames?.length > 0 ? `, ${bookingData.passengerNames[0]}` : ''}
              </Text>
              <Text style={styles.subHeading}>Your digital boarding pass</Text>
              <View style={styles.boardingMeta}>
                {tourData.driverName && (
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Driver</Text>
                    <Text style={styles.metaValue}>{tourData.driverName}</Text>
                  </View>
                )}
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>Tour</Text>
                  <Text style={styles.metaValue}>{tourData?.name || 'Scenic Tour'}</Text>
                </View>
              </View>
              <View style={styles.divider} />

              {/* Pickup Information */}
              {bookingData?.pickupPoints && bookingData.pickupPoints.length > 0 ? (
                <View style={styles.pickupWrapper}>
                  {bookingData.pickupPoints.length > 1 && (
                    <Text style={styles.multiplePickupsLabel}>Multiple pickup points for this booking:</Text>
                  )}
                  {bookingData.pickupPoints.map((pickup, index) => (
                    <View key={index} style={[styles.pickupInfo, index > 0 && styles.additionalPickup]}>
                      <View style={styles.pickupIconCircle}>
                        <MaterialCommunityIcons name="bus-clock" size={20} color={COLORS.primaryBlue} />
                      </View>
                      <View style={styles.pickupDetails}>
                        <Text style={styles.pickupTime}>{pickup.time}</Text>
                        <Text style={styles.pickupLocation}>{pickup.location}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : bookingData?.pickupTime ? (
                // Fallback to single pickup fields if pickupPoints array doesn't exist
                <View style={styles.pickupInfo}>
                  <View style={styles.pickupIconCircle}>
                    <MaterialCommunityIcons name="bus-clock" size={20} color={COLORS.primaryBlue} />
                  </View>
                  <View style={styles.pickupDetails}>
                    <Text style={styles.pickupTime}>{bookingData.pickupTime}</Text>
                    <Text style={styles.pickupLocation}>{bookingData.pickupLocation}</Text>
                  </View>
                </View>
              ) : null}

              {/* Seat Information */}
              {bookingData?.seatNumbers?.length > 0 && (
                <View style={styles.seatInfo}>
                  <View style={styles.seatIconCircle}>
                    <MaterialCommunityIcons name="seat" size={20} color={COLORS.coralAccent} />
                  </View>
                  <Text style={styles.seatText}>
                    Seat{bookingData.seatNumbers.length > 1 ? 's' : ''}: {bookingData.seatNumbers.join(', ')}
                  </Text>
                </View>
              )}

              {/* Show all passenger names if multiple */}
              {bookingData?.passengerNames?.length > 1 && (
                <View style={styles.passengersInfo}>
                  <Text style={styles.passengersTitle}>Passengers on this booking:</Text>
                  {bookingData.passengerNames.map((name, index) => (
                    <Text key={index} style={styles.passengerName}>
                      • {name} (Seat {bookingData.seatNumbers[index] || 'TBA'})
                    </Text>
                  ))}
                </View>
              )}

              <View style={styles.bookingFooter}>
                <View>
                  <Text style={styles.metaLabel}>Booking Ref</Text>
                  <Text style={styles.bookingRefText}>{bookingData.id}</Text>
                </View>
                {bookingData?.pickupTime && (
                  <View style={styles.footerBadge}>
                    <Text style={styles.footerLabel}>Pickup</Text>
                    <Text style={styles.footerValue}>{bookingData.pickupTime}</Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {tourData && (
            <TodaysAgendaCard
              tourData={tourData}
              onNudge={() => onNavigate('Itinerary')}
            />
          )}

          <Text style={styles.sectionTitle}>Tour Features</Text>
          <View style={styles.grid}>
            {menuItems.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.box}
                onPress={() =>
                  onNavigate(
                    item.id,
                    item.id === 'SafetySupport'
                      ? { from: 'TourHome', mode: 'passenger' }
                      : {}
                  )
                }
                activeOpacity={0.85}
              >
                <View style={[styles.iconCircle, { backgroundColor: `${item.color}1A` }]}> 
                  <MaterialCommunityIcons name={item.icon} size={30} color={item.color} />
                </View>
                <Text style={styles.boxText}>{item.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </LinearGradient>

      <Modal visible={isNoShow} transparent animationType="fade" presentationStyle="overFullScreen">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="alert-circle" size={32} color={COLORS.coralAccent} />
              <Text style={styles.modalTitle}>No Show Alert</Text>
            </View>
            <Text style={styles.modalMessage}>
              You have been marked as a No Show. Please contact your driver.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalButton, styles.callButton]} onPress={handleCallDriver}>
                <MaterialCommunityIcons name="phone" size={20} color={COLORS.white} />
                <Text style={styles.modalButtonText}>Call Driver</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.messageButton]} onPress={handleMessageDriver}>
                <MaterialCommunityIcons name="message-text" size={20} color={COLORS.white} />
                <Text style={styles.modalButtonText}>Message Driver</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  gradient: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl,
    backgroundColor: COLORS.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.subtle,
  },
  logoImage: {
    width: 44,
    height: 44,
    borderRadius: 12,
    marginRight: spacing.sm,
  },
  headerTextContainer: {
    flex: 1,
  },
  greeting: {
    ...textStyles.caption,
    color: palette.steel,
  },
  tourCodeDisplay: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.darkText,
    marginTop: 2,
  },
  logoutButton: {
    padding: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: palette.primaryMuted,
  },
  statusCard: {
    backgroundColor: COLORS.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.subtle,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    marginRight: spacing.sm,
  },
  statusBadgeText: {
    fontWeight: '800',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusTitle: {
    ...textStyles.title,
    flex: 1,
  },
  statusMessage: {
    ...textStyles.body,
    color: palette.graphite,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  statusActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: COLORS.primaryBlue,
    ...shadows.subtle,
  },
  secondaryActionButton: {
    backgroundColor: palette.primaryMuted,
    borderWidth: 0,
  },
  actionButtonText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 14,
  },
  welcomeCard: {
    backgroundColor: COLORS.white,
    padding: spacing.lg,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.soft,
  },
  welcomeText: {
    ...textStyles.heading,
    marginBottom: spacing.xs,
  },
  subHeading: {
    ...textStyles.body,
    color: palette.steel,
    marginBottom: spacing.md,
  },
  boardingMeta: {
    gap: spacing.xs,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: {
    ...textStyles.caption,
    color: palette.steel,
  },
  metaValue: {
    ...textStyles.title,
  },
  divider: {
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: palette.border,
    marginVertical: spacing.md,
  },
  pickupWrapper: {
    gap: spacing.sm,
  },
  pickupInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.primaryMuted,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  pickupDetails: {
    marginLeft: spacing.sm,
    flex: 1,
  },
  pickupTime: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.coralAccent,
  },
  pickupLocation: {
    ...textStyles.body,
    color: palette.graphite,
    marginTop: 2,
  },
  additionalPickup: {
    marginTop: spacing.sm,
  },
  pickupPassengers: {
    ...textStyles.caption,
    color: palette.graphite,
    marginTop: 4,
    fontStyle: 'italic',
  },
  multiplePickupsLabel: {
    ...textStyles.body,
    color: palette.graphite,
    marginBottom: spacing.xs,
    fontWeight: '700',
  },
  seatInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    backgroundColor: palette.cardSoft,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  seatText: {
    fontSize: 15,
    color: COLORS.coralAccent,
    marginLeft: spacing.sm,
    fontWeight: '700',
  },
  seatIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: `${COLORS.coralAccent}18`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  passengersInfo: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: palette.border,
  },
  passengersTitle: {
    ...textStyles.body,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: spacing.xs,
  },
  passengerName: {
    ...textStyles.body,
    color: COLORS.darkText,
    marginLeft: spacing.sm,
    marginBottom: 3,
  },
  bookingFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  bookingRefText: {
    ...textStyles.title,
  },
  footerBadge: {
    backgroundColor: palette.primaryMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  footerLabel: {
    ...textStyles.caption,
    color: palette.steel,
  },
  footerValue: {
    fontSize: 15,
    color: COLORS.coralAccent,
    fontWeight: '800',
  },
  sectionTitle: {
    ...textStyles.heading,
    fontSize: 20,
    marginBottom: spacing.md,
    paddingLeft: 5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  box: {
    width: '48%',
    aspectRatio: 1.05,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.lg,
    padding: spacing.md,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.subtle,
  },
  iconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  boxText: {
    ...textStyles.body,
    fontWeight: '800',
    color: COLORS.darkText,
    textAlign: 'center',
  },
  pickupIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: `${COLORS.primaryBlue}18`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: COLORS.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadows.soft,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  modalTitle: {
    ...textStyles.title,
    fontSize: 20,
  },
  modalMessage: {
    ...textStyles.body,
    color: palette.graphite,
    marginBottom: spacing.md,
    lineHeight: 22,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  modalButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  callButton: {
    backgroundColor: COLORS.coralAccent,
  },
  messageButton: {
    backgroundColor: COLORS.primaryBlue,
  },
  modalButtonText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '700',
  },
});
