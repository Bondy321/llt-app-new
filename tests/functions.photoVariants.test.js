const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' });
const { __testables } = require('../functions/index.js');

test('parseSourcePhotoPath resolves group and private source paths only', () => {
  assert.deepEqual(__testables.parseSourcePhotoPath('group_tour_photos/tour-1/file.jpg'), {
    visibility: 'group',
    tourId: 'tour-1',
    ownerKey: null,
    filename: 'file.jpg',
  });

  assert.deepEqual(__testables.parseSourcePhotoPath('private_tour_photos/tour-1/owner-1/file.jpg'), {
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
    filename: 'file.jpg',
  });

  assert.equal(__testables.parseSourcePhotoPath('group_tour_photos/tour-1/viewers/file.jpg'), null);
});

test('buildPhotoCollectionPath maps visibility to expected DB collection', () => {
  assert.equal(__testables.buildPhotoCollectionPath({
    visibility: 'group',
    tourId: 'tour-1',
  }), 'group_tour_photos/tour-1');

  assert.equal(__testables.buildPhotoCollectionPath({
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
  }), 'private_tour_photos/tour-1/owner-1');
});
