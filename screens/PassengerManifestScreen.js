import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet, Text, View, SectionList, FlatList, TextInput,
  TouchableOpacity, ActivityIndicator, Modal, Alert, SafeAreaView
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourManifest, updateManifestBooking, MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import ManifestBookingCard from '../components/ManifestBookingCard';

const COLORS = {
  primary: '#0B5ED7',
  bg: '#F6F8FC',
  border: '#E2E8F0',
  searchBg: '#FFFFFF',
  success: '#22C55E',
  danger: '#EF4444',
  info: '#2563EB',
  muted: '#475569',
  panel: '#0F172A',
};

export default function PassengerManifestScreen({ route, navigation }) {
  const { tourId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [manifestData, setManifestData] = useState({ bookings: [], stats: {} });
  const [searchQuery, setSearchQuery] = useState('');

  // Modal State
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [partialMode, setPartialMode] = useState(false);
  const [partialStatuses, setPartialStatuses] = useState([]);
  const [actionLoading, setActionLoading] = useState(false);

  const loadManifest = async () => {
    try {
      const data = await getTourManifest(tourId);
      setManifestData(data);
    } catch (error) {
      Alert.alert('Error', 'Failed to load manifest: ' + error.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadManifest();
  }, [tourId]);

  // --- Derived Data: Search & Grouping ---
  const { listData, isSearching } = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    
    if (!query) {
      // DEFAULT VIEW: Group by Pickup Location
      const groups = {};
      manifestData.bookings.forEach(booking => {
        const loc = booking.pickupLocation || 'Unknown Location';
        if (!groups[loc]) groups[loc] = [];
        groups[loc].push(booking);
      });

      const sections = Object.keys(groups).sort().map(loc => ({
        title: loc,
        data: groups[loc]
      }));
      
      return { listData: sections, isSearching: false };
    } 
    else {
      // SEARCH VIEW: Flat list filtered by Ref or Name
      const filtered = manifestData.bookings.filter(b => 
        b.id.toLowerCase().includes(query) ||
        b.passengerNames.some(name => name.toLowerCase().includes(query))
      );
      return { listData: filtered, isSearching: true };
    }
  }, [searchQuery, manifestData.bookings]);

  // --- Actions ---
  const handleOpenBooking = (booking) => {
    setSelectedBooking(booking);
    const existingStatuses = Array.isArray(booking.passengerStatus) ? booking.passengerStatus : [];
    const normalized = booking.passengerNames.map((_, idx) => existingStatuses[idx] || MANIFEST_STATUS.PENDING);
    setPartialStatuses(normalized);
    setPartialMode(false);
    setModalVisible(true);
  };

  const submitUpdate = async (passengerStatuses) => {
    if (!selectedBooking) return;

    try {
      setActionLoading(true);
      const statusesToPersist = passengerStatuses && passengerStatuses.length > 0
        ? passengerStatuses
        : selectedBooking.passengerNames.map(() => MANIFEST_STATUS.PENDING);

      await updateManifestBooking(tourId, selectedBooking.id, statusesToPersist);
      setModalVisible(false);
      setSelectedBooking(null);
      setPartialMode(false);
      await loadManifest();
    } catch (error) {
      Alert.alert('Error', 'Failed to update manifest: ' + error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetAll = (status) => {
    if (!selectedBooking) return;
    const statuses = selectedBooking.passengerNames.map(() => status);
    submitUpdate(statuses);
  };

  const handleConfirmPartial = () => submitUpdate(partialStatuses);

  const updatePassengerStatus = (index, status) => {
    setPartialStatuses((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  };

  // --- Render Functions ---
  const renderHeader = () => (
    <View style={styles.header}>
      {/* Back Button (Added from Phase 4 fix) */}
      <TouchableOpacity 
        onPress={() => navigation.goBack()} 
        style={styles.backButton}
      >
        <MaterialCommunityIcons name="arrow-left" size={24} color="white" />
        <Text style={styles.backText}>Console</Text>
      </TouchableOpacity>

      {/* --- NEW: DASHBOARD METRICS --- */}
      <View style={styles.dashboardContainer}>
        
        {/* Total Expected */}
        <View style={styles.dashboardItem}>
          <Text style={styles.dashLabel}>TOTAL</Text>
          <Text style={styles.dashValue}>{manifestData.stats.totalPax || 0}</Text>
        </View>

        {/* Vertical Divider */}
        <View style={styles.dashDivider} />

        {/* Boarded (Green) */}
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, { color: '#ABEBC6' }]}>BOARDED</Text>
          <Text style={[styles.dashValue, { color: COLORS.success }]}>
            {manifestData.stats.checkedIn || 0}
          </Text>
        </View>

        {/* Vertical Divider */}
        <View style={styles.dashDivider} />

        {/* No Shows (Red) */}
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, { color: '#F1948A' }]}>NO SHOW</Text>
          <Text style={[styles.dashValue, { color: COLORS.danger }]}>
            {manifestData.stats.noShows || 0}
          </Text>
        </View>

      </View>

      {/* Search Bar (Existing) */}
      <View style={styles.searchContainer}>
        <MaterialCommunityIcons name="magnify" size={24} color="#BDC3C7" />
        <TextInput 
          style={styles.searchInput}
          placeholder="Search Surname or Booking Ref..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="characters"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <MaterialCommunityIcons name="close-circle" size={20} color="#BDC3C7" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {renderHeader()}

      {loading && !refreshing ? (
        <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 20 }} />
      ) : (
        isSearching ? (
          <FlatList
            data={listData}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ManifestBookingCard 
                booking={item} 
                onPress={() => handleOpenBooking(item)} 
                isSearchResult={true} 
              />
            )}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={loadManifest}
          />
        ) : (
          <SectionList
            sections={listData}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ManifestBookingCard 
                booking={item} 
                onPress={() => handleOpenBooking(item)} 
                isSearchResult={false} 
              />
            )}
            renderSectionHeader={({ section: { title } }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{title}</Text>
              </View>
            )}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={loadManifest}
          />
        )
      )}

      {/* --- CHECK IN MODAL --- */}
      <Modal
        visible={modalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedBooking && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{selectedBooking.passengerNames[0]}</Text>
                  <Text style={styles.modalSubtitle}>Ref: {selectedBooking.id} • {selectedBooking.passengerNames.length} Pax</Text>
                </View>

                {partialMode ? (
                  <>
                    <Text style={styles.modalSectionLabel}>Select Passengers</Text>
                    <View style={styles.passengerList}>
                      {selectedBooking.passengerNames.map((name, idx) => {
                        const status = partialStatuses[idx] || MANIFEST_STATUS.PENDING;
                        return (
                          <View key={`${selectedBooking.id}-${idx}`} style={styles.passengerRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.passengerName}>{name}</Text>
                              <Text style={styles.passengerSeat}>Passenger {idx + 1}</Text>
                            </View>
                            <View style={styles.passengerActions}>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.BOARDED && styles.statusPillActiveSuccess]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.BOARDED)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.BOARDED && styles.statusPillTextActive]}>Boarded</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillActiveDanger]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.NO_SHOW)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillTextActive]}>No Show</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.PENDING && styles.statusPillActivePending]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.PENDING)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.PENDING && styles.statusPillTextActive]}>Pending</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })}
                    </View>

                    <View style={styles.partialFooter}>
                      <TouchableOpacity
                        style={[styles.partialFooterBtn, styles.partialFooterCancel]}
                        onPress={() => setPartialMode(false)}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.partialFooterText, { color: COLORS.info }]}>Back</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.partialFooterBtn, styles.partialFooterConfirm]}
                        onPress={handleConfirmPartial}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.partialFooterText, { color: 'white' }]}>Confirm</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.modalSectionLabel}>Actions</Text>

                    <View style={styles.actionRow}>
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.success }]}
                        onPress={() => handleSetAll(MANIFEST_STATUS.BOARDED)}
                        disabled={actionLoading}
                      >
                        <MaterialCommunityIcons name="check-all" size={28} color="white" />
                        <Text style={styles.actionBtnText}>All Here</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.danger }]}
                        onPress={() => handleSetAll(MANIFEST_STATUS.NO_SHOW)}
                        disabled={actionLoading}
                      >
                        <MaterialCommunityIcons name="close-circle-outline" size={28} color="white" />
                        <Text style={styles.actionBtnText}>No Show</Text>
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity
                      style={[styles.secondaryActionBtn, { borderColor: COLORS.info }]}
                      onPress={() => setPartialMode(true)}
                      disabled={actionLoading}
                    >
                        <Text style={{ color: COLORS.info, fontWeight: 'bold' }}>Some Here (Select Individuals)</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.closeBtn}
                      onPress={() => setModalVisible(false)}
                      disabled={actionLoading}
                    >
                      <Text style={styles.closeBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.panel,
    padding: 16,
    paddingTop: 12,
    paddingBottom: 22,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  backText: { color: 'white', fontSize: 16, fontWeight: 'bold', marginLeft: 5 },

  dashboardContainer: {
    flexDirection: 'row',
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 14,
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 3,
  },
  dashboardItem: {
    flex: 1,
    alignItems: 'center',
  },
  dashDivider: {
    width: 1,
    height: '70%',
    backgroundColor: '#1F2937',
  },
  dashLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#CBD5E1',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  dashValue: {
    fontSize: 26,
    fontWeight: 'bold',
    color: 'white',
  },

  searchContainer: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchInput: {
    flex: 1,
    marginLeft: 10,
    fontSize: 16,
    color: COLORS.primary,
  },
  
  listContent: { padding: 15 },
  sectionHeader: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 10,
    marginTop: 5,
  },
  sectionTitle: {
    fontWeight: 'bold',
    color: COLORS.muted,
    fontSize: 14,
  },

  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    minHeight: 350,
  },
  modalHeader: { marginBottom: 20, borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 15 },
  modalTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.primary },
  modalSubtitle: { fontSize: 16, color: COLORS.muted, marginTop: 5 },
  
  modalSectionLabel: { fontSize: 14, fontWeight: 'bold', color: COLORS.muted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 15, marginBottom: 15 },
  actionBtn: {
    flex: 1,
    paddingVertical: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: { color: 'white', fontSize: 16, fontWeight: 'bold', marginTop: 5 },
  
  secondaryActionBtn: {
    padding: 15,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    marginBottom: 20,
    borderStyle: 'dashed'
  },
  closeBtn: { padding: 15, alignItems: 'center' },
  closeBtnText: { color: COLORS.muted, fontWeight: 'bold', fontSize: 16 },

  passengerList: { gap: 10, marginBottom: 15 },
  passengerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  passengerName: { fontWeight: 'bold', color: COLORS.primary },
  passengerSeat: { color: COLORS.muted, marginTop: 4 },
  passengerActions: { flexDirection: 'row', gap: 8 },
  statusPill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'white'
  },
  statusPillText: { fontSize: 12, fontWeight: '600', color: COLORS.primary },
  statusPillActiveSuccess: { backgroundColor: '#ECFDF3', borderColor: '#BBF7D0' },
  statusPillActiveDanger: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  statusPillActivePending: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  statusPillTextActive: { color: COLORS.primary },
  partialFooter: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  partialFooterBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    alignItems: 'center'
  },
  partialFooterCancel: {
    borderWidth: 1,
    borderColor: COLORS.info,
    backgroundColor: 'white'
  },
  partialFooterConfirm: {
    backgroundColor: COLORS.info
  },
  partialFooterText: { fontWeight: 'bold' }
});
