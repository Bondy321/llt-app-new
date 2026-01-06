import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Linking,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { logSafetyEvent, SAFETY_CATEGORIES } from '../services/safetyService';
import { COLORS as THEME } from '../theme';

const COLORS = {
  primaryBlue: THEME.primary,
  coralAccent: THEME.accent,
  green: THEME.success,
  paleBlue: THEME.primaryMuted,
  softGrey: THEME.background,
  text: THEME.textPrimary,
};

const ISSUE_PRESETS = [
  { id: SAFETY_CATEGORIES.DELAY, title: 'Delayed pickup', description: 'Running late to a pickup point' },
  { id: SAFETY_CATEGORIES.VEHICLE_ISSUE, title: 'Vehicle issue', description: 'Mechanical issue or flat tyre' },
  { id: SAFETY_CATEGORIES.MEDICAL, title: 'Medical support', description: 'Passenger requires medical attention' },
  { id: SAFETY_CATEGORIES.LOST_PASSENGER, title: 'Missing passenger', description: 'Passenger not at meeting point' },
  { id: SAFETY_CATEGORIES.INCIDENT, title: 'Safety incident', description: 'Fight, harassment, or emergency' },
];

export default function SafetySupportScreen({
  onBack,
  tourData,
  bookingData,
  userId,
  mode = 'passenger',
}) {
  const [includeLocation, setIncludeLocation] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const driverPhone = tourData?.driverPhone;
  const supportPhone = tourData?.operationsPhone || tourData?.supportPhone;

  const openDialer = (phone) => {
    if (!phone) {
      Alert.alert('Contact unavailable', 'No phone number is configured for this tour.');
      return;
    }
    const sanitized = phone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${sanitized}`);
  };

  const handleReport = async (preset) => {
    setSubmitting(true);

    try {
      let coords = null;

      if (includeLocation) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          coords = location.coords;
        }
      }

      await logSafetyEvent({
        userId,
        bookingId: bookingData?.id,
        tourId: tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
        role: mode,
        category: preset.id,
        message: preset.description,
        coords,
      });

      Alert.alert('Support notified', 'Thanks for letting us know. Operations have been alerted.');
    } catch (error) {
      Alert.alert('Unable to send', 'We could not reach operations. Please try again or call directly.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={[`${COLORS.primaryBlue}0D`, '#FFFFFF']} style={styles.gradient}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={onBack}>
            <MaterialCommunityIcons name="chevron-left" size={28} color={COLORS.primaryBlue} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Safety & Support</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.iconCircle}>
                <MaterialCommunityIcons name="shield-check" size={28} color={COLORS.primaryBlue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Instant contacts</Text>
                <Text style={styles.cardSubtitle}>Reach a human in two taps.</Text>
              </View>
            </View>

            <View style={styles.contactRow}>
              <TouchableOpacity style={styles.contactButton} onPress={() => openDialer(driverPhone)}>
                <MaterialCommunityIcons name="steering" size={22} color={COLORS.primaryBlue} />
                <Text style={styles.contactText}>Call Driver</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.contactButton} onPress={() => openDialer(supportPhone || driverPhone)}>
                <MaterialCommunityIcons name="headset" size={22} color={COLORS.primaryBlue} />
                <Text style={styles.contactText}>Call Operations</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.contactButton} onPress={() => openDialer('112')}>
                <MaterialCommunityIcons name="medical-bag" size={22} color={COLORS.primaryBlue} />
                <Text style={styles.contactText}>Call Emergency</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.iconCircle, { backgroundColor: `${COLORS.coralAccent}12` }]}>
                <MaterialCommunityIcons name="alert-decagram" size={28} color={COLORS.coralAccent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Quick safety report</Text>
                <Text style={styles.cardSubtitle}>We log issues to HQ with your booking and tour.</Text>
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Share location</Text>
                <Switch value={includeLocation} onValueChange={setIncludeLocation} trackColor={{ true: COLORS.primaryBlue }} />
              </View>
            </View>

            {ISSUE_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={styles.issueButton}
                onPress={() => handleReport(preset)}
                disabled={submitting}
              >
                <View>
                  <Text style={styles.issueTitle}>{preset.title}</Text>
                  <Text style={styles.issueDescription}>{preset.description}</Text>
                </View>
                {submitting ? (
                  <ActivityIndicator color={COLORS.primaryBlue} />
                ) : (
                  <MaterialCommunityIcons name="chevron-right" size={22} color={COLORS.primaryBlue} />
                )}
              </TouchableOpacity>
            ))}
          </View>

          <View style={[styles.card, styles.tipCard]}>
            <MaterialCommunityIcons name="information" size={22} color={COLORS.primaryBlue} />
            <Text style={styles.tipText}>
              Tips: stay with your group at stops, keep valuables with you, and confirm pickup points on the itinerary. Drivers can
              use this page to alert HQ if a vehicle fault or late-running ferry disrupts timings.
            </Text>
          </View>
        </ScrollView>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  gradient: { flex: 1 },
  container: { padding: 20, paddingBottom: 40, gap: 18 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: COLORS.primaryBlue, fontSize: 16, fontWeight: '700' },
  title: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: `${COLORS.paleBlue}80`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 18, fontWeight: '800', color: COLORS.text },
  cardSubtitle: { fontSize: 14, color: '#556', marginTop: 2 },
  contactRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  contactButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    backgroundColor: COLORS.paleBlue,
    borderRadius: 12,
  },
  contactText: { color: COLORS.primaryBlue, fontWeight: '700', fontSize: 14 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleLabel: { color: COLORS.text, fontWeight: '700' },
  issueButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderColor: COLORS.softGrey,
  },
  issueTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  issueDescription: { fontSize: 13, color: '#666', marginTop: 2, maxWidth: '90%' },
  tipCard: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: `${COLORS.paleBlue}70`,
  },
  tipText: { flex: 1, color: COLORS.text, lineHeight: 20 },
});
