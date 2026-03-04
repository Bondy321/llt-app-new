const EDGE_START_WIDTH_PX = 32;
const SWIPE_ACTIVATION_DISTANCE_PX = 18;
const SWIPE_COMMIT_DISTANCE_PX = 72;
const SWIPE_COMMIT_VELOCITY_X = 0.22;
const MAX_VERTICAL_DRIFT_PX = 80;

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const isEligibleEdgeSwipe = (
  gestureState = {},
  options = {}
) => {
  const {
    edgeStartWidthPx = EDGE_START_WIDTH_PX,
    activationDistancePx = SWIPE_ACTIVATION_DISTANCE_PX,
    maxVerticalDriftPx = MAX_VERTICAL_DRIFT_PX,
  } = options;

  const x0 = Number(gestureState.x0);
  const dx = Number(gestureState.dx);
  const dy = Number(gestureState.dy);

  if (![x0, dx, dy].every(isFiniteNumber)) return false;
  if (x0 > edgeStartWidthPx) return false;
  if (dx <= activationDistancePx) return false;
  if (Math.abs(dy) > maxVerticalDriftPx) return false;

  return Math.abs(dx) > Math.abs(dy) * 1.2;
};

const shouldCommitEdgeSwipeHome = (
  gestureState = {},
  options = {}
) => {
  const {
    commitDistancePx = SWIPE_COMMIT_DISTANCE_PX,
    commitVelocityX = SWIPE_COMMIT_VELOCITY_X,
    maxVerticalDriftPx = MAX_VERTICAL_DRIFT_PX,
  } = options;

  const dx = Number(gestureState.dx);
  const dy = Number(gestureState.dy);
  const vx = Number(gestureState.vx);

  if (![dx, dy, vx].every(isFiniteNumber)) return false;
  if (dx < commitDistancePx && vx < commitVelocityX) return false;
  if (Math.abs(dy) > maxVerticalDriftPx) return false;

  return dx > 0;
};

module.exports = {
  EDGE_START_WIDTH_PX,
  SWIPE_ACTIVATION_DISTANCE_PX,
  SWIPE_COMMIT_DISTANCE_PX,
  SWIPE_COMMIT_VELOCITY_X,
  MAX_VERTICAL_DRIFT_PX,
  isEligibleEdgeSwipe,
  shouldCommitEdgeSwipeHome,
};
