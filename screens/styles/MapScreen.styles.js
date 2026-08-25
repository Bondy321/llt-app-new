export default function createMapScreenStyles({ StyleSheet, COLORS, Platform }) {
  return StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.primaryBlue,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.primaryBlue,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
    marginBottom: 4,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    gap: 4,
  },
  connectionText: {
    fontSize: 11,
    fontWeight: '600',
  },

  container: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  mapContainer: {
    flex: 1,
  },
  map: {
    width: '100%',
    height: '100%',
  },

  // Loading State
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  loadingGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContent: {
    alignItems: 'center',
    padding: 40,
  },
  loadingIconContainer: {
    marginBottom: 24,
  },
  loadingIconOuter: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: `${COLORS.primaryBlue}15`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 8,
  },
  loadingSubtitle: {
    fontSize: 15,
    color: COLORS.secondaryText,
    marginBottom: 20,
  },
  loadingDots: {
    marginTop: 10,
  },

  // FAB Buttons
  fabContainer: {
    position: 'absolute',
    right: 16,
    top: 16,
    gap: 10,
  },
  fab: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  // Custom Marker
  customMarkerContainer: {
    alignItems: 'center',
  },
  customMarkerOuter: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: COLORS.white,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
  },
  markerLive: {
    borderColor: COLORS.success,
    borderWidth: 3,
  },
  customMarkerInner: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  markerShadow: {
    width: 20,
    height: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.2)',
    marginTop: 2,
  },

  // Info Card
  infoCardContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 20 : 16,
  },
  infoCard: {
    backgroundColor: COLORS.white,
    borderRadius: 20,
    padding: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  // Card Header
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  updateTime: {
    fontSize: 13,
    color: COLORS.secondaryText,
    fontWeight: '500',
  },

  // Driver Info
  driverInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  driverAvatar: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  driverDetails: {
    flex: 1,
  },
  driverTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  driverSubtitle: {
    fontSize: 13,
    color: COLORS.secondaryText,
    marginTop: 2,
  },
  driverName: {
    fontSize: 13,
    color: COLORS.primaryBlue,
    fontWeight: '600',
    marginTop: 4,
  },

  // Metrics
  metricsContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}10`,
    padding: 14,
    borderRadius: 14,
    gap: 10,
  },
  metricCardAccent: {
    backgroundColor: COLORS.coralAccent,
  },
  metricTextContainer: {
    flex: 1,
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  metricLabel: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '500',
    marginTop: 1,
  },

  // Stale Warning
  staleWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: `${COLORS.warning}15`,
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    gap: 10,
  },
  staleText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.warning,
    fontWeight: '600',
    lineHeight: 18,
  },

  // Action Buttons
  actionButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryBlue,
    paddingVertical: 14,
    borderRadius: 14,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  secondaryButton: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: `${COLORS.primaryBlue}12`,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
  },

  // Error State
  errorContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
  },
  errorIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: `${COLORS.errorRed}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  errorTextContainer: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.errorRed,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 14,
    color: COLORS.secondaryText,
    lineHeight: 20,
  },

  // Waiting State
  waitingContent: {
    alignItems: 'center',
    padding: 8,
  },
  waitingIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${COLORS.secondaryText}10`,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  waitingTextContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  waitingTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 6,
  },
  waitingMessage: {
    fontSize: 14,
    color: COLORS.secondaryText,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 10,
  },
  pickupDirectionsButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: 12,
    gap: 8,
  },
  pickupDirectionsButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: `${COLORS.primaryBlue}12`,
    borderRadius: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
  },
  contactButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.primaryBlue,
  },
});
}
