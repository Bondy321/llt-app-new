import { ActivityIndicator, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import createItineraryScreenStyles from '../../screens/styles/ItineraryScreen.styles';
import { COLORS } from './itineraryPresentation';
import { FONT_WEIGHT, RADIUS, SHADOWS, SPACING } from '../../theme';
import { ITINERARY_DATA_SOURCE } from '../../utils/itinerarySyncPresentation';

const styles = createItineraryScreenStyles({ StyleSheet, COLORS, FONT_WEIGHT, Platform, RADIUS, SHADOWS, SPACING });

export function ItineraryLoadingView({ onBack, renderLoadingSkeleton, tourName }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={[COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Go back">
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerLabel}>Itinerary</Text>
            <Text style={styles.headerTitle} numberOfLines={2} maxFontSizeMultiplier={1.12}>
              {tourName || 'Loading...'}
            </Text>
          </View>
        </View>
      </LinearGradient>
      {renderLoadingSkeleton()}
    </SafeAreaView>
  );
}

export default function ItineraryView(props) {
  const {
    beginEditing, collapsedDays, dataSource, dataToRender, displayTitle, editConflict, errorMessage,
    expandAll, formatDayLabel, formatShortDate, getDayDate, handleAddDay, handleCancelEdit,
    handleDuplicateDay, handleEditDayContent, handleExportToCalendar, handleJumpToDay,
    handleKeepDraftAfterConflict, handleRemoveDay, handleSaveChanges, handleUseLatestItinerary,
    hasUnsupportedStartDate, isDriver, isEditing, isSearchActive, itinerary, loadItinerary, onBack,
    operationMessage, refreshing, renderDayRail, renderEmptyState, renderHeaderSummary,
    renderTimelineForDay, retryCount, saving, scrollViewRef, searchAnimation, searchQuery,
    setDayPositions, setOperationMessage, setSearchQuery, showSearch, syncAccessibilityLabel,
    syncStatus, timelineItemsByDay, todaysDayNumber, toggleDay, toggleExpandAll, toggleSearch,
    visibleDays,
  } = props;
return (
    <SafeAreaView style={styles.safeArea}>
      {/* HEADER */}
      <LinearGradient
        colors={isEditing ? [COLORS.editBg, COLORS.editBg] : [COLORS.primaryBlue, COLORS.complementaryBlue]}
        style={styles.headerGradient}
      >
        <View style={styles.headerContent}>
          {isEditing ? (
            <TouchableOpacity onPress={handleCancelEdit} style={styles.headerButton}>
              <Text style={{color: COLORS.danger, fontWeight: '700'}}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onBack} style={styles.headerButton}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
          )}

          <View style={styles.headerTitleContainer}>
            <Text style={[styles.headerLabel, isEditing && {color: COLORS.secondaryText}]}>
              {isEditing ? 'EDITING MODE' : 'Itinerary'}
            </Text>
            <Text
              style={[styles.headerTitle, isEditing && {color: COLORS.darkText}]}
              numberOfLines={2}
              maxFontSizeMultiplier={1.12}
            >
              {displayTitle}
            </Text>
          </View>

          {isDriver && !isEditing && !showSearch && (
            <View style={styles.headerActions}>
              <TouchableOpacity
                onPress={toggleSearch}
                style={[styles.headerIconButton, { marginRight: 8 }]}
                accessibilityRole="button"
                accessibilityLabel="Search itinerary"
              >
                <MaterialCommunityIcons name="magnify" size={22} color={COLORS.white} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => beginEditing()}
                style={[styles.headerButton, styles.editButton]}
                accessibilityRole="button"
                accessibilityLabel="Edit itinerary"
              >
                <MaterialCommunityIcons name="pencil" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          )}

          {!isDriver && !isEditing && !showSearch && (
            <TouchableOpacity
              onPress={toggleSearch}
              style={styles.headerIconButton}
              accessibilityRole="button"
              accessibilityLabel="Search itinerary"
            >
              <MaterialCommunityIcons name="magnify" size={22} color={COLORS.white} />
            </TouchableOpacity>
          )}

          {showSearch && !isEditing && (
            <TouchableOpacity
              onPress={toggleSearch}
              style={styles.headerIconButton}
              accessibilityRole="button"
              accessibilityLabel="Close itinerary search"
            >
              <MaterialCommunityIcons name="close" size={22} color={COLORS.white} />
            </TouchableOpacity>
          )}

          {isEditing && (
            <TouchableOpacity
              onPress={handleSaveChanges}
              disabled={saving || Boolean(editConflict)}
              style={[styles.headerButton, editConflict && styles.headerButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Save itinerary"
              accessibilityState={{ disabled: saving || Boolean(editConflict), busy: saving }}
            >
              {saving ? <ActivityIndicator color={COLORS.successGreen} /> : (
                <Text style={{color: COLORS.successGreen, fontWeight: '700', fontSize: 16}}>Save</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* SEARCH BAR */}
        {showSearch && (
          <Animated.View
            style={[
              styles.searchContainer,
              {
                opacity: searchAnimation,
                height: searchAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 50]
                })
              }
            ]}
          >
            <MaterialCommunityIcons name="magnify" size={20} color={COLORS.secondaryText} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search itinerary..."
              placeholderTextColor={COLORS.secondaryText}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <MaterialCommunityIcons name="close-circle" size={20} color={COLORS.secondaryText} />
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {renderHeaderSummary()}

        {/* QUICK TOOLBAR */}
        {!isEditing && itinerary?.days?.length > 0 && (
          <View style={styles.toolbar}>
            <TouchableOpacity onPress={toggleExpandAll} style={styles.toolbarButton}>
              <MaterialCommunityIcons
                name={expandAll ? "chevron-up-circle" : "chevron-down-circle"}
                size={18}
                color={COLORS.white}
              />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                {expandAll ? 'Collapse All' : 'Expand All'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => handleJumpToDay(todaysDayNumber || visibleDays[0]?.day || 1)} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="calendar-today" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                Today
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleExportToCalendar} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="export-variant" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                Export
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </LinearGradient>

      {renderDayRail()}

      {/* CONTENT */}
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        ref={scrollViewRef}
        refreshControl={
          !isEditing ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadItinerary({ showSkeleton: false })}
              tintColor={COLORS.primaryBlue}
            />
          ) : null
        }
      >
        {!isEditing && (
          <View
            style={[
              styles.syncStatusStrip,
              syncStatus.tone === 'warning' && styles.syncStatusStripWarning,
              syncStatus.tone === 'critical' && styles.syncStatusStripCritical,
            ]}
            accessible
            accessibilityLabel={syncAccessibilityLabel}
            accessibilityLiveRegion="polite"
          >
            <View
              style={[
                styles.syncStatusIcon,
                syncStatus.tone === 'warning' && styles.syncStatusIconWarning,
                syncStatus.tone === 'critical' && styles.syncStatusIconCritical,
              ]}
            >
              <MaterialCommunityIcons
                name={syncStatus.icon}
                size={18}
                color={
                  syncStatus.tone === 'critical'
                    ? COLORS.danger
                    : syncStatus.tone === 'warning'
                    ? '#B45309'
                    : COLORS.primaryBlue
                }
              />
            </View>
            <View style={styles.syncStatusTextWrap}>
              <Text
                style={[
                  styles.syncStatusLabel,
                  syncStatus.tone === 'warning' && styles.syncStatusLabelWarning,
                  syncStatus.tone === 'critical' && styles.syncStatusLabelCritical,
                ]}
                numberOfLines={1}
              >
                {syncStatus.label}
              </Text>
              <Text style={styles.syncStatusDetail} numberOfLines={1}>
                {syncStatus.detail}
              </Text>
            </View>
            {syncStatus.showRetry ? (
              <TouchableOpacity
                onPress={() => loadItinerary({ showSkeleton: false })}
                style={styles.syncRetryButton}
                accessibilityRole="button"
                accessibilityLabel="Retry itinerary refresh"
              >
                <Text style={styles.syncRetryText}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        {operationMessage && !isEditing ? (
          <View style={styles.successBanner} accessibilityRole="status">
            <MaterialCommunityIcons name="check-circle" size={20} color={COLORS.successGreen} />
            <Text style={styles.successBannerText}>{operationMessage}</Text>
            <TouchableOpacity
              onPress={() => setOperationMessage('')}
              accessibilityRole="button"
              accessibilityLabel="Dismiss published message"
            >
              <MaterialCommunityIcons name="close" size={20} color={COLORS.successGreen} />
            </TouchableOpacity>
          </View>
        ) : null}

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
            <Text style={styles.errorText}>{errorMessage}</Text>
            {retryCount > 0 && (
              <ActivityIndicator size="small" color={COLORS.white} style={{ marginLeft: 10 }} />
            )}
          </View>
        ) : null}

        {isEditing && dataSource === ITINERARY_DATA_SOURCE.CACHE && !editConflict ? (
          <View style={styles.offlineEditBanner} accessibilityRole="alert">
            <MaterialCommunityIcons name="cloud-alert" size={20} color="#B45309" />
            <Text style={styles.offlineEditText}>
              You are editing a saved copy. Keep your draft here, but reconnect before publishing so newer changes can be checked safely.
            </Text>
          </View>
        ) : null}

        {isEditing && editConflict ? (
          <View style={styles.conflictCard} accessibilityRole="alert">
            <View style={styles.conflictHeadingRow}>
              <View style={styles.conflictIconWrap}>
                <MaterialCommunityIcons name="shield-alert-outline" size={22} color={COLORS.danger} />
              </View>
              <View style={styles.conflictHeadingText}>
                <Text style={styles.conflictTitle}>A newer itinerary is already live</Text>
                <Text style={styles.conflictSubtitle}>
                  Revision {editConflict.serverRevision || 'latest'} was protected. Your draft is unchanged and has not been published.
                </Text>
              </View>
            </View>
            <Text style={styles.conflictHelp}>
              Load the latest version to include the other operator&apos;s work, or explicitly keep your draft after comparing every day.
            </Text>
            <View style={styles.conflictActions}>
              <TouchableOpacity
                onPress={handleUseLatestItinerary}
                style={[styles.conflictButton, styles.conflictPrimaryButton]}
                accessibilityRole="button"
                accessibilityLabel="Load latest itinerary"
              >
                <Text style={styles.conflictPrimaryText}>Load latest</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleKeepDraftAfterConflict}
                style={[styles.conflictButton, styles.conflictSecondaryButton]}
                accessibilityRole="button"
                accessibilityLabel="Keep my itinerary draft"
              >
                <Text style={styles.conflictSecondaryText}>Keep my draft</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {isDriver && isEditing && hasUnsupportedStartDate && (
          <View style={styles.dateWarningBanner}>
            <MaterialCommunityIcons name="alert-outline" size={14} color={COLORS.secondaryText} />
            <Text style={styles.dateWarningText}>
              Start date format not supported. Showing Day numbers only.
            </Text>
          </View>
        )}

        {(!dataToRender?.days || dataToRender.days.length === 0) ? (
          renderEmptyState()
        ) : (
          <>
            {dataToRender.days.map((dayData, dayIndex) => {
              const dayNumber = dayData?.day || dayIndex + 1;
              const isCollapsed = !isEditing && !isSearchActive && collapsedDays[dayNumber];
              const dayLabel = formatDayLabel(dayNumber);
              const isToday = todaysDayNumber === dayNumber;
              const content = dayData?.content || '';
              const dayItems = timelineItemsByDay[dayNumber] || [];
              const dayDate = getDayDate(dayNumber);
              const dayMetaLabel = dayItems.length
                ? `${dayItems.length} ${dayItems.length === 1 ? 'highlight' : 'highlights'}`
                : 'No details yet';

              return (
                <View
                  key={`${dayNumber}-${dayIndex}`}
                  style={[
                    styles.dayCard,
                    isToday && styles.todayCard,
                    isEditing && styles.editingCard
                  ]}
                  onLayout={(event) => {
                    const { y } = event.nativeEvent.layout;
                    setDayPositions((prev) => ({ ...prev, [dayNumber]: y }));
                  }}
                >
                  <LinearGradient
                    colors={isToday && !isEditing ? [COLORS.white, '#FFF7ED'] : [COLORS.white, '#F7FAFF']}
                    style={styles.dayCardInner}
                  >
                    <TouchableOpacity
                      onPress={() => toggleDay(dayNumber)}
                      disabled={isSearchActive}
                      activeOpacity={isEditing || isSearchActive ? 1 : 0.9}
                      accessible={true}
                      accessibilityLabel={`${dayLabel}${isToday ? ', today' : ''}`}
                      accessibilityRole={isSearchActive ? undefined : "button"}
                      accessibilityHint={
                        isSearchActive
                          ? "Search matches are expanded"
                          : isCollapsed
                          ? "Double tap to expand"
                          : "Double tap to collapse"
                      }
                    >
                      <View style={styles.dayHeader}>
                        {isEditing ? (
                          <>
                            <View style={[styles.dayBadge, isToday && styles.todayBadge]}>
                              <MaterialCommunityIcons
                                name={isToday ? "calendar-today" : "calendar-blank"}
                                size={14}
                                color={COLORS.white}
                                style={{ marginRight: 6 }}
                              />
                              <Text style={styles.dayBadgeText}>{dayLabel}</Text>
                            </View>
                            <View style={{ flex: 1 }} />
                            <View style={styles.dayEditActions}>
                              <TouchableOpacity
                                onPress={() => handleDuplicateDay(dayIndex)}
                                style={styles.dayActionButton}
                                accessible={true}
                                accessibilityLabel="Duplicate day"
                              >
                                <MaterialCommunityIcons name="content-copy" size={20} color={COLORS.primaryBlue} />
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => handleRemoveDay(dayIndex)}
                                style={styles.dayActionButton}
                                accessible={true}
                                accessibilityLabel="Delete day"
                              >
                                <MaterialCommunityIcons name="delete" size={20} color={COLORS.danger} />
                              </TouchableOpacity>
                            </View>
                          </>
                        ) : (
                          <View style={styles.readDayHeader}>
                            <View style={styles.readDayTitleWrap}>
                              <View style={styles.readDayTitleRow}>
                                <Text style={styles.readDayTitle}>Day {dayNumber}</Text>
                                {isToday ? (
                                  <View style={styles.todayInlineBadge}>
                                    <MaterialCommunityIcons name="calendar-today" size={12} color={COLORS.coralAccent} />
                                    <Text style={styles.todayInlineBadgeText}>Today</Text>
                                  </View>
                                ) : null}
                              </View>
                              <Text style={styles.readDayDateText} numberOfLines={1}>
                                {dayDate ? formatShortDate(dayDate) : 'Travel plan'}
                              </Text>
                              <Text style={styles.readDayMetaText} numberOfLines={1}>
                                {dayMetaLabel}
                              </Text>
                            </View>

                            <View style={styles.readDayChevron}>
                              <MaterialCommunityIcons
                                name={isCollapsed ? 'chevron-down' : 'chevron-up'}
                                size={26}
                                color={COLORS.secondaryText}
                              />
                            </View>
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>

                    {!isCollapsed && (
                      <View style={styles.contentContainer}>
                        {isEditing ? (
                          <TextInput
                            style={styles.editContentInput}
                            value={content}
                            onChangeText={(text) => handleEditDayContent(dayIndex, text)}
                            placeholder="Enter the itinerary for this day..."
                            placeholderTextColor={COLORS.secondaryText}
                            multiline
                            textAlignVertical="top"
                            accessible={true}
                            accessibilityLabel={`Day ${dayNumber} content`}
                          />
                        ) : (
                          renderTimelineForDay({ dayData, dayItems })
                        )}
                      </View>
                    )}
                  </LinearGradient>
                </View>
              );
            })}

            {isEditing && (
              <TouchableOpacity
                onPress={handleAddDay}
                style={styles.addDayBtn}
                accessible={true}
                accessibilityLabel="Add new day"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="calendar-plus" size={24} color={COLORS.white} />
                <Text style={styles.addDayText}>Add New Day</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <View style={styles.footerSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

