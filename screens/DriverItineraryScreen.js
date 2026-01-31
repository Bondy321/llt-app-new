// screens/DriverItineraryScreen.js
import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
  RefreshControl,
  ActivityIndicator,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getDriverItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';

const COLORS = {
  primaryBlue: THEME.primary,
  complementaryBlue: THEME.primaryLight,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  coralAccent: THEME.accent,
  danger: THEME.error,
  driverOrange: '#F59E0B',
  driverOrangeBg: '#FFFBEB',
};

export default function DriverItineraryScreen({ onBack, tourId, tourName }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const realtimeListener = useRef(null);

  useEffect(() => {
    loadDriverItinerary();

    // Set up real-time listener for live updates
    if (tourId) {
      const driverItRef = realtimeDb.ref(`tours/${tourId}/driver_itinerary`);

      const onUpdate = (snapshot) => {
        const text = snapshot.val();
        if (text !== null && text !== undefined) {
          setData(prev => prev ? { ...prev, driverItinerary: text } : prev);
        }
      };

      driverItRef.on('value', onUpdate);
      realtimeListener.current = { ref: driverItRef, listener: onUpdate };

      return () => {
        if (realtimeListener.current) {
          realtimeListener.current.ref.off('value', realtimeListener.current.listener);
        }
      };
    }
  }, [tourId]);

  const loadDriverItinerary = async () => {
    try {
      setErrorMessage('');
      if (!tourId) {
        setData(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const result = await getDriverItinerary(tourId);
      setData(result);
    } catch (error) {
      console.error('Error loading driver itinerary:', error);
      setErrorMessage('Could not load driver itinerary. Please check your connection.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadDriverItinerary();
  };

  const handleShare = async () => {
    if (!data?.driverItinerary) return;

    try {
      await Share.share({
        message: `Driver Itinerary - ${data.title || tourName || 'Tour'}\n${data.tourCode ? `Tour Code: ${data.tourCode}\n` : ''}${data.startDate && data.endDate ? `Dates: ${data.startDate} - ${data.endDate}\n` : ''}\n${data.driverItinerary}`,
        title: `Driver Itinerary - ${data.title || tourName || 'Tour'}`
      });
    } catch (error) {
      console.error('Share failed:', error);
    }
  };

  // --- LOADING STATE ---
  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.driverOrange, '#D97706']} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity onPress={onBack} style={styles.headerButton}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>DRIVER ONLY</Text>
              <Text style={styles.headerTitle}>Driver Itinerary</Text>
            </View>
          </View>
        </LinearGradient>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.driverOrange} />
          <Text style={styles.loadingText}>Loading driver itinerary...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const itineraryText = data?.driverItinerary || '';
  const isNoItinerary = !itineraryText || itineraryText === 'No driver itinerary available.';
  const isComingSoon = itineraryText.toLowerCase().includes('itinerary coming soon');

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* HEADER */}
      <LinearGradient colors={[COLORS.driverOrange, '#D97706']} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerLabel}>DRIVER ONLY</Text>
            <Text style={styles.headerTitle}>{data?.title || tourName || 'Driver Itinerary'}</Text>
          </View>
          {!isNoItinerary && (
            <TouchableOpacity onPress={handleShare} style={styles.headerButton}>
              <MaterialCommunityIcons name="share-variant" size={22} color={COLORS.white} />
            </TouchableOpacity>
          )}
        </View>

        {/* Tour Info Bar */}
        {(data?.tourCode || data?.startDate) && (
          <View style={styles.infoBar}>
            {data?.tourCode ? (
              <View style={styles.infoChip}>
                <MaterialCommunityIcons name="tag" size={14} color={COLORS.white} />
                <Text style={styles.infoChipText}>{data.tourCode}</Text>
              </View>
            ) : null}
            {data?.startDate && data?.endDate ? (
              <View style={styles.infoChip}>
                <MaterialCommunityIcons name="calendar-range" size={14} color={COLORS.white} />
                <Text style={styles.infoChipText}>{data.startDate} - {data.endDate}</Text>
              </View>
            ) : null}
            {data?.days ? (
              <View style={styles.infoChip}>
                <MaterialCommunityIcons name="counter" size={14} color={COLORS.white} />
                <Text style={styles.infoChipText}>{data.days} {data.days === 1 ? 'day' : 'days'}</Text>
              </View>
            ) : null}
          </View>
        )}
      </LinearGradient>

      {/* CONTENT */}
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={COLORS.driverOrange}
          />
        }
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Confidential Notice */}
        <View style={styles.confidentialBanner}>
          <MaterialCommunityIcons name="lock" size={18} color={COLORS.driverOrange} />
          <Text style={styles.confidentialText}>
            This itinerary is confidential and for driver use only. Do not share with passengers.
          </Text>
        </View>

        {isNoItinerary ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="file-document-outline" size={64} color={COLORS.secondaryText} />
            <Text style={styles.emptyTitle}>No Driver Itinerary</Text>
            <Text style={styles.emptySubtext}>
              A driver itinerary has not been added for this tour yet. Check back later.
            </Text>
          </View>
        ) : isComingSoon ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="clock-outline" size={64} color={COLORS.driverOrange} />
            <Text style={styles.emptyTitle}>Itinerary Coming Soon!</Text>
            <Text style={styles.emptySubtext}>
              The driver itinerary is being prepared. Check back closer to the tour date.
            </Text>
          </View>
        ) : (
          <View style={styles.contentCard}>
            <Text style={styles.contentText}>{itineraryText}</Text>
          </View>
        )}

        <View style={styles.footerSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.appBackground },

  headerGradient: {
    paddingTop: Platform.OS === 'ios' ? 18 : 10,
    paddingBottom: 16,
    paddingHorizontal: 18,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  headerContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitleContainer: { flex: 1, marginHorizontal: 10 },
  headerLabel: { color: '#FEF3C7', fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '700' },
  headerTitle: { fontSize: 22, fontWeight: '800', color: COLORS.white, marginTop: 2 },
  headerButton: { padding: 8, minWidth: 40, alignItems: 'center' },

  // Info Bar
  infoBar: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.25)' },
  infoChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, gap: 5 },
  infoChipText: { color: COLORS.white, fontSize: 12, fontWeight: '600' },

  // Loading
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.secondaryText },

  scrollContainer: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },

  // Error
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.danger, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16 },
  errorText: { color: COLORS.white, fontSize: 13, fontWeight: '600', marginLeft: 8, flex: 1 },

  // Confidential Notice
  confidentialBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.driverOrangeBg,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  confidentialText: { flex: 1, marginLeft: 10, fontSize: 13, color: '#92400E', fontWeight: '600', lineHeight: 18 },

  // Empty State
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: COLORS.darkText, marginTop: 16, marginBottom: 8 },
  emptySubtext: { fontSize: 14, color: COLORS.secondaryText, textAlign: 'center', lineHeight: 20 },

  // Content Card
  contentCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#F3F4F6',
  },
  contentText: {
    fontSize: 15,
    color: COLORS.darkText,
    lineHeight: 26,
    letterSpacing: 0.2,
  },

  footerSpacer: { height: 20 },
});
