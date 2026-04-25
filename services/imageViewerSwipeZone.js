const SWIPE_ZONE_HEIGHT_RATIO = 0.6;

const toFiniteNumber = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const getSwipeZoneBounds = (
  height,
  swipeZoneHeightRatio = SWIPE_ZONE_HEIGHT_RATIO
) => {
  const normalizedHeight = toFiniteNumber(height);
  if (!normalizedHeight || normalizedHeight <= 0) {
    return { top: 0, bottom: 0 };
  }

  const normalizedRatio = toFiniteNumber(swipeZoneHeightRatio);
  const boundedRatio = normalizedRatio == null
    ? SWIPE_ZONE_HEIGHT_RATIO
    : Math.max(0, Math.min(1, normalizedRatio));
  const marginRatio = (1 - boundedRatio) / 2;

  return {
    top: normalizedHeight * marginRatio,
    bottom: normalizedHeight * (1 - marginRatio),
  };
};

const isWithinVerticalSwipeZone = (
  yPosition,
  { swipeZoneTop, swipeZoneBottom } = {}
) => {
  const normalizedY = toFiniteNumber(yPosition);
  const normalizedTop = toFiniteNumber(swipeZoneTop);
  const normalizedBottom = toFiniteNumber(swipeZoneBottom);

  if (normalizedY == null || normalizedTop == null || normalizedBottom == null) {
    return false;
  }

  return normalizedY >= normalizedTop && normalizedY <= normalizedBottom;
};

module.exports = {
  SWIPE_ZONE_HEIGHT_RATIO,
  getSwipeZoneBounds,
  isWithinVerticalSwipeZone,
};
