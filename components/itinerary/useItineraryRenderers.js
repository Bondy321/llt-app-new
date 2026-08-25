import { useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import createItineraryScreenStyles from '../../screens/styles/ItineraryScreen.styles';
import { buildItineraryItems } from '../../utils/itineraryPresentation';
import { FONT_WEIGHT, RADIUS, SHADOWS, SPACING } from '../../theme';
import { COLORS } from './itineraryPresentation';
import useItinerarySyncPresentation from './useItinerarySyncPresentation';

const styles = createItineraryScreenStyles({ StyleSheet, COLORS, FONT_WEIGHT, Platform, RADIUS, SHADOWS, SPACING });

export default function useItineraryRenderers(context) {
  const { beginEditing, checkingForUpdates, dataSource, editedItinerary, errorMessage, filteredItinerary, formatShortDate, freshnessNow, getDayDate, handleJumpToDay, isDriver, isEditing, itinerary, lastSyncedAt, refreshing, searchQuery, setSearchQuery, todaysDayNumber, tourDayContext, tourName } = context;
  // --- LOADING SKELETON ---
  const renderLoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      {[1, 2, 3].map((i) => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonHeader} />
          <View style={styles.skeletonLine} />
          <View style={styles.skeletonLine} />
          <View style={[styles.skeletonLine, { width: '60%' }]} />
        </View>
      ))}
    </View>
  );

  const isSearchActive = searchQuery.trim().length > 0 && !isEditing;

  // --- EMPTY STATE ---
  const renderEmptyState = () => {
    return (
      <View style={styles.emptyContainer}>
        <MaterialCommunityIcons name="calendar-blank-outline" size={80} color={COLORS.timelineColor} />
        <Text style={styles.emptyTitle}>
          {isSearchActive ? 'No Matching Days' : 'No Itinerary Yet'}
        </Text>
        <Text style={styles.emptySubtitle}>
          {isSearchActive
            ? "Try a different search term or clear search to see every day."
            : isDriver
            ? "Tap the edit button to create your first day"
            : "Your tour itinerary will appear here soon"}
        </Text>
        {isSearchActive && (
          <TouchableOpacity
            style={styles.emptySecondaryButton}
            onPress={() => setSearchQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear itinerary search"
          >
            <MaterialCommunityIcons name="close-circle-outline" size={20} color={COLORS.primaryBlue} />
            <Text style={styles.emptySecondaryButtonText}>Clear search</Text>
          </TouchableOpacity>
        )}
        {isDriver && !isSearchActive && (
          <TouchableOpacity
            style={styles.emptyButton}
            onPress={() => {
              const emptyItinerary = {
                title: tourName || 'Tour',
                days: [
                  {
                    day: 1,
                    content: ''
                  }
                ]
              };
              beginEditing(emptyItinerary);
            }}
          >
            <MaterialCommunityIcons name="plus" size={20} color={COLORS.white} />
            <Text style={styles.emptyButtonText}>Create Itinerary</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const dataToRender = isEditing ? editedItinerary : (searchQuery ? filteredItinerary : itinerary);
  const visibleDays = useMemo(() => dataToRender?.days || [], [dataToRender?.days]);
  const itineraryDayCount = itinerary?.days?.length || 0;
  const displayTitle = tourName || dataToRender?.title || itinerary?.title || 'Tour itinerary';

  const { syncAccessibilityLabel, syncStatus } = useItinerarySyncPresentation({
    checkingForUpdates,
    dataSource,
    errorMessage,
    freshnessNow,
    itinerary,
    lastSyncedAt,
    refreshing,
  });

  const headerDaySummary = useMemo(() => {
    if (!itineraryDayCount) {
      return {
        icon: 'calendar-blank-outline',
        label: 'Itinerary pending',
      };
    }

    if (tourDayContext.status === 'ACTIVE' && todaysDayNumber) {
      const todayDate = getDayDate(todaysDayNumber);
      return {
        icon: 'calendar-today',
        label: todayDate
          ? `Today: Day ${todaysDayNumber}, ${formatShortDate(todayDate)}`
          : `Today: Day ${todaysDayNumber}`,
      };
    }

    if (tourDayContext.status === 'FUTURE') {
      const firstDate = getDayDate(1);
      return {
        icon: 'calendar-start',
        label: firstDate ? `Starts ${formatShortDate(firstDate)}` : 'Tour starts soon',
      };
    }

    if (tourDayContext.status === 'COMPLETED') {
      return {
        icon: 'calendar-check-outline',
        label: 'Tour dates completed',
      };
    }

    return {
      icon: 'calendar-question',
      label: 'Dates to be confirmed',
    };
  }, [formatShortDate, getDayDate, itineraryDayCount, todaysDayNumber, tourDayContext]);

  const timelineItemsByDay = useMemo(() => {
    const itemsByDay = {};
    visibleDays.forEach((dayData, dayIndex) => {
      const dayNumber = dayData?.day || dayIndex + 1;
      itemsByDay[dayNumber] = buildItineraryItems(dayData?.content || '');
    });
    return itemsByDay;
  }, [visibleDays]);

  const renderHeaderSummary = () => {
    if (isEditing) return null;

    return (
      <View style={styles.readSummaryPanel}>
        <Text style={styles.readSummaryEyebrow}>Daily travel plan</Text>

        <View style={styles.summaryPillRow}>
          <View style={styles.summaryPill}>
            <MaterialCommunityIcons name="calendar-multiselect" size={15} color={COLORS.primaryBlue} />
            <Text style={styles.summaryPillText} numberOfLines={1}>
              {itineraryDayCount === 1 ? '1 day' : `${itineraryDayCount} days`}
            </Text>
          </View>

          <View style={[styles.summaryPill, styles.summaryPillWide]}>
            <MaterialCommunityIcons name={headerDaySummary.icon} size={15} color={COLORS.primaryBlue} />
            <Text style={styles.summaryPillText} numberOfLines={1}>
              {headerDaySummary.label}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderDayRail = () => {
    if (isEditing || visibleDays.length === 0) return null;

    return (
      <View style={styles.dayRailContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.dayRailContent}
        >
          {visibleDays.map((dayData, dayIndex) => {
            const dayNumber = dayData?.day || dayIndex + 1;
            const isToday = todaysDayNumber === dayNumber;
            const dayDate = getDayDate(dayNumber);
            const items = timelineItemsByDay[dayNumber] || [];

            return (
              <TouchableOpacity
                key={`rail-${dayNumber}-${dayIndex}`}
                onPress={() => handleJumpToDay(dayNumber)}
                style={[styles.dayRailChip, isToday && styles.dayRailChipToday]}
                activeOpacity={0.86}
                accessibilityRole="button"
                accessibilityLabel={`Jump to Day ${dayNumber}${isToday ? ', today' : ''}`}
              >
                <View style={styles.dayRailTopRow}>
                  <Text style={[styles.dayRailDayText, isToday && styles.dayRailDayTextToday]}>
                    Day {dayNumber}
                  </Text>
                  {isToday ? (
                    <View style={styles.dayRailTodayDot}>
                      <Text style={styles.dayRailTodayText}>Today</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.dayRailDateText, isToday && styles.dayRailDateTextToday]} numberOfLines={1}>
                  {dayDate ? formatShortDate(dayDate) : `${items.length || 0} items`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  const renderTimelineForDay = ({ dayData, dayItems }) => {
    const content = String(dayData?.content || '').trim();

    if (!content) {
      return (
        <View style={styles.emptyDayPanel}>
          <MaterialCommunityIcons name="calendar-edit" size={22} color={COLORS.mutedText} />
          <Text style={styles.emptyDayText}>No detailed plan has been published for this day yet.</Text>
        </View>
      );
    }

    if (!dayItems.length) {
      return (
        <Text style={styles.dayContentText}>
          {content}
        </Text>
      );
    }

    return (
      <View style={styles.timelineList}>
        {dayItems.map((item, itemIndex) => {
          const isLast = itemIndex === dayItems.length - 1;
          const isSingle = dayItems.length === 1;

          return (
            <View
              key={item.id}
              style={styles.timelineItem}
              accessible={true}
              accessibilityLabel={item.text}
            >
              <View style={styles.timelineMarkerColumn}>
                <View
                  style={[
                    styles.timelineConnector,
                    itemIndex === 0 && styles.timelineConnectorFirst,
                    isLast && styles.timelineConnectorLast,
                    isSingle && styles.timelineConnectorHidden,
                  ]}
                />
                <View style={styles.timelineIconCircle}>
                  <MaterialCommunityIcons
                    name={item.iconKey}
                    size={16}
                    color={COLORS.primaryBlue}
                  />
                </View>
              </View>

              <View style={styles.timelineTextColumn}>
                <View style={styles.timelineTitleRow}>
                  <Text style={styles.timelineItemText}>
                    {item.text}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    );
  };

  return {
    dataToRender,
    displayTitle,
    isSearchActive,
    renderDayRail,
    renderEmptyState,
    renderHeaderSummary,
    renderLoadingSkeleton,
    renderTimelineForDay,
    syncAccessibilityLabel,
    syncStatus,
    timelineItemsByDay,
    visibleDays,
  };
}
