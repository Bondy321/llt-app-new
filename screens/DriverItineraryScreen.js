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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getDriverItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';

const COLORS = {
  primaryBlue: THEME.primary,
  complementaryBlue: THEME.primaryLight,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  amber: '#D97706',
  amberLight: '#FEF3C7',
  amberBorder: '#F59E0B',
  danger: THEME.error,
};

export default function DriverItineraryScreen({ onBack, tourId, tourName }) {
  const [driverItinerary, setDriverItinerary] = useState(null);
  const [tourInfo, setTourInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [isOnline, setIsOnline] = useState(true);

  const realtimeListener = useRef(null);

  // Real-time listener for driver_itinerary
  useEffect(() => {
    loadDriverItinerary();

    if (tourId) {
      const driverItinRef = realtimeDb.ref(`tours/${tourId}/driver_itinerary`);

      const onUpdate = (snapshot) => {
        const data = snapshot.val();
        if (data !== null && data !== undefined) {
          setDriverItinerary(data);
          setLastSync(new Date());
          cacheDriverItinerary(data);
        }
      };

      driverItinRef.on('value', onUpdate);
      realtimeListener.current = { ref: driverItinRef, listener: onUpdate };

      return () => {
        if (realtimeListener.current) {
          realtimeListener.current.ref.off('value', realtimeListener.current.listener);
        }
      };
    }
  }, [tourId]);

  const cacheDriverItinerary = async (data) => {
    try {
      await AsyncStorage.setItem(`driver_itinerary_${tourId}`, JSON.stringify(data));
    } catch (error) {
      console.log('Cache save failed:', error);
    }
  };

  const loadCachedDriverItinerary = async () => {
    try {
      const cached = await AsyncStorage.getItem(`driver_itinerary_${tourId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.log('Cache load failed:', error);
    }
    return null;
  };

  const loadDriverItinerary = async ({ showSkeleton = true, retry = 0 } = {}) => {
    try {
      setErrorMessage('');
      if (!tourId) {
        setDriverItinerary(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showSkeleton) setLoading(true);
      else setRefreshing(true);

      // Load from cache first
      const cached = await loadCachedDriverItinerary();
      if (cached && showSkeleton) {
        setDriverItinerary(cached);
        setLoading(false);
      }

      const result = await getDriverItinerary(tourId);
      if (result) {
        setDriverItinerary(result.driverItinerary);
        setTourInfo(result);
        setIsOnline(true);
        setLastSync(new Date());

        if (result.driverItinerary) {
          await cacheDriverItinerary(result.driverItinerary);
        }
      } else {
        if (!cached) {
          setDriverItinerary(null);
        }
      }
    } catch (error) {
      console.error('Error loading driver itinerary:', error);

      if (retry < 3) {
        const delay = Math.pow(2, retry) * 1000;
        setTimeout(() => {
          loadDriverItinerary({ showSkeleton: false, retry: retry + 1 });
        }, delay);
        setErrorMessage(`Connection issue. Retrying (${retry + 1}/3)...`);
      } else {
        const cached = await loadCachedDriverItinerary();
        if (cached) {
          setDriverItinerary(cached);
          setIsOnline(false);
          setErrorMessage('Using offline data. Pull to refresh when online.');
        } else {
          setErrorMessage('Could not load driver itinerary. Please check your connection.');
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // --- LOADING SKELETON ---
  const renderLoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      <View style={styles.skeletonCard}>
        <View style={styles.skeletonHeader} />
        <View style={styles.skeletonLine} />
        <View style={styles.skeletonLine} />
        <View style={styles.skeletonLine} />
        <View style={[styles.skeletonLine, { width: '70%' }]} />
        <View style={styles.skeletonLine} />
        <View style={[styles.skeletonLine, { width: '50%' }]} />
      </View>
    </View>
  );

  // --- EMPTY STATE ---
  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <MaterialCommunityIcons name="file-document-outline" size={80} color="#CBD5E0" />
      <Text style={styles.emptyTitle}>No Driver Itinerary</Text>
      <Text style={styles.emptySubtitle}>
        The driver itinerary for this tour has not been uploaded yet. Check back later.
      </Text>
    </View>
  );

  const displayName = tourName || tourInfo?.tourName || 'Tour';

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.amber, '#B45309']} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity onPress={onBack} style={styles.headerButton}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>Driver Itinerary</Text>
              <Text style={styles.headerTitle}>{displayName}</Text>
            </View>
          </View>
        </LinearGradient>
        {renderLoadingSkeleton()}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* HEADER */}
      <LinearGradient colors={[COLORS.amber, '#B45309']} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerLabel}>Driver Itinerary</Text>
            <Text style={styles.headerTitle}>{displayName}</Text>
            {!isOnline && (
              <View style={styles.offlineBadge}>
                <MaterialCommunityIcons name="cloud-off-outline" size={12} color={COLORS.white} />
                <Text style={styles.offlineText}>Offline</Text>
              </View>
            )}
          </View>
          <View style={styles.headerIconContainer}>
            <MaterialCommunityIcons name="eye" size={22} color={COLORS.white} />
          </View>
        </View>
      </LinearGradient>

      {/* CONTENT */}
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadDriverItinerary({ showSkeleton: false })}
            tintColor={COLORS.amber}
          />
        }
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {lastSync && (
          <Text style={styles.syncText}>
            Last synced: {lastSync.toLocaleTimeString()}
          </Text>
        )}

        {/* Confidential Notice */}
        <View style={styles.confidentialBanner}>
          <MaterialCommunityIcons name="lock" size={18} color={COLORS.amber} />
          <Text style={styles.confidentialText}>
            This itinerary is for driver use only. Do not share with passengers.
          </Text>
        </View>

        {!driverItinerary ? (
          renderEmptyState()
        ) : (
          <View style={styles.itineraryCard}>
            <LinearGradient colors={[COLORS.white, '#FFFBEB']} style={styles.itineraryCardInner}>
              <View style={styles.itineraryHeader}>
                <MaterialCommunityIcons name="file-document-outline" size={22} color={COLORS.amber} />
                <Text style={styles.itineraryHeaderText}>Full Driver Instructions</Text>
              </View>
              <View style={styles.itineraryDivider} />
              <Text style={styles.itineraryText} selectable={true}>
                {driverItinerary}
              </Text>
            </LinearGradient>
          </View>
        )}

        <View style={{ height: 40 }} />
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
  headerLabel: { color: COLORS.amberLight, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '700' },
  headerTitle: { fontSize: 24, fontWeight: '800', color: COLORS.white, marginTop: 2 },
  headerButton: { padding: 8, minWidth: 40, alignItems: 'center' },
  headerIconContainer: { padding: 8, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 12 },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.2)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginTop: 4 },
  offlineText: { color: COLORS.white, fontSize: 10, fontWeight: '600', marginLeft: 4 },

  scrollContainer: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },

  // Error Banner
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.danger, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16 },
  errorText: { color: COLORS.white, fontSize: 13, fontWeight: '600', marginLeft: 8, flex: 1 },

  // Sync Text
  syncText: { fontSize: 11, color: COLORS.secondaryText, textAlign: 'center', marginBottom: 12, fontStyle: 'italic' },

  // Confidential Banner
  confidentialBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.amberLight,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.amberBorder,
  },
  confidentialText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.amber,
    lineHeight: 18,
  },

  // Loading Skeleton
  skeletonContainer: { paddingHorizontal: 16, paddingTop: 20 },
  skeletonCard: { backgroundColor: COLORS.white, borderRadius: 20, padding: 20, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  skeletonHeader: { height: 24, backgroundColor: '#E2E8F0', borderRadius: 8, marginBottom: 16, width: '50%' },
  skeletonLine: { height: 16, backgroundColor: '#F1F5F9', borderRadius: 6, marginBottom: 10 },

  // Empty State
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: COLORS.darkText, marginTop: 20, marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: COLORS.secondaryText, textAlign: 'center', lineHeight: 22 },

  // Itinerary Card
  itineraryCard: {
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
    backgroundColor: 'transparent',
  },
  itineraryCardInner: {
    borderRadius: 20,
    padding: 20,
  },
  itineraryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  itineraryHeaderText: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.darkText,
    marginLeft: 10,
  },
  itineraryDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginBottom: 16,
  },
  itineraryText: {
    fontSize: 15,
    color: COLORS.darkText,
    lineHeight: 26,
    letterSpacing: 0.1,
  },
});
