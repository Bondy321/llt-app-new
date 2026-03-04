const test = require('node:test');
const assert = require('node:assert');

const {
  EDGE_START_WIDTH_PX,
  SWIPE_ACTIVATION_DISTANCE_PX,
  SWIPE_COMMIT_DISTANCE_PX,
  isEligibleEdgeSwipe,
  shouldCommitEdgeSwipeHome,
} = require('../services/swipeHomeNavigation');

test('edge swipe is eligible when it starts at far left and moves right clearly', () => {
  const eligible = isEligibleEdgeSwipe({
    x0: EDGE_START_WIDTH_PX - 2,
    dx: SWIPE_ACTIVATION_DISTANCE_PX + 4,
    dy: 6,
  });

  assert.equal(eligible, true);
});

test('edge swipe is not eligible when gesture starts away from left edge', () => {
  const eligible = isEligibleEdgeSwipe({
    x0: EDGE_START_WIDTH_PX + 24,
    dx: SWIPE_ACTIVATION_DISTANCE_PX + 20,
    dy: 2,
  });

  assert.equal(eligible, false);
});

test('edge swipe commit requires enough horizontal distance or velocity', () => {
  const committedWithDistance = shouldCommitEdgeSwipeHome({
    dx: SWIPE_COMMIT_DISTANCE_PX + 5,
    dy: 10,
    vx: 0.05,
  });

  const committedWithVelocity = shouldCommitEdgeSwipeHome({
    dx: 10,
    dy: 5,
    vx: 0.3,
  });

  const rejected = shouldCommitEdgeSwipeHome({
    dx: 20,
    dy: 10,
    vx: 0.1,
  });

  assert.equal(committedWithDistance, true);
  assert.equal(committedWithVelocity, true);
  assert.equal(rejected, false);
});
