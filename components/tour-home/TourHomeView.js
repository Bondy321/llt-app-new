import { Animated, Image, Modal, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import TodaysAgendaCard from '../TodaysAgendaCard';
import createTourHomeScreenStyles from '../../screens/styles/TourHomeScreen.styles';
import { COLORS } from './tourHomePresentation';
import { AnimatedCard, DriverStatusIndicator, FeatureCard, PickupCountdown, QuickActionButton, StatusPulse } from './TourHomeComponents';
import { RADIUS, SHADOWS, SPACING } from '../../theme';

const styles = createTourHomeScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });

export default function TourHomeView(props) {
  const { actionPlan, bookingData, driverLocationActive, driverLocationAvailable, greeting, handleCallDriver, isHeaderMenuOpen, isNoShow, manifestStatusMeta, menuItems, navigateWithLog, noShowAcknowledged, onLogout, onRefresh, orderedQuickActions, primaryPickupDate, primaryPickupTime, refreshing, responsiveStyles, scrollViewRef, setIsHeaderMenuOpen, setNoShowAcknowledged, tourCode, tourData } = props;
return (
    <View style={styles.screen}>
      <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
      <SafeAreaView style={styles.statusBarSafeArea} edges={['top']} />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
        <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
          <ScrollView
            ref={scrollViewRef}
            contentContainerStyle={[styles.container, responsiveStyles.container]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={[COLORS.primaryBlue]}
                tintColor={COLORS.primaryBlue}
                title="Updating..."
                titleColor={COLORS.subtleText}
              />
            }
          >
          {/* Header */}
          <AnimatedCard style={[styles.header, responsiveStyles.header]} delay={0}>
            <View style={[styles.headerBrandMark, responsiveStyles.headerBrandMark]}>
              <Image
                source={require('../../assets/images/logo_for_tour_home.png')}
                style={[styles.logoImage, responsiveStyles.logoImage]}
              />
            </View>
            <View style={[styles.headerTextContainer, responsiveStyles.headerTextContainer]}>
              <View style={styles.greetingTitleRow}>
                <View style={[
                  styles.greetingIconBadge,
                  responsiveStyles.greetingIconBadge,
                  { backgroundColor: `${greeting.color}14` },
                ]}>
                  <MaterialCommunityIcons name={greeting.icon} size={17} color={greeting.color} />
                </View>
                <Text
                  style={[styles.greetingText, responsiveStyles.greetingText]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.heading}
                >
                  {`${greeting.text}!`}
                </Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={[
                  styles.headerMenuButton,
                  responsiveStyles.headerMenuButton,
                  isHeaderMenuOpen && styles.headerMenuButtonActive,
                ]}
                onPress={() => {
                  triggerHaptic('light');
                  setIsHeaderMenuOpen((open) => !open);
                }}
                accessible={true}
                accessibilityLabel="Open account menu"
                accessibilityRole="button"
                accessibilityState={{ expanded: isHeaderMenuOpen }}
              >
                <MaterialCommunityIcons
                  name={isHeaderMenuOpen ? 'chevron-up' : 'dots-horizontal'}
                  size={24}
                  color={COLORS.primaryBlue}
                />
              </TouchableOpacity>
              {isHeaderMenuOpen ? (
                <View style={styles.headerMenuDropdown}>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      navigateWithLog('AccountPrivacy', { from: 'TourHome' }, 'header_account');
                    }}
                    accessible={true}
                    accessibilityLabel="Account and privacy"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="account-cog-outline" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Account</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      navigateWithLog('NotificationPreferences', {}, 'header_notifications');
                    }}
                    accessible={true}
                    accessibilityLabel="Notification settings"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="bell-ring-outline" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Notifications</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      triggerHaptic('light');
                      logger.info('TourHome', 'Logout requested from header', {
                        tourId: activeTourId || null,
                        bookingRef: maskIdentifier(bookingRef),
                      });
                      onLogout();
                    }}
                    activeOpacity={0.7}
                    accessible={true}
                    accessibilityLabel="Log out"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="logout-variant" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Log out</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          </AnimatedCard>

          {/* Pickup countdown timer */}
          {primaryPickupTime && manifestStatus !== MANIFEST_STATUS.BOARDED && (
            <AnimatedCard delay={50}>
              <PickupCountdown pickupTime={primaryPickupTime} pickupDate={primaryPickupDate} />
            </AnimatedCard>
          )}

          {/* Status card with enhanced visuals */}
          <AnimatedCard style={styles.statusCard} delay={100}>
            <LinearGradient
              colors={[manifestStatusMeta.toneLight, COLORS.white]}
              style={[styles.statusCardGradient, responsiveStyles.statusCardGradient]}
            >
              <View style={styles.statusIconContainer}>
                <StatusPulse color={manifestStatusMeta.tone} />
                <View style={[styles.statusIconCircle, { backgroundColor: `${manifestStatusMeta.tone}20` }]}>
                  <MaterialCommunityIcons
                    name={manifestStatusMeta.icon}
                    size={28}
                    color={manifestStatusMeta.tone}
                  />
                </View>
              </View>
              <View style={styles.statusContent}>
                <View style={styles.statusHeader}>
                  <View style={[styles.statusBadge, { backgroundColor: `${manifestStatusMeta.tone}20` }]}>
                    <Text style={[styles.statusBadgeText, { color: manifestStatusMeta.tone }]}>
                      {manifestStatusMeta.badge}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[styles.statusTitle, responsiveStyles.statusTitle]}
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                >
                  {manifestStatusMeta.title}
                </Text>
                <Text
                  style={[styles.statusMessage, responsiveStyles.statusMessage]}
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                >
                  {manifestStatusMeta.message}
                </Text>
              </View>
            </LinearGradient>
          </AnimatedCard>

          {/* Quick Actions Bar */}
          <AnimatedCard delay={150}>
            <View style={[styles.quickActionsContainer, responsiveStyles.quickActionsContainer]}>
              <Text
                style={[styles.quickActionsTitle, responsiveStyles.quickActionsTitle]}
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
              >
                {actionPlan.title}
              </Text>
              <Text
                style={[styles.quickActionsSubtitle, responsiveStyles.quickActionsSubtitle]}
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
              >
                {actionPlan.subtitle}
              </Text>
              <View style={[styles.quickActionsRow, responsiveStyles.quickActionsRow]}>
                {orderedQuickActions.map((action, index) => (
                  <QuickActionButton
                    key={`${action.label}-${index}`}
                    {...action}
                    delay={200 + index * 50}
                    compact={responsiveStyles.compactActions}
                  />
                ))}
              </View>
            </View>
          </AnimatedCard>

          {/* Digital Boarding Pass */}
          {tourData && (
            <AnimatedCard style={styles.boardingPass} delay={200}>
              {/* Ticket header with torn edge effect */}
              <LinearGradient
                colors={[COLORS.primaryBlue, COLORS.primaryDark]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.boardingPassHeader}
              >
                <View style={styles.boardingPassHeaderContent}>
                  <View style={styles.boardingPassHeaderTextContainer}>
                    <Text style={styles.boardingPassLabel}>DIGITAL BOARDING PASS</Text>
                    <Text
                      style={[styles.boardingPassTour, responsiveStyles.boardingPassTour]}
                      numberOfLines={2}
                      adjustsFontSizeToFit
                      maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                    >
                      {tourData.name || 'Scenic Tour'}
                    </Text>
                  </View>
                  <View style={styles.boardingPassQR}>
                    <MaterialCommunityIcons name="qrcode" size={48} color="rgba(255,255,255,0.9)" />
                  </View>
                </View>
              </LinearGradient>

              {/* Torn edge decoration */}
              <View style={styles.tornEdge}>
                {[...Array(20)].map((_, i) => (
                  <View key={i} style={styles.tornEdgeBump} />
                ))}
              </View>

              {/* Ticket body */}
              <View style={styles.boardingPassBody}>
                {/* Driver info */}
                {tourData.driverName && (
                  <DriverStatusIndicator
                    driverName={tourData.driverName}
                    isLive={driverLocationActive}
                  />
                )}

                <View style={styles.boardingPassDivider} />

                {/* Pickup Information */}
                {bookingData?.pickupPoints && bookingData.pickupPoints.length > 0 ? (
                  <View style={styles.pickupSection}>
                    <Text style={styles.pickupSectionTitle}>
                      {bookingData.pickupPoints.length > 1 ? 'Pickup Points' : 'Pickup Location'}
                    </Text>
                    {bookingData.pickupPoints.map((pickup, index) => (
                      <View key={index} style={styles.pickupCard}>
                        <View style={styles.pickupTimeBox}>
                          <Text style={styles.pickupTimeText}>{pickup.time}</Text>
                        </View>
                        <View style={styles.pickupLocationInfo}>
                          <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.coralAccent} />
                          <View style={styles.pickupLocationCopy}>
                            <Text
                              style={[styles.pickupLocationText, responsiveStyles.pickupLocationText]}
                              numberOfLines={2}
                              maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                            >
                              {pickup.location}
                            </Text>
                            {formatPickupDate(pickup.date || bookingData.pickupDate) ? (
                              <Text style={styles.pickupDateText}>
                                {formatPickupDate(pickup.date || bookingData.pickupDate)}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : bookingData?.pickupTime ? (
                  <View style={styles.pickupSection}>
                    <Text style={styles.pickupSectionTitle}>Pickup Location</Text>
                    <View style={styles.pickupCard}>
                      <View style={styles.pickupTimeBox}>
                        <Text style={styles.pickupTimeText}>{bookingData.pickupTime}</Text>
                      </View>
                      <View style={styles.pickupLocationInfo}>
                        <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.coralAccent} />
                        <View style={styles.pickupLocationCopy}>
                          <Text
                            style={[styles.pickupLocationText, responsiveStyles.pickupLocationText]}
                            numberOfLines={2}
                            maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                          >
                            {bookingData.pickupLocation}
                          </Text>
                          {formatPickupDate(bookingData.pickupDate) ? (
                            <Text style={styles.pickupDateText}>{formatPickupDate(bookingData.pickupDate)}</Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  </View>
                ) : null}

                {/* Seat Information */}
                {bookingData?.seatNumbers?.length > 0 && (
                  <View style={styles.seatSection}>
                    <View style={styles.seatGrid}>
                      {Array.from({ length: Math.ceil(bookingData.seatNumbers.length / 2) }, (_, rowIndex) => {
                        const rowSeats = bookingData.seatNumbers.slice(rowIndex * 2, rowIndex * 2 + 2);

                        return (
                          <View key={`seat-row-${rowIndex}`} style={styles.seatRow}>
                            {rowSeats.map((seat, seatIndex) => (
                              <View key={`seat-${rowIndex}-${seatIndex}-${seat}`} style={styles.seatBox}>
                                <MaterialCommunityIcons name="seat" size={18} color={COLORS.coralAccent} />
                                <Text style={styles.seatNumber}>{seat}</Text>
                              </View>
                            ))}
                          </View>
                        );
                      })}
                    </View>
                    <Text style={styles.seatLabel}>
                      {bookingData.seatNumbers.length > 1 ? 'Assigned Seats' : 'Your Seat'}
                    </Text>
                  </View>
                )}

                {/* Passengers list */}
                {bookingData?.passengerNames?.length > 1 && (
                  <View style={styles.passengersSection}>
                    <Text style={styles.passengersSectionTitle}>Passengers</Text>
                    {bookingData.passengerNames.map((name, index) => (
                      <View key={index} style={styles.passengerRow}>
                        <View style={styles.passengerAvatar}>
                          <Text style={styles.passengerAvatarText}>
                            {name.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <Text style={styles.passengerName}>{name}</Text>
                        {bookingData.seatNumbers?.[index] != null ? (
                          <Text style={styles.passengerSeat}>{`Seat ${bookingData.seatNumbers[index]}`}</Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}

                {/* Footer with booking ref */}
                <View style={styles.boardingPassFooter}>
                  <View>
                    <Text style={styles.boardingPassFooterLabel}>Booking Reference</Text>
                    <Text style={styles.boardingPassFooterValue}>{bookingData?.id}</Text>
                  </View>
                  <View style={styles.boardingPassFooterRight}>
                    <Text style={styles.boardingPassFooterLabel}>Tour Code</Text>
                    <Text style={styles.boardingPassFooterValue}>{tourCode}</Text>
                  </View>
                </View>
              </View>
            </AnimatedCard>
          )}

          {/* Today's Agenda */}
          {tourData && (
            <AnimatedCard delay={250}>
              <TodaysAgendaCard tourData={tourData} onNudge={() => navigateWithLog('Itinerary', {}, 'agenda_nudge')} />
            </AnimatedCard>
          )}

          {/* Find My Bus - Enhanced Feature Card */}
          <AnimatedCard
            style={styles.findBusCard}
            delay={300}
            onPress={() => {
              navigateWithLog('Map', {}, 'find_bus_card');
            }}
            accessibilityLabel="Find My Bus"
            accessibilityHint="View your driver's location on the map"
          >
            <LinearGradient
              colors={[`${COLORS.coralAccent}12`, `${COLORS.coralAccent}05`]}
              style={styles.findBusGradient}
            >
              <View style={styles.findBusContent}>
                <View style={styles.findBusIconContainer}>
                  <MaterialCommunityIcons name="bus-marker" size={36} color={COLORS.coralAccent} />
                  {driverLocationActive && (
                    <View style={styles.findBusLiveBadge}>
                      <View style={styles.findBusLiveDot} />
                      <Text style={styles.findBusLiveText}>LIVE</Text>
                    </View>
                  )}
                </View>
                <View style={styles.findBusTextContainer}>
                  <Text style={styles.findBusTitle}>Find My Bus</Text>
                  <Text style={styles.findBusSubtitle}>
                    {driverLocationActive
                      ? 'Driver live location is being shared'
                      : driverLocationAvailable
                        ? 'Driver pickup point is available'
                        : 'See where your driver is on the map'}
                  </Text>
                </View>
                <View style={styles.findBusArrow}>
                  <MaterialCommunityIcons name="arrow-right-circle" size={32} color={COLORS.coralAccent} />
                </View>
              </View>
            </LinearGradient>
          </AnimatedCard>

          {/* Tour Features Grid - Enhanced Layout */}
          <Text style={styles.sectionTitle}>Tour Features</Text>
          <View style={styles.featuresGrid}>
            {/* First row - 2 cards */}
            <View style={styles.featuresRow}>
              <FeatureCard
                item={menuItems[0]}
                index={0}
                onPress={() => navigateWithLog(menuItems[0].id, {}, 'feature_card')}
              />
              <FeatureCard
                item={menuItems[1]}
                index={1}
                onPress={() => navigateWithLog(menuItems[1].id, {}, 'feature_card')}
              />
            </View>
            {/* Second row - 2 cards */}
            <View style={styles.featuresRow}>
              <FeatureCard
                item={menuItems[2]}
                index={2}
                onPress={() => navigateWithLog(menuItems[2].id, {}, 'feature_card')}
              />
              <FeatureCard
                item={menuItems[3]}
                index={3}
                onPress={() => navigateWithLog(menuItems[3].id, {}, 'feature_card')}
              />
            </View>
            {/* Third row - 1 full-width card for Safety */}
            <FeatureCard
              item={menuItems[4]}
              index={4}
              isLarge={true}
              onPress={() => navigateWithLog('SafetySupport', { from: 'TourHome', mode: 'passenger' }, 'feature_card')}
            />
          </View>

          {/* Bottom spacing */}
          <View style={{ height: 40 }} />
          </ScrollView>
        </LinearGradient>

        {/* Enhanced No-Show Modal */}
        <Modal
          visible={isNoShow && !noShowAcknowledged}
          transparent
          animationType="fade"
          presentationStyle="overFullScreen"
          onRequestClose={() => setNoShowAcknowledged(true)}
        >
          <View style={styles.modalOverlay}>
            <Animated.View
              style={styles.modalCard}
              accessibilityViewIsModal
              accessibilityRole="alert"
              accessibilityLabel="You have been marked as missing from pickup"
            >
              <LinearGradient
                colors={[COLORS.errorLight, COLORS.white]}
                style={styles.modalGradient}
              >
              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={styles.modalScrollContent}
                showsVerticalScrollIndicator
                bounces={false}
              >
              <View style={styles.modalIconContainer}>
                <View style={styles.modalIconPulse} />
                <View style={styles.modalIconCircle}>
                  <MaterialCommunityIcons name="alert-circle" size={40} color={COLORS.error} />
                </View>
              </View>

              <Text style={styles.modalTitle}>You've Been Marked as Missing</Text>
              <Text style={styles.modalMessage}>
                Your driver has marked you as not at the pickup location. Please contact them immediately
                so they can wait for you or help you find the right location.
              </Text>

              <View style={styles.modalDivider} />

              <Text style={styles.modalActionLabel}>What would you like to do?</Text>

              <TouchableOpacity
                style={styles.modalPrimaryButton}
                onPress={handleCallDriver}
                activeOpacity={0.9}
                accessibilityRole="button"
                accessibilityLabel="Call your driver now"
              >
                <LinearGradient
                  colors={[COLORS.coralAccent, '#E55B3C']}
                  style={styles.modalButtonGradient}
                >
                  <MaterialCommunityIcons name="phone" size={22} color={COLORS.white} />
                  <Text style={styles.modalPrimaryButtonText}>Call Driver Now</Text>
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalSecondaryButton}
                onPress={handleMessageDriver}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Send your driver a text message"
              >
                <MaterialCommunityIcons name="message-text" size={20} color={COLORS.primaryBlue} />
                <Text style={styles.modalSecondaryButtonText}>Send Text Message</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalEmergencyButton}
                onPress={() => navigateWithLog('SafetySupport', { from: 'TourHome', mode: 'passenger' }, 'no_show_modal')}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Open emergency assistance"
              >
                <MaterialCommunityIcons name="shield-alert" size={18} color={COLORS.error} />
                <Text style={styles.modalEmergencyButtonText}>Emergency Assistance</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalContinueButton}
                onPress={() => setNoShowAcknowledged(true)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Acknowledge this alert and continue to the tour screen"
              >
                <Text style={styles.modalContinueButtonText}>I understand — continue to tour</Text>
              </TouchableOpacity>

              <View style={styles.modalLogoutDivider} />

              <TouchableOpacity
                style={styles.modalLogoutButton}
                onPress={() => {
                  logger.info('TourHome', 'Logout requested from no-show modal', {
                    tourId: activeTourId || null,
                    bookingRef: maskIdentifier(bookingRef),
                  });
                  onLogout();
                }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Log out"
              >
                <MaterialCommunityIcons name="logout-variant" size={18} color={COLORS.subtleText} />
                <Text style={styles.modalLogoutButtonText}>Log Out</Text>
              </TouchableOpacity>
              </ScrollView>
              </LinearGradient>
            </Animated.View>
          </View>
        </Modal>
      </SafeAreaView>
    </View>
  );
}

