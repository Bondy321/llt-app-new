export default function createSafetySupportScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING }) {
  return StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  gradient: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  historyButton: {
    padding: 8,
    backgroundColor: `${COLORS.primary}12`,
    borderRadius: 10,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },

  // Offline/Queue Banners
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.error,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 16,
    gap: 8,
  },
  offlineBannerText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 16,
    gap: 8,
  },
  queueBannerText: {
    flex: 1,
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },
  queueAttentionBanner: {
    backgroundColor: COLORS.error,
  },
  queueRetryButton: {
    minHeight: 32,
    minWidth: 78,
    borderRadius: 16,
    backgroundColor: COLORS.white,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  queueRetryButtonText: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: '800',
  },
  sosDeliveryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: -6,
    marginBottom: 16,
    borderRadius: 12,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  sosDeliveryBannerFailed: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  sosDeliveryBannerSubmitted: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  sosDeliveryText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },

  // SOS Button
  sosCard: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: `${COLORS.sosRed}18`,
    ...SHADOWS.lg,
  },
  sosCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sosCardIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: COLORS.sosRedLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  sosCardHeaderText: {
    flex: 1,
  },
  sosEyebrow: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.6,
    color: COLORS.sosRed,
    textTransform: 'uppercase',
  },
  sosTitle: {
    fontSize: 23,
    fontWeight: '900',
    color: COLORS.text,
    marginTop: 2,
  },
  sosButtonStage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosGlow: {
    position: 'absolute',
    backgroundColor: COLORS.sosRed,
  },
  sosButton: {
    ...SHADOWS.xl,
  },
  sosButtonActive: {
    ...SHADOWS.lg,
  },
  sosGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.xl,
  },
  sosContent: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  sosText: {
    color: COLORS.white,
    fontSize: 56,
    fontWeight: '900',
    letterSpacing: 3,
    marginTop: 8,
    lineHeight: 60,
    textAlign: 'center',
  },
  sosCountdown: {
    color: COLORS.white,
    fontSize: 62,
    fontWeight: '900',
    lineHeight: 68,
    textAlign: 'center',
  },
  sosCancelText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  sosHelpPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.sosRedLight,
    borderRadius: RADIUS.md,
    padding: 12,
    marginTop: 12,
  },
  sosHelpIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  sosHelpText: {
    flex: 1,
    color: COLORS.sosRedDark,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  sosActiveText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },

  // Cards
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    ...SHADOWS.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  cardHeaderText: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.text,
  },
  cardSubtitle: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // Contact Buttons
  contactsGrid: {
    gap: 10,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    gap: 12,
  },
  contactIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contactTextContainer: {
    flex: 1,
  },
  contactLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  contactSublabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },

  // Live Location Card
  liveLocationCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    ...SHADOWS.md,
  },
  liveLocationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveLocationIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  liveLocationTextContainer: {
    flex: 1,
  },
  liveLocationTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  liveLocationSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  liveLocationStatus: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 16,
  },
  liveLocationStatusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },

  // Location Toggle
  locationToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    gap: 8,
  },
  locationToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },

  // Issue Presets
  issuePresets: {
    gap: 8,
  },
  issuePreset: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  issuePresetSelected: {
    borderColor: COLORS.success,
    backgroundColor: `${COLORS.success}08`,
  },
  issueIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  issueTextContainer: {
    flex: 1,
  },
  issueTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  issueDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // Trusted Contacts
  addContactButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContacts: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  emptyContactsText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 20,
  },
  trustedContactsList: {
    gap: 8,
  },
  trustedContactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: COLORS.background,
    borderRadius: 10,
  },
  trustedContactIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${COLORS.primary}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  trustedContactInfo: {
    flex: 1,
  },
  trustedContactName: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  trustedContactPhone: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  trustedContactAction: {
    padding: 8,
    marginLeft: 4,
  },

  // Safety Tips
  tipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tipsContent: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 12,
  },
  safetyTip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  safetyTipIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  safetyTipContent: {
    flex: 1,
  },
  safetyTipTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  safetyTipDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 18,
  },

  // Severity Selector
  severityContainer: {
    marginBottom: 16,
  },
  severityLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 10,
  },
  severityOptions: {
    flexDirection: 'row',
    gap: 8,
  },
  severityOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    gap: 4,
  },
  severityText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },

  // Tour Info
  tourInfoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  tourInfoText: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '500',
  },

  bottomSpacer: {
    height: 20,
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    maxHeight: '90%',
  },
  historyModalContent: {
    minHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  modalBody: {
    padding: 20,
  },
  modalDescription: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 20,
    lineHeight: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
    marginTop: 8,
  },
  textInput: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: COLORS.text,
    minHeight: 100,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  textInputSingle: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  modalActions: {
    flexDirection: 'row',
    padding: 20,
    paddingTop: 0,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  submitButton: {
    flex: 2,
    flexDirection: 'row',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },

  // History
  historyScroll: {
    padding: 20,
  },
  historyLoading: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  historyLoadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  historyEmpty: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  historyEmptyText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 12,
  },
  historyEmptySubtext: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    marginBottom: 10,
  },
  historyIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  historyContent: {
    flex: 1,
  },
  historyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  historyDate: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  historyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  historyBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
}
