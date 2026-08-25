import { StyleSheet } from "react-native";
import COLORS from './chatTheme';
import { RADIUS, SHADOWS, SPACING, COLORS as THEME } from "../../theme";
export default StyleSheet.create({
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  errorText: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.darkText,
    marginTop: 16
  },
  errorSubtext: {
    fontSize: 14,
    color: COLORS.secondaryText,
    marginTop: 4
  },
  // Empty State
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 32
  },
  emptyIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: SPACING.xl,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.sm
  },
  emptyText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 8
  },
  emptySubtext: {
    fontSize: 15,
    color: COLORS.secondaryText,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24
  },
  emptyTips: {
    flexDirection: 'row',
    gap: SPACING.xl
  },
  emptyTip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.white,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.lg,
    ...SHADOWS.sm
  },
  emptyTipText: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '500'
  },
  // Messages
  messagesScrollContainer: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    flexGrow: 1
  },
  loadOlderButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm
  },
  loadOlderButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 6
  },
  myMessageRow: {
    justifyContent: 'flex-end'
  },
  theirMessageRow: {
    justifyContent: 'flex-start'
  },
  messageBubble: {
    maxWidth: '82%',
    minWidth: 0,
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg
  },
  myMessageBubble: {
    backgroundColor: COLORS.myMessageBackground,
    borderBottomRightRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: `${COLORS.primaryDark}40`
  },
  myMessageBubbleClusterFirst: {
    borderBottomRightRadius: RADIUS.lg
  },
  myMessageBubbleClusterMiddle: {
    borderTopRightRadius: RADIUS.sm,
    borderBottomRightRadius: RADIUS.sm
  },
  myMessageBubbleClusterLast: {
    borderTopRightRadius: RADIUS.sm
  },
  theirMessageBubble: {
    backgroundColor: COLORS.theirMessageBackground,
    borderBottomLeftRadius: RADIUS.sm,
    ...SHADOWS.sm,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  theirMessageBubbleClusterFirst: {
    borderBottomLeftRadius: RADIUS.lg
  },
  theirMessageBubbleClusterMiddle: {
    borderTopLeftRadius: RADIUS.sm,
    borderBottomLeftRadius: RADIUS.sm
  },
  theirMessageBubbleClusterLast: {
    borderTopLeftRadius: RADIUS.sm
  },
  driverMessageBubble: {
    backgroundColor: COLORS.driverMessageBackground,
    borderColor: COLORS.driverMessageBorder,
    borderWidth: 1.5
  },
  imageMessageBubble: {
    padding: 4,
    maxWidth: '78%'
  },
  deletedMessageBubble: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.secondaryText,
    borderStyle: 'dashed'
  },
  deletedMessageText: {
    color: COLORS.secondaryText,
    fontStyle: 'italic',
    fontSize: 14
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginBottom: 4
  },
  replyReferenceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}26`,
    backgroundColor: `${COLORS.primaryBlue}10`,
    marginBottom: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs
  },
  replyReferenceCardSelf: {
    borderColor: `${COLORS.lightBlueAccent}70`,
    backgroundColor: `${COLORS.primaryDark}55`
  },
  replyReferenceAccent: {
    width: 3,
    borderRadius: RADIUS.full,
    alignSelf: 'stretch',
    backgroundColor: COLORS.primaryBlue
  },
  replyReferenceContent: {
    flex: 1,
    minWidth: 0
  },
  replyReferenceSender: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primaryBlue
  },
  replyReferenceSenderSelf: {
    color: COLORS.lightBlueAccent
  },
  replyReferencePreview: {
    marginTop: 2,
    fontSize: 12,
    color: COLORS.secondaryText
  },
  replyReferencePreviewSelf: {
    color: `${COLORS.white}CC`
  },
  senderName: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primaryBlue
  },
  mySenderName: {
    color: COLORS.lightBlueAccent
  },
  driverSenderName: {
    color: COLORS.coralAccent
  },
  driverBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: COLORS.coralMuted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.driverMessageBorder
  },
  driverBadgeText: {
    color: COLORS.coralAccent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
    color: COLORS.darkText
  },
  myMessageText: {
    color: COLORS.white
  },
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 4
  },
  timestamp: {
    fontSize: 11,
    color: COLORS.secondaryText,
    opacity: 0.8
  },
  myTimestamp: {
    color: COLORS.lightBlueAccent,
    opacity: 0.9
  },
  messageStatus: {
    marginLeft: 2
  },
  failedMessageRetryChip: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: THEME.error,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: 5,
    ...SHADOWS.sm
  },
  failedMessageRetryChipDisabled: {
    opacity: 0.75
  },
  failedMessageRetryText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2
  },
  searchFocusedBubble: {
    borderColor: COLORS.coralAccent,
    borderWidth: 2
  },
  replyJumpTargetBubble: {
    borderColor: COLORS.primaryBlue,
    borderWidth: 2
  }
});
