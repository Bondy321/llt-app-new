const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ITINERARY_DATA_SOURCE,
  buildItinerarySyncPresentation,
} = require('../utils/itinerarySyncPresentation');

test('saved itinerary status is explicit while checking and when live refresh fails', () => {
  const checking = buildItinerarySyncPresentation({
    source: ITINERARY_DATA_SOURCE.CACHE,
    hasItinerary: true,
    checkingForUpdates: true,
    freshness: { bucket: 'fresh', label: 'Updated 2 min ago' },
  });
  assert.equal(checking.label, 'Saved itinerary');
  assert.match(checking.detail, /Checking for newer changes/);
  assert.equal(checking.showRetry, false);

  const failed = buildItinerarySyncPresentation({
    source: ITINERARY_DATA_SOURCE.CACHE,
    hasItinerary: true,
    errorMessage: 'offline',
    freshness: { bucket: 'stale', label: 'Updated 4h ago' },
  });
  assert.equal(failed.tone, 'warning');
  assert.match(failed.detail, /Live changes unavailable/);
  assert.equal(failed.showRetry, true);
});

test('live and unavailable itinerary states never claim the same provenance', () => {
  const live = buildItinerarySyncPresentation({
    source: ITINERARY_DATA_SOURCE.LIVE,
    hasItinerary: true,
    freshness: { bucket: 'fresh', label: 'Updated just now' },
  });
  assert.equal(live.label, 'Live itinerary');
  assert.match(live.detail, /update automatically/);

  const unavailable = buildItinerarySyncPresentation({
    source: ITINERARY_DATA_SOURCE.NONE,
    errorMessage: 'network unavailable',
  });
  assert.equal(unavailable.label, 'Itinerary unavailable');
  assert.equal(unavailable.tone, 'critical');
  assert.equal(unavailable.showRetry, true);
});
