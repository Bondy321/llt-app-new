import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, ScrollView,
  SectionList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';

import ManifestBookingCard from '../ManifestBookingCard';
import ManifestConflictCard from '../ManifestConflictCard';
import createPassengerManifestScreenStyles from '../../screens/styles/PassengerManifestScreen.styles';
import { MANIFEST_STATUS } from '../../services/bookingServiceRealtime';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../../theme';
import { getBookingSyncState } from '../../utils/manifestSyncState';
import { COLORS, HEADER_WIDGETS_VISIBLE, STATUS_FILTERS } from './passengerManifestPresentation';

const styles = createPassengerManifestScreenStyles({ StyleSheet, COLORS, FONT_WEIGHT, RADIUS, SHADOWS, SPACING });

export default function PassengerManifestView(props) {
  const { actionLoading, activeQueueCount, bookingSyncState, confirmAllNoShow, failedQueueCount, filtersOpen, handleConfirmPartial, handleOpenBooking, handlePhoneBooking, handleRefresh, handleSetAll, handleSyncNow, isNarrowedView, loadManifest, loading, manifestConflict, manifestData, manifestLoadError, manifestSource, modalVisible, navigation, nextPriorityBooking, partialMode, partialStatuses, queueDescriptor, refreshing, resolutionStats, resultsDescriptor, searchQuery, sectionListData, selectedBooking, selectedBookingPhone, setFiltersOpen, setManifestConflict, setModalVisible, setPartialMode, setSearchQuery, setStatusFilter, showHeaderProgressRow, showStatusFeedback, sortedFilteredBookings, statusFeedback, statusFilter, totalStats, tourId, unresolvedDescriptor, updatePassengerStatus } = props;
const renderHeader = () => (
    <View style={styles.header}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Back to driver console"
        >
          <MaterialCommunityIcons name="arrow-left" size={20} color={COLORS.textLight} />
          <Text style={styles.backText}>Console</Text>
        </TouchableOpacity>
        <View style={styles.topBarTitleWrap}>
          <Text style={styles.headerTitle}>Passenger Manifest</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>Tour {tourId}</Text>
          {manifestSource === 'cache' && <Text style={styles.headerSubtitle}>Saved offline copy - refreshing when available</Text>}
        </View>
        <TouchableOpacity
          onPress={() => handleSyncNow()}
          style={styles.syncBtn}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? 'Syncing passenger manifest' : 'Sync passenger manifest'}
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
        >
          <Text style={styles.syncBtnText}>{refreshing ? 'Syncing...' : 'Sync'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.dashboardContainer}>
        <View style={styles.dashboardItem}>
          <Text style={styles.dashLabel}>EXPECTED</Text>
          <Text style={styles.dashValue}>{totalStats.totalPax}</Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.successTint]}>BOARDED</Text>
          <Text style={[styles.dashValue, { color: COLORS.success }]}>
            {totalStats.checkedIn}
          </Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.dangerTint]}>NO SHOW</Text>
          <Text style={[styles.dashValue, { color: COLORS.danger }]}>
            {totalStats.noShows}
          </Text>
        </View>
      </View>

      {showHeaderProgressRow ? (
      <View style={styles.progressRow}>
        {HEADER_WIDGETS_VISIBLE.completion && resolutionStats.unresolved > 0 ? (
        <View style={styles.progressShell}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressTitle}>Completion</Text>
            <Text style={styles.progressValue}>{resolutionStats.completionPercent}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${resolutionStats.completionPercent}%` }]} />
          </View>
          <Text style={styles.progressMeta}>
            {resolutionStats.resolved} resolved - {resolutionStats.unresolved} unresolved
          </Text>
        </View>
        ) : null}
        {HEADER_WIDGETS_VISIBLE.syncStatus && activeQueueCount > 0 ? (
        <View style={[
          styles.syncStatusPill,
          failedQueueCount > 0 && styles.syncStatusPill_error,
        ]}>
          <MaterialCommunityIcons
            name={failedQueueCount > 0 ? 'cloud-alert-outline' : 'cloud-check-outline'}
            size={14}
            color={COLORS.primaryDark}
          />
          <View style={styles.syncTextWrap}>
            <Text style={styles.syncStatusText}>{failedQueueCount > 0 ? 'Needs review' : 'Waiting to sync'}</Text>
            <Text style={styles.syncStatusMeta}>{queueDescriptor}</Text>
          </View>
        </View>
        ) : null}
      </View>
      ) : null}
      <ManifestConflictCard
        conflict={manifestConflict}
        onDismiss={() => setManifestConflict(null)}
        onReview={() => {
          const booking = manifestData.bookings.find((item) => item.id === manifestConflict?.bookingRef);
          if (booking) {
            handleOpenBooking(booking);
          } else if (manifestConflict?.bookingRef) {
            setSearchQuery(manifestConflict.bookingRef);
          }
        }}
      />

      <View style={styles.actionSearchRow}>
        {HEADER_WIDGETS_VISIBLE.nextPassenger && nextPriorityBooking ? (
          <TouchableOpacity
            style={styles.nextActionCard}
            onPress={() => handleOpenBooking(nextPriorityBooking)}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel={`Open next unresolved booking ${nextPriorityBooking.id}`}
          >
            <View style={styles.nextActionMeta}>
              <Text style={styles.nextActionEyebrow}>NEXT</Text>
              <Text style={styles.nextActionTitle}>{nextPriorityBooking.id}</Text>
            </View>
            <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.info} />
          </TouchableOpacity>
        ) : null}
        <View style={styles.searchContainer}>
          <MaterialCommunityIcons name="magnify" size={18} color={COLORS.muted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search passenger or booking..."
            placeholderTextColor={THEME.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="characters"
            accessibilityLabel="Search passengers or bookings"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear manifest search"
            >
              <MaterialCommunityIcons name="close-circle" size={18} color={COLORS.muted} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          onPress={() => setFiltersOpen((open) => !open)}
          style={[styles.filterToggle, (filtersOpen || statusFilter !== 'ALL') && styles.filterToggleActive]}
          accessibilityRole="button"
          accessibilityLabel="Toggle manifest filters"
          accessibilityState={{ expanded: filtersOpen, selected: statusFilter !== 'ALL' }}
        >
          <MaterialCommunityIcons
            name="filter-variant"
            size={18}
            color={(filtersOpen || statusFilter !== 'ALL') ? COLORS.textLight : COLORS.primaryDark}
          />
        </TouchableOpacity>
      </View>
      {(filtersOpen || statusFilter !== 'ALL') ? (
      <View style={styles.filtersRow}>
        <FlatList
          horizontal
          data={STATUS_FILTERS}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterChipRow}
          renderItem={({ item }) => {
            const isActive = statusFilter === item.key;
            return (
              <TouchableOpacity
                style={[styles.filterChip, isActive && styles.filterChipActive]}
                onPress={() => {
                  setStatusFilter(item.key);
                  if (item.key === 'ALL') setFiltersOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Show ${item.label.toLowerCase()} bookings`}
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{item.label}</Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>
      ) : null}
      {(isNarrowedView || resolutionStats.unresolved > 0) ? (
      <View style={styles.searchMetaRow}>
        <Text style={styles.searchMetaText}>{resultsDescriptor}</Text>
        <Text style={styles.searchMetaDivider}>-</Text>
        <Text style={styles.searchMetaText}>{unresolvedDescriptor}</Text>
      </View>
      ) : null}

      {statusFeedback && (
        <View style={[styles.statusBanner, styles[`statusBanner_${statusFeedback.variant || 'success'}`]]}>
          <View style={styles.statusBannerTextWrap}>
            <Text style={[styles.statusBannerText, styles[`statusBannerText_${statusFeedback.variant || 'success'}`]]}>
              {statusFeedback.message}
            </Text>
          </View>
          {statusFeedback.nextBooking && (
            <TouchableOpacity
              style={[styles.statusBannerBtn, styles[`statusBannerBtn_${statusFeedback.variant || 'success'}`]]}
              onPress={() => {
                handleOpenBooking(statusFeedback.nextBooking);
                showStatusFeedback(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Open next unresolved booking"
            >
              <Text style={styles.statusBannerBtnText}>Open next</Text>
            </TouchableOpacity>
          )}
          {statusFeedback.ctaLabel && statusFeedback.onCtaPress && (
            <TouchableOpacity
              style={[styles.statusBannerBtn, styles[`statusBannerBtn_${statusFeedback.variant || 'success'}`]]}
              onPress={statusFeedback.onCtaPress}
              accessibilityRole="button"
              accessibilityLabel={statusFeedback.ctaLabel}
            >
              <Text style={styles.statusBannerBtnText}>{statusFeedback.ctaLabel}</Text>
            </TouchableOpacity>
          )}
          {!statusFeedback.autoDismissMs && (
            <TouchableOpacity
              onPress={() => showStatusFeedback(null)}
              style={styles.statusBannerDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss manifest status"
            >
              <MaterialCommunityIcons name="close" size={16} color={COLORS.info} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {renderHeader()}

      {loading && !refreshing ? (
        <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 20 }} />
      ) : (
        manifestLoadError && manifestData.bookings.length === 0 ? (
          <View style={styles.emptyStateCard} accessibilityRole="alert">
            <MaterialCommunityIcons name="cloud-alert-outline" size={34} color={COLORS.danger} />
            <Text style={styles.emptyStateTitle}>Manifest unavailable</Text>
            <Text style={styles.emptyStateBody}>{manifestLoadError}</Text>
            <TouchableOpacity
              style={styles.emptyStateRetryButton}
              onPress={() => loadManifest()}
              accessibilityRole="button"
              accessibilityLabel="Retry loading the passenger manifest"
            >
              <MaterialCommunityIcons name="refresh" size={18} color={COLORS.textLight} />
              <Text style={styles.emptyStateRetryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : sortedFilteredBookings.length === 0 ? (
          <View style={styles.emptyStateCard}>
            <MaterialCommunityIcons name="clipboard-search-outline" size={34} color={COLORS.primary} />
            <Text style={styles.emptyStateTitle}>{isNarrowedView ? 'No matching bookings' : 'No passengers on this manifest'}</Text>
            <Text style={styles.emptyStateBody}>
              {isNarrowedView
                ? 'Adjust search or filters to find passengers, then update statuses.'
                : 'This tour currently has no passenger bookings to board.'}
            </Text>
          </View>
        ) : (
          <SectionList
            sections={sectionListData}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ManifestBookingCard
                booking={item}
                onPress={() => handleOpenBooking(item)}
                isSearchResult={false}
                syncState={getBookingSyncState(bookingSyncState, item.id) || 'synced'}
              />
            )}
            renderSectionHeader={({ section: { title } }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{title}</Text>
              </View>
            )}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={handleRefresh}
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
        <KeyboardAvoidingView
          style={styles.modalKeyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent} accessibilityViewIsModal>
            {selectedBooking && (
              <>
                <View style={styles.modalHeader}>
                  <View style={styles.modalHeaderRow}>
                    <View style={styles.modalHeaderText}>
                      <Text style={styles.modalTitle}>{selectedBooking.passengerNames[0]}</Text>
                      <Text style={styles.modalSubtitle}>Ref: {selectedBooking.id} - {selectedBooking.passengerNames.length} Pax</Text>
                    </View>
                    {selectedBookingPhone ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Phone booking ${selectedBooking.id}`}
                        accessibilityHint="Opens the phone app with the booking lead number ready to call."
                        activeOpacity={0.8}
                        onPress={handlePhoneBooking}
                        style={styles.phoneBookingBtn}
                      >
                        <MaterialCommunityIcons name="phone-outline" size={20} color={COLORS.textLight} />
                        <Text style={styles.phoneBookingBtnText}>Phone booking</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                <ScrollView
                  style={styles.modalBody}
                  contentContainerStyle={styles.modalBodyContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                >
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
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as boarded`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.BOARDED, disabled: actionLoading }}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.BOARDED && styles.statusPillTextActive]}>Boarded</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillActiveDanger]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.NO_SHOW)}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as no-show`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.NO_SHOW, disabled: actionLoading }}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillTextActive]}>No Show</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.PENDING && styles.statusPillActivePending]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.PENDING)}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as pending`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.PENDING, disabled: actionLoading }}
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
                        accessibilityRole="button"
                        accessibilityLabel="Confirm individual passenger statuses"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
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
                        accessibilityLabel={`Mark all passengers here for booking ${selectedBooking.id}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
                      >
                        <MaterialCommunityIcons name="check-all" size={28} color="white" />
                        <Text style={styles.actionBtnText}>All Here</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.danger }]}
                        onPress={confirmAllNoShow}
                        disabled={actionLoading}
                        accessibilityLabel={`Mark all passengers no-show for booking ${selectedBooking.id}`}
                        accessibilityRole="button"
                        accessibilityHint="Asks for confirmation before saving"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
                      >
                        <MaterialCommunityIcons name="close-circle-outline" size={28} color="white" />
                        <Text style={styles.actionBtnText}>No Show</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.modalHintRow}>
                      <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.muted} />
                      <Text style={styles.modalHintText}>
                        Use "Some Here" when only part of the booking has boarded.
                      </Text>
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
                </ScrollView>
              </>
            )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}
