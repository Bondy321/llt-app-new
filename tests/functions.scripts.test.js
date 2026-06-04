const test = require('node:test');
const assert = require('node:assert/strict');

const photoBackfill = require('../functions/scripts/backfillPhotoVariants');

test('photo variant backfill selects missing or failed server variants', () => {
  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: null,
  }, { retryFailed: true }), true);

  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: 'https://example.test/thumb.jpg',
    variantStatus: 'failed',
  }, { retryFailed: true }), true);

  assert.equal(photoBackfill.shouldBackfill({
    storagePath: 'group_tour_photos/TOUR_1/source.jpg',
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: 'https://example.test/thumb.jpg',
    variantStatus: 'failed',
  }, { retryFailed: false }), false);

  assert.equal(photoBackfill.shouldBackfill({
    viewerUrl: 'https://example.test/viewer.jpg',
    thumbnailUrl: null,
  }, { retryFailed: true }), false);
});

test('photo variant backfill apply runs require explicit broad-scan approval', () => {
  assert.throws(
    () => photoBackfill.validateOptions({ dryRun: false, tourId: null, allowFullScan: false }),
    /Refusing to apply/,
  );
  assert.doesNotThrow(
    () => photoBackfill.validateOptions({ dryRun: false, tourId: 'TOUR_1', allowFullScan: false }),
  );
  assert.throws(
    () => photoBackfill.validateOptions({
      dryRun: true,
      visibility: 'group',
      tourId: 'TOUR_1',
      ownerKey: 'owner-1',
    }),
    /ownerKey/,
  );
});
