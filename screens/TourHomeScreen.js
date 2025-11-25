// screens/TourHomeScreen.js
import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

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
    { id: 'Notes', title: 'My Notes', icon: 'notebook-outline', color: '#9b59b6' },
    { id: 'Map', title: 'Driver Location', icon: 'map-marker-radius-outline', color: COLORS.coralAccent },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.logoPlaceholder}>
            <Text style={styles.logoText}>LLT</Text>
          </View>
          <View style={styles.headerTextContainer}>
            <Text style={styles.greeting}>{tourData?.name || 'Active Tour'}</Text>
            <Text style={styles.tourCodeDisplay}>{tourCode}</Text>
          </View>
          <TouchableOpacity style={styles.logoutButton} onPress={onLogout} activeOpacity={0.7}>
            <MaterialCommunityIcons name="logout-variant" size={22} color={COLORS.primaryBlue} />
          </TouchableOpacity>
        </View>

        {tourData && (
          <View style={styles.welcomeCard}>
            <Text style={styles.welcomeText}>
              Welcome{bookingData?.passengerNames?.length > 0 ? `, ${bookingData.passengerNames[0]}` : ''} to your tour!
            </Text>
            {tourData.driverName && (
              <Text style={styles.driverText}>Your driver today is {tourData.driverName}</Text>
            )}
            
            {/* Pickup Information */}
            {bookingData?.pickupPoints && bookingData.pickupPoints.length > 0 ? (
              <View>
                {bookingData.pickupPoints.length > 1 && (
                  <Text style={styles.multiplePickupsLabel}>Multiple pickup points for this booking:</Text>
                )}
                {bookingData.pickupPoints.map((pickup, index) => (
                  <View key={index} style={[styles.pickupInfo, index > 0 && styles.additionalPickup]}>
                    <MaterialCommunityIcons name="bus-clock" size={20} color={COLORS.primaryBlue} />
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
                <MaterialCommunityIcons name="bus-clock" size={20} color={COLORS.primaryBlue} />
                <View style={styles.pickupDetails}>
                  <Text style={styles.pickupTime}>{bookingData.pickupTime}</Text>
                  <Text style={styles.pickupLocation}>{bookingData.pickupLocation}</Text>
                </View>
              </View>
            ) : null}
            
            {/* Seat Information */}
            {bookingData?.seatNumbers?.length > 0 && (
              <View style={styles.seatInfo}>
                <MaterialCommunityIcons name="seat" size={20} color={COLORS.primaryBlue} />
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
            
            <Text style={styles.bookingRefText}>Booking: {bookingData.id}</Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>Tour Features</Text>
        <View style={styles.grid}>
          {menuItems.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={[styles.box, { backgroundColor: item.color }]}
              onPress={() => onNavigate(item.id)}
              activeOpacity={0.8}
            >
              <View style={styles.iconContainer}>
                <MaterialCommunityIcons name={item.icon} size={36} color={COLORS.white} />
              </View>
              <Text style={styles.boxText}>{item.title}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
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
    marginBottom: 35,
    backgroundColor: COLORS.white,
    borderRadius: 15,
    paddingHorizontal: 15,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 5,
  },
  logoPlaceholder: {
    width: 45,
    height: 45,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: 22.5,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  logoText: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerTextContainer: {
    flex: 1,
  },
  greeting: {
    fontSize: 14,
    color: COLORS.darkText,
    opacity: 0.7,
  },
  tourCodeDisplay: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.primaryBlue,
  },
  logoutButton: {
    padding: 8,
    backgroundColor: COLORS.lightBlueAccent,
    borderRadius: 20,
  },
  welcomeCard: {
    backgroundColor: COLORS.lightBlueAccent,
    padding: 20,
    borderRadius: 15,
    marginBottom: 25,
  },
  welcomeText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginBottom: 5,
  },
  driverText: {
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.8,
  },
  bookingRefText: {
    fontSize: 14,
    color: COLORS.darkText,
    opacity: 0.6,
    marginTop: 5,
  },
  pickupInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 15,
    backgroundColor: COLORS.lightBlue,
    padding: 12,
    borderRadius: 8,
  },
  pickupDetails: {
    marginLeft: 10,
    flex: 1,
  },
  pickupTime: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.primaryBlue,
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
    marginTop: 10,
  },
  seatText: {
    fontSize: 16,
    color: COLORS.darkText,
    marginLeft: 8,
    fontWeight: '500',
  },
  passengersInfo: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.lightBlue,
  },
  passengersTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginBottom: 6,
  },
  passengerName: {
    fontSize: 14,
    color: COLORS.darkText,
    marginLeft: 10,
    marginBottom: 3,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginBottom: 20,
    paddingLeft: 5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  box: {
    width: '48%',
    aspectRatio: 1.1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 18,
    marginBottom: 15,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  iconContainer: {
    marginBottom: 12,
    padding: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 30,
  },
  boxText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.white,
    textAlign: 'center',
  },
});