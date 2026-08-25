import { StyleSheet } from "react-native";
import { COLORS } from "./chatShared";
import { RADIUS, SHADOWS, SPACING, COLORS as THEME } from "../../theme";
export default StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.chatScreenBackground
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: Platform.OS === 'ios' ? SPACING.md : SPACING.lg,
    borderBottomLeftRadius: RADIUS.xl,
    borderBottomRightRadius: RADIUS.xl,
    ...SHADOWS.md
  },
  headerButton: {
    width: 80,
    height: 44,
    alignItems: 'flex-start',
    justifyContent: 'center'
  },
  headerTitleContainer: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    paddingHorizontal: SPACING.xs,
    gap: 4
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.white,
    letterSpacing: 0
  },
  headerRight: {
    width: 80,
    flexShrink: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 6
  },
  syncNowBtn: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)'
  },
  onlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 7,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)'
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6
  },
  onlineCount: {
    color: COLORS.white,
    fontSize: 11,
    fontWeight: '700'
  },
  liveErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginHorizontal: SPACING.md,
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.sync.critical.border,
    backgroundColor: THEME.sync.critical.background,
    borderRadius: RADIUS.md
  },
  liveErrorBannerText: {
    flex: 1,
    color: THEME.sync.critical.foreground,
    fontSize: 12,
    fontWeight: '600'
  },
  liveErrorBannerAction: {
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: '800'
  },
  feedbackHost: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xs,
    gap: SPACING.xs
  },
  feedbackPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    backgroundColor: THEME.primaryMuted,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm
  },
  feedbackPillError: {
    borderColor: THEME.sync.critical.border,
    backgroundColor: THEME.sync.critical.background
  },
  feedbackPillSuccess: {
    borderColor: THEME.sync.success.border,
    backgroundColor: THEME.sync.success.background
  },
  feedbackPillText: {
    flex: 1,
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: '700'
  },
  feedbackPillTextError: {
    color: THEME.sync.critical.foreground
  },
  feedbackPillTextSuccess: {
    color: THEME.sync.success.foreground
  },
  feedbackPillAction: {
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  feedbackPillActionText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue
  },
  keyboardAvoidingContainer: {
    flex: 1
  },
  searchPanel: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.white
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: COLORS.appBackground
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.darkText,
    paddingVertical: 2
  },
  searchMetaRow: {
    marginTop: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  searchMetaText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '600'
  },
  searchNavButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs
  },
  searchNavBtn: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${COLORS.primaryBlue}15`
  },
  searchNavBtnDisabled: {
    opacity: 0.45
  },
  searchFiltersRow: {
    marginTop: SPACING.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs
  },
  searchFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    backgroundColor: `${COLORS.primaryBlue}10`
  },
  searchFilterChipActive: {
    backgroundColor: COLORS.primaryBlue,
    borderColor: COLORS.primaryBlue
  },
  searchFilterLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue
  },
  searchFilterLabelActive: {
    color: COLORS.white
  },
  searchPreviewList: {
    marginTop: SPACING.sm,
    gap: SPACING.xs
  },
  searchPreviewCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.appBackground,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs
  },
  searchPreviewCardActive: {
    borderColor: COLORS.primaryBlue,
    backgroundColor: `${COLORS.primaryBlue}10`
  },
  searchPreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs / 2
  },
  searchPreviewSenderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexShrink: 1
  },
  searchPreviewSender: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.darkText
  },
  searchPreviewTime: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.secondaryText
  },
  searchPreviewDriverBadge: {
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.coralAccent}26`,
    paddingHorizontal: SPACING.xs + 2,
    paddingVertical: SPACING.xs / 2
  },
  searchPreviewDriverBadgeText: {
    fontSize: 9,
    letterSpacing: 0.3,
    color: COLORS.coralAccent,
    fontWeight: '800'
  },
  searchPreviewText: {
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.secondaryText
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xxl
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: COLORS.secondaryText
  },
  skeletonContainer: {
    flex: 1,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xl,
    backgroundColor: COLORS.chatScreenBackground
  },
  skeletonRow: {
    flexDirection: 'row',
    marginBottom: SPACING.md
  },
  skeletonRowOther: {
    justifyContent: 'flex-start'
  },
  skeletonRowSelf: {
    justifyContent: 'flex-end'
  },
  skeletonBubble: {
    width: '52%',
    height: 54,
    borderRadius: RADIUS.lg,
    backgroundColor: '#E2E8F0',
    opacity: 0.75
  },
  skeletonBubbleWide: {
    width: '68%'
  }
});
