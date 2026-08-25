import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { SPACING } from '../../theme';
import { getResponsiveLayout, responsiveFontSize, responsiveLineHeight } from '../../utils/responsiveLayout';

export default function useTourHomeResponsiveStyles() {
  const { width, height, fontScale } = useWindowDimensions();
  const screenLayout = useMemo(
    () => getResponsiveLayout({ width, height, fontScale }),
    [fontScale, height, width]
  );
  const responsiveStyles = useMemo(() => {
    const greetingSize = responsiveFontSize(20, screenLayout, {
      min: 16,
      max: 20,
      compactAdjustment: -1,
      largeTextAdjustment: -3,
      veryLargeTextAdjustment: -4,
    });
    const statusTitleSize = responsiveFontSize(18, screenLayout, {
      min: 15,
      max: 18,
      compactAdjustment: -1,
      largeTextAdjustment: -2,
      veryLargeTextAdjustment: -3,
    });
    const titleSize = responsiveFontSize(20, screenLayout, {
      min: 16,
      max: 20,
      compactAdjustment: -1,
      largeTextAdjustment: -2,
      veryLargeTextAdjustment: -3,
    });
    const isTightHeader = screenLayout.isCompact || screenLayout.isLargeText;
    const compactActions = screenLayout.isTiny || screenLayout.isVeryLargeText;

    return {
      compactActions,
      container: {
        paddingHorizontal: screenLayout.horizontalPadding,
        paddingTop: screenLayout.isLargeText ? SPACING.sm : SPACING.md,
      },
      header: {
        paddingHorizontal: isTightHeader ? SPACING.sm : SPACING.md,
        paddingVertical: isTightHeader ? SPACING.sm : SPACING.md,
      },
      headerBrandMark: isTightHeader
        ? { width: 48, height: 48, borderRadius: 16 }
        : null,
      logoImage: isTightHeader
        ? { width: 36, height: 36, borderRadius: 10 }
        : null,
      headerTextContainer: {
        marginLeft: isTightHeader ? SPACING.sm : SPACING.md,
        marginRight: isTightHeader ? SPACING.sm : SPACING.md,
      },
      greetingIconBadge: isTightHeader
        ? { width: 26, height: 26, borderRadius: 13 }
        : null,
      greetingText: {
        fontSize: greetingSize,
        lineHeight: responsiveLineHeight(greetingSize, 1.16),
      },
      headerMenuButton: isTightHeader
        ? { width: 40, height: 40, borderRadius: 14 }
        : null,
      statusCardGradient: screenLayout.isLargeText
        ? { padding: SPACING.md }
        : null,
      statusTitle: {
        fontSize: statusTitleSize,
        lineHeight: responsiveLineHeight(statusTitleSize, 1.16),
      },
      statusMessage: {
        fontSize: responsiveFontSize(14, screenLayout, {
          min: 12,
          max: 14,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      quickActionsContainer: {
        padding: screenLayout.isLargeText ? SPACING.md : SPACING.lg,
      },
      quickActionsRow: compactActions
        ? { flexWrap: 'wrap', rowGap: SPACING.md }
        : null,
      quickActionsTitle: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 11,
          max: 13,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      quickActionsSubtitle: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 12,
          max: 13,
          compactAdjustment: 0,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -1,
        }),
      },
      boardingPassTour: {
        fontSize: titleSize,
        lineHeight: responsiveLineHeight(titleSize, 1.15),
      },
      pickupLocationText: {
        fontSize: responsiveFontSize(14, screenLayout, {
          min: 12,
          max: 14,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
    };
  }, [screenLayout]);
  return { responsiveStyles, screenLayout };
}
