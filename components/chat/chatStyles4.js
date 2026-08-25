import { StyleSheet } from "react-native";
import COLORS from './chatTheme';
import { RADIUS, SHADOWS, SPACING, COLORS as THEME } from "../../theme";
export default StyleSheet.create({
  swipeReplyFeedbackTextReady: {
    color: THEME.success
  },
  catchUpCard: {
    position: 'absolute',
    bottom: 182,
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
  catchUpCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: 4
  },
  catchUpCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.darkText
  },
  catchUpCardBody: {
    fontSize: 12,
    color: COLORS.secondaryText,
    marginBottom: SPACING.xs
  },
  catchUpCardBodyStrong: {
    fontWeight: '700',
    color: COLORS.darkText
  },
  catchUpActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.xs
  },
  catchUpButtonSecondary: {
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    backgroundColor: `${COLORS.primaryBlue}08`
  },
  catchUpButtonSecondaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue
  },
  catchUpButtonPrimary: {
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    backgroundColor: COLORS.primaryBlue
  },
  catchUpButtonPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.white
  },
  jumpToUnreadFab: {
    position: 'absolute',
    bottom: 132,
    right: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.md
  },
  jumpToUnreadFabText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '700'
  },
  // Input Area
  inputDock: {
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    ...SHADOWS.md
  },
  inputArea: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl
  },
  replyComposerCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs
  },
  replyComposerAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryBlue
  },
  replyComposerBody: {
    flex: 1,
    minWidth: 0
  },
  replyComposerTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue
  },
  replyComposerPreview: {
    marginTop: 1,
    fontSize: 12,
    color: COLORS.secondaryText
  },
  replyComposerClose: {
    width: 30,
    height: 30,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  draftBadge: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 10
  },
  draftBadgeText: {
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: '600'
  },
  attachButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.primaryBlue}08`
  },
  composerInputRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.xs
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 22,
    paddingHorizontal: SPACING.lg,
    paddingVertical: 10,
    paddingTop: 12,
    fontSize: 16,
    color: COLORS.darkText,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  sendButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendButtonDisabled: {
    opacity: 0.5
  },
  // Attachment Menu
  attachmentMenu: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: COLORS.white,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.xl,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl
  },
  attachmentOption: {
    alignItems: 'center',
    gap: 8
  },
  attachmentIconBg: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border
  },
  attachmentLabel: {
    fontSize: 13,
    color: COLORS.darkText,
    fontWeight: '500'
  },
  // Modals
  reactionModalOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'center',
    alignItems: 'center'
  },
  reactionPicker: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    padding: SPACING.sm,
    ...SHADOWS.lg,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  reactionOption: {
    padding: 10
  },
  reactionOptionEmoji: {
    fontSize: 28
  },
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'flex-end'
  },
  actionMenuSheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    ...SHADOWS.xl,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  actionMenuHandle: {
    width: 44,
    height: 4,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.border,
    alignSelf: 'center',
    marginBottom: SPACING.md
  },
  actionMessagePreviewCard: {
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSecondary,
    marginBottom: SPACING.sm
  },
  actionMessagePreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
    gap: SPACING.sm
  },
  actionMessageSender: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.darkText,
    flex: 1
  },
  actionMessageTime: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '500'
  },
  actionMessagePreviewText: {
    fontSize: 14,
    lineHeight: 19,
    color: COLORS.darkText,
    fontWeight: '500'
  },
  actionQuickReactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    gap: SPACING.xs
  },
  actionQuickReaction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionQuickReactionEmoji: {
    fontSize: 22
  },
  actionMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 10,
    gap: 14,
    borderRadius: RADIUS.md
  },
  actionMenuItemDanger: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginTop: 4,
    paddingTop: 18
  },
  actionMenuText: {
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: '500'
  },
  // Image Viewer
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  imageViewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 10
  },
  fullScreenImage: {}
});
