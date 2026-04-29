const DEFAULT_HORIZONTAL_INTENT_THRESHOLD = 8;
const DEFAULT_HORIZONTAL_OVER_VERTICAL_RATIO = 1.15;

const isHorizontalSwipeIntent = (
  gestureState,
  {
    horizontalIntentThreshold = DEFAULT_HORIZONTAL_INTENT_THRESHOLD,
    horizontalOverVerticalRatio = DEFAULT_HORIZONTAL_OVER_VERTICAL_RATIO,
  } = {}
) => {
  if (!gestureState || typeof gestureState !== 'object') return false;

  const dx = Number(gestureState.dx);
  const dy = Number(gestureState.dy);

  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

  return (
    Math.abs(dx) > horizontalIntentThreshold
    && Math.abs(dx) > (Math.abs(dy) * horizontalOverVerticalRatio)
  );
};

module.exports = {
  DEFAULT_HORIZONTAL_INTENT_THRESHOLD,
  DEFAULT_HORIZONTAL_OVER_VERTICAL_RATIO,
  isHorizontalSwipeIntent,
};
