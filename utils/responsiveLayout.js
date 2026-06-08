const DEFAULT_WIDTH = 390;
const DEFAULT_HEIGHT = 844;

export const FONT_SCALE_LIMITS = {
  display: 1.04,
  heading: 1.08,
  title: 1.12,
  body: 1.16,
  form: 1.12,
  caption: 1.14,
};

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const getResponsiveLayout = ({ width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, fontScale = 1 } = {}) => {
  const shortestSide = Math.min(width || DEFAULT_WIDTH, height || DEFAULT_HEIGHT);
  const longestSide = Math.max(width || DEFAULT_WIDTH, height || DEFAULT_HEIGHT);
  const isTiny = shortestSide < 360;
  const isCompact = shortestSide < 390;
  const isLargePhone = shortestSide >= 430;
  const isTablet = shortestSide >= 700;
  const isLargeText = fontScale >= 1.18;
  const isVeryLargeText = fontScale >= 1.35;

  return {
    width,
    height,
    fontScale,
    shortestSide,
    longestSide,
    isTiny,
    isCompact,
    isLargePhone,
    isTablet,
    isLargeText,
    isVeryLargeText,
    horizontalPadding: isTiny ? 14 : isCompact ? 16 : isLargePhone ? 22 : 20,
    cardPadding: isTiny || isLargeText ? 18 : isLargePhone ? 24 : 22,
    sectionGap: isTiny || isLargeText ? 12 : 16,
  };
};

export const responsiveFontSize = (
  baseSize,
  layout,
  {
    min = baseSize - 4,
    max = baseSize + 2,
    compactAdjustment = -1,
    largeAdjustment = 0,
    largeTextAdjustment = -3,
    veryLargeTextAdjustment = -5,
  } = {}
) => {
  let size = baseSize;

  if (layout?.isTiny) {
    size += compactAdjustment - 1;
  } else if (layout?.isCompact) {
    size += compactAdjustment;
  } else if (layout?.isLargePhone && !layout?.isLargeText) {
    size += largeAdjustment;
  }

  if (layout?.isVeryLargeText) {
    size += veryLargeTextAdjustment;
  } else if (layout?.isLargeText) {
    size += largeTextAdjustment;
  }

  return Math.round(clamp(size, min, max));
};

export const responsiveLineHeight = (fontSize, multiplier = 1.22) => Math.ceil(fontSize * multiplier);
