import { StyleSheet } from "react-native";
import { COLORS } from "./chatShared";
import { RADIUS, SHADOWS, SPACING, COLORS as THEME } from "../../theme";
export default StyleSheet.create({
  searchHighlight: {
    backgroundColor: `${COLORS.coralAccent}40`,
    color: COLORS.darkText,
    fontWeight: '700'
  },
  searchHighlightSelf: {
    backgroundColor: `${COLORS.white}50`,
    color: COLORS.white
  },
  // Links
  linkInMessage: {
    color: COLORS.linkColor,
    textDecorationLine: 'underline'
  },
  linkInMessageSelf: {
    color: COLORS.lightBlueAccent
  },
  linkPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}10`,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs + 2,
    borderRadius: RADIUS.md,
    marginTop: SPACING.sm,
    gap: 6,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}20`
  },
  linkText: {
    flex: 1,
    color: COLORS.linkColor,
    fontSize: 13
  },
  // Image Message
  imageMessageContainer: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    marginVertical: 4
  },
  messageImage: {
    borderRadius: RADIUS.md
  },
  emptyRetryButton: {
    marginTop: SPACING.md,
    minHeight: 44,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primaryBlue,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs
  },
  emptyRetryButtonText: {
    color: COLORS.white,
    fontWeight: '700'
  },
  imageLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.md
  },
  imageError: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.md
  },
  imageErrorText: {
    color: COLORS.secondaryText,
    marginTop: 8,
    fontSize: 13
  },
  // Reactions
  reactionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 4
  },
  reactionBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.reactionBackground,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}12`
  },
  reactionBubbleActive: {
    backgroundColor: `${COLORS.primaryBlue}20`,
    borderColor: COLORS.primaryBlue
  },
  reactionEmoji: {
    fontSize: 14
  },
  reactionCount: {
    fontSize: 12,
    color: COLORS.darkText,
    marginLeft: 4,
    fontWeight: '600'
  },
  reactionCountActive: {
    color: COLORS.primaryBlue
  },
  // Date Separator
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.lg,
    paddingHorizontal: SPACING.lg
  },
  dateSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border
  },
  dateSeparatorBadge: {
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: RADIUS.full,
    marginHorizontal: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  dateSeparatorText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '600'
  },
  // Unread Separator

  unreadSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.md,
    paddingHorizontal: SPACING.lg
  },
  unreadSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.coralAccent,
    opacity: 0.5
  },
  unreadSeparatorBadge: {
    backgroundColor: COLORS.coralMuted,
    borderWidth: 1,
    borderColor: COLORS.driverMessageBorder,
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: RADIUS.full,
    marginHorizontal: SPACING.sm
  },
  unreadSeparatorText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9A3412'
  },
  // Typing Indicator
  typingContainer: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.lg,
    alignSelf: 'flex-start',
    ...SHADOWS.sm,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  typingDots: {
    flexDirection: 'row',
    marginRight: 8,
    gap: 3
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.typingIndicator
  },
  typingText: {
    fontSize: 13,
    color: COLORS.typingIndicator,
    fontStyle: 'italic'
  },
  // New Messages Banner
  floatingJumpPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.newMessageBanner,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
    ...SHADOWS.md,
    gap: 6,
    borderWidth: 1,
    borderColor: `${COLORS.coralAccent}70`
  },
  floatingJumpPillText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700'
  },
  floatingJumpCard: {
    position: 'absolute',
    right: SPACING.lg,
    left: SPACING.lg,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}20`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.md
  },
  floatingJumpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs
  },
  floatingJumpTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.darkText
  },
  floatingJumpBody: {
    marginTop: 3,
    fontSize: 12,
    color: COLORS.secondaryText
  },
  floatingJumpActions: {
    marginTop: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  floatingJumpActionText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue
  },
  floatingJumpLatest: {
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.primaryBlue}10`,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5
  },
  floatingJumpLatestText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue
  },
  newMessagesBanner: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.newMessageBanner,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
    ...SHADOWS.md,
    gap: 6,
    borderWidth: 1,
    borderColor: `${COLORS.coralAccent}70`
  },
  newMessagesBannerText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600'
  },
  reactionFeedbackBanner: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: THEME.error,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm
  },
  reactionFeedbackText: {
    flex: 1,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '600'
  },
  replyJumpFeedbackBanner: {
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm
  },
  replyJumpFeedbackText: {
    flex: 1,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '600'
  },
  swipeReplyHint: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: THEME.primaryMuted,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs
  },
  swipeReplyHintText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.primaryBlue,
    fontWeight: '600'
  },
  swipeReplyRowContainer: {
    position: 'relative'
  },
  swipeReplyFeedback: {
    position: 'absolute',
    left: SPACING.lg + 4,
    top: '50%',
    marginTop: -12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: THEME.primaryMuted,
    borderColor: `${COLORS.primaryBlue}20`,
    borderWidth: 1,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5
  },
  swipeReplyFeedbackReady: {
    backgroundColor: `${THEME.success}20`,
    borderColor: `${THEME.success}60`
  },
  swipeReplyFeedbackText: {
    fontSize: 11,
    color: COLORS.primaryBlue,
    fontWeight: '700'
  }
});
