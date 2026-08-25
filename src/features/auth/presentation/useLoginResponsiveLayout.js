import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  getResponsiveLayout,
  responsiveFontSize,
  responsiveLineHeight,
} from '../../../../utils/responsiveLayout';
import { SPACING } from './loginPresentationTheme';

const LOGIN_LOGO_ASPECT_RATIO = 355 / 886;
const LOGIN_LOGO_SCALE = 0.67;

export default function useLoginResponsiveLayout() {
  const { width, height, fontScale } = useWindowDimensions();
  const screenLayout = useMemo(
    () => getResponsiveLayout({ width, height, fontScale }),
    [fontScale, height, width]
  );
  const baseLogoWidth = Math.min(
    Math.max(width - screenLayout.horizontalPadding * 2, 180),
    screenLayout.isLargeText || screenLayout.isCompact ? 230 : 260
  );
  const logoWidth = Math.round(baseLogoWidth * LOGIN_LOGO_SCALE);
  const logoHeight = logoWidth * LOGIN_LOGO_ASPECT_RATIO;
  const responsiveStyles = useMemo(() => {
    const appTitleSize = responsiveFontSize(32, screenLayout, {
      min: 24,
      max: 32,
      compactAdjustment: -2,
      largeTextAdjustment: -5,
      veryLargeTextAdjustment: -7,
    });
    const subtitleSize = responsiveFontSize(14, screenLayout, {
      min: 12,
      max: 14,
      compactAdjustment: -1,
      largeTextAdjustment: -1,
      veryLargeTextAdjustment: -2,
    });
    const welcomeSize = responsiveFontSize(24, screenLayout, {
      min: 20,
      max: 24,
      compactAdjustment: -1,
      largeTextAdjustment: -3,
      veryLargeTextAdjustment: -4,
    });

    return {
      scrollContainer: {
        paddingHorizontal: screenLayout.horizontalPadding,
        paddingTop: screenLayout.isLargeText ? SPACING.lg : SPACING.xxl,
      },
      logoSection: {
        marginBottom: screenLayout.isLargeText ? SPACING.sm : SPACING.md,
      },
      formCard: {
        padding: screenLayout.cardPadding,
      },
      appTitle: {
        fontSize: appTitleSize,
        lineHeight: responsiveLineHeight(appTitleSize, 1.16),
      },
      appSubtitle: {
        fontSize: subtitleSize,
        lineHeight: responsiveLineHeight(subtitleSize, 1.22),
      },
      welcomeText: {
        fontSize: welcomeSize,
        lineHeight: responsiveLineHeight(welcomeSize, 1.14),
      },
      welcomeSubtext: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 12,
          max: 13,
          compactAdjustment: 0,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -1,
        }),
      },
      hintsRow: screenLayout.isVeryLargeText || screenLayout.isTiny
        ? { flexDirection: 'column' }
        : null,
      hintChip: screenLayout.isLargeText
        ? { padding: SPACING.sm }
        : null,
      input: {
        fontSize: responsiveFontSize(16, screenLayout, {
          min: 14,
          max: 16,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      buttonText: {
        fontSize: responsiveFontSize(17, screenLayout, {
          min: 15,
          max: 17,
          compactAdjustment: -1,
          largeTextAdjustment: -2,
          veryLargeTextAdjustment: -2,
        }),
      },
    };
  }, [screenLayout]);
  return { height, logoHeight, logoWidth, responsiveStyles, screenLayout };
}
