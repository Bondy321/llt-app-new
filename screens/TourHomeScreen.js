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
import { COLORS as THEME } from '../theme';

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: '#93C5FD',
  lightBlue: THEME.primaryMuted,
  coralAccent: THEME.accent,
  white: THEME.white,
  darkText: THEME.textPrimary,
  cardBackground: THEME.surface,
  appBackground: THEME.background,
  border: THEME.border,
  subtleText: THEME.textSecondary,
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

          {/* Find My Bus - Prominent Feature Card */}
          <TouchableOpacity
            style={styles.findBusCard}
            onPress={() => onNavigate('Map')}
            activeOpacity={0.9}
          >
            <View style={styles.findBusGradient}>
              <View style={styles.findBusContent}>
                <View style={styles.findBusIconContainer}>
                  <MaterialCommunityIcons name="bus-marker" size={32} color={COLORS.coralAccent} />
                </View>
                <View style={styles.findBusTextContainer}>
                  <Text style={styles.findBusTitle}>Find My Bus</Text>
                  <Text style={styles.findBusSubtitle}>See where your driver is on the map</Text>
                </View>
                <View style={styles.findBusArrow}>
                  <MaterialCommunityIcons name="arrow-right-circle" size={28} color={COLORS.coralAccent} />
                </View>
              </View>
            </View>
          </TouchableOpacity>

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
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 28,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    backgroundColor: COLORS.white,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logoImage: {
    width: 44,
    height: 44,
    borderRadius: 12,
    marginRight: 12,
  },
  headerTextContainer: {
    flex: 1,
  },
  greeting: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  tourCodeDisplay: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.primaryBlue,
    marginTop: 4,
  },
  logoutButton: {
    padding: 8,
    borderRadius: 12,
    backgroundColor: `${COLORS.primaryBlue}12`,
  },
  statusCard: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 18,
    marginBottom: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    marginRight: 10,
  },
  statusBadgeText: {
    fontWeight: '800',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
    flex: 1,
  },
  statusMessage: {
    fontSize: 14,
    color: COLORS.subtleText,
    lineHeight: 20,
    marginBottom: 14,
  },
  statusActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.primaryBlue,
  },
  secondaryActionButton: {
    backgroundColor: `${COLORS.primaryBlue}12`,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}40`,
  },
  actionButtonText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 14,
  },
  welcomeCard: {
    backgroundColor: COLORS.white,
    padding: 22,
    borderRadius: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  welcomeText: {
    fontSize: 26,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 6,
  },
  subHeading: {
    fontSize: 15,
    color: COLORS.darkText,
    opacity: 0.7,
    marginBottom: 16,
  },
  boardingMeta: {
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: {
    fontSize: 14,
    color: COLORS.subtleText,
    fontWeight: '500',
  },
  metaValue: {
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: '700',
  },
  divider: {
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: COLORS.border,
    marginVertical: 16,
  },
  pickupWrapper: {
    gap: 10,
  },
  pickupInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.lightBlue,
    padding: 12,
    borderRadius: 12,
  },
  pickupDetails: {
    marginLeft: 10,
    flex: 1,
  },
  pickupTime: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.coralAccent,
  },
  pickupLocation: {
    fontSize: 14,
    color: COLORS.darkText,
    marginTop: 2,
  },
  additionalPickup: {
    marginTop: 10,
  },
  pickupPassengers: {
    fontSize: 12,
    color: COLORS.subtleText,
    marginTop: 4,
    fontStyle: 'italic',
    opacity: 0.8,
  },
  multiplePickupsLabel: {
    fontSize: 14,
    color: COLORS.subtleText,
    marginBottom: 8,
    fontWeight: '600',
    opacity: 0.8,
  },
  seatInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    backgroundColor: '#FFF5F1',
    padding: 12,
    borderRadius: 12,
  },
  seatText: {
    fontSize: 16,
    color: COLORS.coralAccent,
    marginLeft: 10,
    fontWeight: '700',
  },
  seatIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: `${COLORS.coralAccent}1A`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  passengersInfo: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  passengersTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 8,
  },
  passengerName: {
    fontSize: 14,
    color: COLORS.darkText,
    marginLeft: 10,
    marginBottom: 3,
  },
  bookingFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
  },
  bookingRefText: {
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: '700',
  },
  footerBadge: {
    backgroundColor: `${COLORS.primaryBlue}12`,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  footerLabel: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '500',
  },
  footerValue: {
    fontSize: 16,
    color: COLORS.coralAccent,
    fontWeight: '700',
  },
  sectionTitle: {
    fontSize: 21,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 14,
    paddingLeft: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
  },
  box: {
    width: '48%',
    aspectRatio: 1.05,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 18,
    padding: 16,
    backgroundColor: COLORS.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 9,
    elevation: 5,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  iconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  boxText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.darkText,
    textAlign: 'center',
  },
  pickupIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: `${COLORS.primaryBlue}1A`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  modalMessage: {
    fontSize: 16,
    color: COLORS.darkText,
    marginBottom: 18,
    lineHeight: 22,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    gap: 8,
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
  // Find My Bus Card Styles
  findBusCard: {
    marginBottom: 20,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: `${COLORS.coralAccent}30`,
  },
  findBusGradient: {
    backgroundColor: `${COLORS.coralAccent}08`,
    padding: 18,
  },
  findBusContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  findBusIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: `${COLORS.coralAccent}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  findBusTextContainer: {
    flex: 1,
  },
  findBusTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 4,
  },
  findBusSubtitle: {
    fontSize: 14,
    color: COLORS.subtleText,
    fontWeight: '500',
  },
  findBusArrow: {
    marginLeft: 8,
  },
});
