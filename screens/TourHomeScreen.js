// screens/TourHomeScreen.js
import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, ScrollView, Image } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import TodaysAgendaCard from '../components/TodaysAgendaCard';

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  lightBlueAccent: '#AECAEC',
  lightBlue: '#E8F2FF',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  cardBackground: '#FFFFFF',
  appBackground: '#F0F4F8',
};

export default function TourHomeScreen({ tourCode, tourData, bookingData, onNavigate, onLogout }) {
  const menuItems = [
    { id: 'Photobook', title: 'My Photos', icon: 'image-album', color: COLORS.primaryBlue },
    { id: 'GroupPhotobook', title: 'Group Photo Album', icon: 'image-multiple', color: '#16a085' },
    { id: 'Itinerary', title: 'Tour Itinerary', icon: 'map-legend', color: '#3498DB' },
    { id: 'Chat', title: 'Group Chat', icon: 'chat-processing-outline', color: '#2ECC71' },
    { id: 'Map', title: 'Driver Location', icon: 'map-marker-radius-outline', color: COLORS.coralAccent },
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
                onPress={() => onNavigate(item.id)}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  gradient: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 30,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 30,
    backgroundColor: COLORS.white,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 5,
  },
  logoImage: {
    width: 46,
    height: 46,
    borderRadius: 12,
    marginRight: 12,
  },
  headerTextContainer: {
    flex: 1,
  },
  greeting: {
    fontSize: 13,
    color: COLORS.darkText,
    opacity: 0.75,
    fontWeight: '500',
  },
  tourCodeDisplay: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.primaryBlue,
    marginTop: 2,
  },
  logoutButton: {
    padding: 6,
  },
  welcomeCard: {
    backgroundColor: COLORS.white,
    padding: 22,
    borderRadius: 20,
    marginBottom: 28,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: COLORS.lightBlue,
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
    color: COLORS.darkText,
    opacity: 0.7,
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
    borderBottomColor: COLORS.lightBlueAccent,
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
    color: COLORS.darkText,
    marginTop: 4,
    fontStyle: 'italic',
    opacity: 0.8,
  },
  multiplePickupsLabel: {
    fontSize: 14,
    color: COLORS.darkText,
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
    borderTopColor: COLORS.lightBlue,
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
    color: COLORS.darkText,
    opacity: 0.7,
    fontWeight: '500',
  },
  footerValue: {
    fontSize: 16,
    color: COLORS.coralAccent,
    fontWeight: '700',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 18,
    paddingLeft: 5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 14,
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
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
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
});