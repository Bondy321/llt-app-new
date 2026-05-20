const test = require('node:test');
const assert = require('node:assert');

const {
  SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX,
  getSwipeReplyDragState,
  getSwipeReplySnapActivationDistance,
  shouldStartSwipeReplyGesture,
  shouldTriggerSwipeReplyOnRelease,
} = require('../services/chatSwipeReplyGesture');

test('snap activation distance is about halfway across common phone widths', () => {
  assert.equal(getSwipeReplySnapActivationDistance(390), 195);
  assert.equal(getSwipeReplySnapActivationDistance(430), 215);
});

test('snap activation distance is clamped for very small or wide surfaces', () => {
  assert.equal(getSwipeReplySnapActivationDistance(280), 160);
  assert.equal(getSwipeReplySnapActivationDistance(900), 240);
});

test('drag state clamps movement and activates when continued drag reaches snap distance', () => {
  const screenWidth = 390;
  const beforeSnap = getSwipeReplyDragState({ dx: 180 }, { screenWidth });
  const atSnap = getSwipeReplyDragState({ dx: 260 }, { screenWidth, peakDragX: beforeSnap.peakDragX });

  assert.equal(beforeSnap.shouldSnapActivate, false);
  assert.equal(beforeSnap.dragX, 180);
  assert.equal(atSnap.dragX, 195);
  assert.equal(atSnap.shouldSnapActivate, true);
  assert.equal(atSnap.progress, 1);
});

test('release can still commit once the reply is armed', () => {
  const shouldCommit = shouldTriggerSwipeReplyOnRelease(
    { dx: 24 },
    { peakDragX: SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX + 1 }
  );

  const shouldReject = shouldTriggerSwipeReplyOnRelease(
    { dx: SWIPE_REPLY_RELEASE_ACTIVATION_DISTANCE_PX - 1 },
    { peakDragX: 0 }
  );

  assert.equal(shouldCommit, true);
  assert.equal(shouldReject, false);
});

test('message swipe starts with rightward horizontal intent', () => {
  const shouldStart = shouldStartSwipeReplyGesture({
    x0: 0,
    dx: 16,
    dy: 4,
  });

  assert.equal(shouldStart, true);
});

test('message swipe rejects vertical scroll intent and disabled rows', () => {
  const verticalIntent = shouldStartSwipeReplyGesture({ dx: 18, dy: 20 });
  const disabled = shouldStartSwipeReplyGesture({ dx: 24, dy: 2 }, { disabled: true });

  assert.equal(verticalIntent, false);
  assert.equal(disabled, false);
});
