const test = require('node:test');
const assert = require('node:assert');

const {
  SWIPE_ZONE_HEIGHT_RATIO,
  getSwipeZoneBounds,
  isWithinVerticalSwipeZone,
} = require('../services/imageViewerSwipeZone');

test('getSwipeZoneBounds uses centered 0.6 band for portrait height', () => {
  const { top, bottom } = getSwipeZoneBounds(1000);

  assert.equal(top, 200);
  assert.equal(bottom, 800);
  assert.equal(bottom - top, 1000 * SWIPE_ZONE_HEIGHT_RATIO);
});

test('getSwipeZoneBounds recalculates for a shorter rotated height', () => {
  const { top, bottom } = getSwipeZoneBounds(600);

  assert.equal(top, 120);
  assert.equal(bottom, 480);
  assert.equal(bottom - top, 600 * SWIPE_ZONE_HEIGHT_RATIO);
});

test('isWithinVerticalSwipeZone validates y coordinates against runtime bounds', () => {
  const zone = getSwipeZoneBounds(600);

  assert.equal(isWithinVerticalSwipeZone(100, {
    swipeZoneTop: zone.top,
    swipeZoneBottom: zone.bottom,
  }), false);

  assert.equal(isWithinVerticalSwipeZone(300, {
    swipeZoneTop: zone.top,
    swipeZoneBottom: zone.bottom,
  }), true);

  assert.equal(isWithinVerticalSwipeZone(500, {
    swipeZoneTop: zone.top,
    swipeZoneBottom: zone.bottom,
  }), false);
});
