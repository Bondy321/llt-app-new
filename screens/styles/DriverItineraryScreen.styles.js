export default function createDriverItineraryScreenStyles({ StyleSheet, COLORS, Platform }) {
  return StyleSheet.create({
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
  headerButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  headerIconContainer: { padding: 8, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 12 },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.2)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginTop: 4 },
  offlineText: { color: COLORS.white, fontSize: 10, fontWeight: '600', marginLeft: 4 },

  scrollContainer: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },

  // Error Banner
  errorBanner: { backgroundColor: COLORS.danger, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16, gap: 10 },
  errorMessageRow: { flexDirection: 'row', alignItems: 'center' },
  errorText: { color: COLORS.white, fontSize: 13, fontWeight: '600', marginLeft: 8, flex: 1 },
  retryButton: { alignItems: 'center', alignSelf: 'flex-end', backgroundColor: COLORS.white, borderRadius: 10, flexDirection: 'row', gap: 6, minHeight: 44, paddingHorizontal: 14 },
  retryButtonText: { color: COLORS.amber, fontSize: 13, fontWeight: '800' },

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
}
