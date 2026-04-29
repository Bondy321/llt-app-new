const test = require('node:test');
const assert = require('node:assert');

const {
  isHorizontalSwipeIntent,
  DEFAULT_HORIZONTAL_INTENT_THRESHOLD,
} = require('../services/imageViewerGestureIntent');

test('accepts clearly horizontal swipes', () => {
  assert.equal(isHorizontalSwipeIntent({ dx: 30, dy: 10 }), true);
});

test('rejects mostly vertical swipes', () => {
  assert.equal(isHorizontalSwipeIntent({ dx: 30, dy: 40 }), false);
});

test('rejects gestures below threshold', () => {
  assert.equal(isHorizontalSwipeIntent({ dx: DEFAULT_HORIZONTAL_INTENT_THRESHOLD, dy: 0 }), false);
});

test('rejects invalid gesture payloads', () => {
  assert.equal(isHorizontalSwipeIntent(null), false);
  assert.equal(isHorizontalSwipeIntent({ dx: 'abc', dy: 2 }), false);
});
