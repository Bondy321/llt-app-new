const { shouldPrioritizeEdgeSwipeOverMessageSwipe } = require('./swipeHomeNavigation');

const SWIPE_REPLY_START_DISTANCE_PX = 6;
const SWIPE_REPLY_HORIZONTAL_INTENT_RATIO = 1.2;
const SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX = 72;
const SWIPE_REPLY_SNAP_ACTIVATION_SCREEN_RATIO = 0.5;
const SWIPE_REPLY_MIN_SNAP_ACTIVATION_DISTANCE_PX = 160;
const SWIPE_REPLY_MAX_SNAP_ACTIVATION_DISTANCE_PX = 240;
const SWIPE_REPLY_DEFAULT_SNAP_ACTIVATION_DISTANCE_PX = 184;

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getSwipeReplySnapActivationDistance = (screenWidth) => {
  const width = toFiniteNumber(screenWidth);
  if (!width || width <= 0) {
    return SWIPE_REPLY_DEFAULT_SNAP_ACTIVATION_DISTANCE_PX;
  }

  return Math.round(clamp(
    width * SWIPE_REPLY_SNAP_ACTIVATION_SCREEN_RATIO,
    SWIPE_REPLY_MIN_SNAP_ACTIVATION_DISTANCE_PX,
    SWIPE_REPLY_MAX_SNAP_ACTIVATION_DISTANCE_PX
  ));
};

const getSwipeReplyDragState = (
  gestureState = {},
  options = {}
) => {
  const {
    screenWidth,
    peakDragX = 0,
  } = options;

  const snapActivationDistance = getSwipeReplySnapActivationDistance(screenWidth);
  const dx = toFiniteNumber(gestureState.dx) ?? 0;
  const dragX = clamp(dx, 0, snapActivationDistance);
  const nextPeakDragX = Math.max(toFiniteNumber(peakDragX) ?? 0, dragX);
  const progress = clamp(dragX / snapActivationDistance, 0, 1);

  return {
    dragX,
    peakDragX: nextPeakDragX,
    progress,
    snapActivationDistance,
    shouldSnapActivate: dragX >= snapActivationDistance,
    isReleaseReady: nextPeakDragX >= SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX,
  };
};

const shouldStartSwipeReplyGesture = (
  gestureState = {},
  options = {}
) => {
  const {
    disabled = false,
    allowNearScreenEdge = false,
    startDistancePx = SWIPE_REPLY_START_DISTANCE_PX,
    horizontalIntentRatio = SWIPE_REPLY_HORIZONTAL_INTENT_RATIO,
  } = options;

  if (disabled) return false;
  if (!allowNearScreenEdge && shouldPrioritizeEdgeSwipeOverMessageSwipe(gestureState)) {
    return false;
  }

  const dx = toFiniteNumber(gestureState.dx);
  const dy = toFiniteNumber(gestureState.dy);

  if (dx === null || dy === null) return false;
  if (dx <= startDistancePx) return false;

  return Math.abs(dx) > Math.abs(dy) * horizontalIntentRatio;
};

const shouldTriggerSwipeReplyOnRelease = (
  gestureState = {},
  options = {}
) => {
  const {
    peakDragX = 0,
    releaseActivationDistancePx = SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX,
  } = options;

  const dx = toFiniteNumber(gestureState.dx) ?? 0;
  const effectiveDragX = Math.max(0, dx, toFiniteNumber(peakDragX) ?? 0);

  return effectiveDragX >= releaseActivationDistancePx;
};

module.exports = {
  SWIPE_REPLY_START_DISTANCE_PX,
  SWIPE_REPLY_HORIZONTAL_INTENT_RATIO,
  SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX,
  SWIPE_REPLY_SNAP_ACTIVATION_SCREEN_RATIO,
  SWIPE_REPLY_MIN_SNAP_ACTIVATION_DISTANCE_PX,
  SWIPE_REPLY_MAX_SNAP_ACTIVATION_DISTANCE_PX,
  SWIPE_REPLY_DEFAULT_SNAP_ACTIVATION_DISTANCE_PX,
  getSwipeReplySnapActivationDistance,
  getSwipeReplyDragState,
  shouldStartSwipeReplyGesture,
  shouldTriggerSwipeReplyOnRelease,
};
