const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' });
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'sharp') {
    return () => ({
      rotate: () => ({
        resize: () => ({
          jpeg: () => ({
            toBuffer: async () => Buffer.from([]),
          }),
        }),
      }),
    });
  }
  return originalLoad.apply(this, arguments);
};
const { __testables } = require('../functions/index.js');
Module._load = originalLoad;

test('toRealtimeKeySegment encodes stable passenger IDs for RTDB paths', () => {
  assert.equal(
    __testables.toRealtimeKeySegment('pax_v1:T123659:msandreayoung@yahoo.co.uk'),
    'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk',
  );
});

test('resolveChatSenderParticipantIds maps stable passenger identity to participant auth uid', async () => {
  const stablePassengerId = 'pax_v1:T123659:msandreayoung@yahoo.co.uk';
  const lookups = [];

  const result = await __testables.resolveChatSenderParticipantIds({
    participants: {
      'auth-uid-1': { joinedAt: '2026-05-23T10:00:00.000Z' },
      'auth-uid-2': { joinedAt: '2026-05-23T10:01:00.000Z' },
    },
    messageData: {
      senderId: stablePassengerId,
      senderStableId: stablePassengerId,
    },
    loadIdentityBindings: async (principalId) => {
      lookups.push(principalId);
      return {
        'auth-uid-1': true,
        'unjoined-auth-uid': true,
      };
    },
  });

  assert.deepEqual(result.sort(), ['auth-uid-1']);
  assert.deepEqual(lookups, [stablePassengerId]);
});

test('resolveChatSenderParticipantIds accepts legacy auth uid sender without binding lookup', async () => {
  const lookups = [];

  const result = await __testables.resolveChatSenderParticipantIds({
    participants: {
      'auth-uid-1': { joinedAt: '2026-05-23T10:00:00.000Z' },
    },
    messageData: {
      senderId: 'auth-uid-1',
    },
    loadIdentityBindings: async (principalId) => {
      lookups.push(principalId);
      return {};
    },
  });

  assert.deepEqual(result, ['auth-uid-1']);
  assert.deepEqual(lookups, []);
});

test('selectNotificationRecipients excludes sender auth uid resolved from stable identity', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['auth-uid-1', 'auth-uid-2'],
    usersMap: {
      'auth-uid-1': {
        pushToken: 'ExponentPushToken[sender]',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-2': {
        pushToken: 'ExponentPushToken[recipient]',
        preferences: { ops: { group_chat: true } },
      },
    },
    preferencePath: ['preferences', 'ops', 'group_chat'],
    senderId: 'pax_v1:T123659:msandreayoung@yahoo.co.uk',
    senderParticipantIds: ['auth-uid-1'],
    excludeSender: true,
    context: { tourId: 'tour-1', notificationType: 'chat' },
  });

  assert.deepEqual(
    result.validRecipients.map((recipient) => recipient.userId),
    ['auth-uid-2'],
  );
});

test('selectNotificationRecipients skips explicit unavailable token states but keeps legacy token-only profiles', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['legacy-user', 'unavailable-user', 'invalid-user', 'denied-user'],
    usersMap: {
      'legacy-user': {
        pushToken: 'ExponentPushToken[legacy]',
        preferences: { ops: { group_chat: true } },
      },
      'unavailable-user': {
        pushToken: 'ExponentPushToken[unavailable]',
        pushTokenStatus: 'UNAVAILABLE',
        preferences: { ops: { group_chat: true } },
      },
      'invalid-user': {
        pushToken: 'ExponentPushToken[invalid]',
        pushTokenStatus: 'INVALID',
        preferences: { ops: { group_chat: true } },
      },
      'denied-user': {
        pushToken: 'ExponentPushToken[denied]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'denied',
        preferences: { ops: { group_chat: true } },
      },
    },
    preferencePath: ['preferences', 'ops', 'group_chat'],
    senderId: null,
    excludeSender: false,
    context: { tourId: 'tour-1', notificationType: 'chat' },
  });

  assert.deepEqual(
    result.validRecipients.map((recipient) => recipient.userId),
    ['legacy-user'],
  );
});

test('getPushTokenIneligibilityReason reports token and permission suppression reasons', () => {
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'UNAVAILABLE' }),
    'token_status_unavailable',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'INVALID' }),
    'token_status_invalid',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushPermissionState: 'blocked' }),
    'permission_blocked',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'ACTIVE', pushPermissionState: 'granted' }),
    null,
  );
});

test('shouldRemoveInvalidToken only allows cleanup for the currently stored token', () => {
  assert.equal(
    __testables.shouldRemoveInvalidToken({ pushToken: 'ExponentPushToken[old]' }, 'ExponentPushToken[old]'),
    true,
  );
  assert.equal(
    __testables.shouldRemoveInvalidToken({ pushToken: 'ExponentPushToken[new]' }, 'ExponentPushToken[old]'),
    false,
  );
  assert.equal(
    __testables.shouldRemoveInvalidToken({ pushToken: null }, 'ExponentPushToken[old]'),
    false,
  );
  assert.equal(
    __testables.shouldRemoveInvalidToken(null, 'ExponentPushToken[old]'),
    false,
  );
});

test('collectAssignedDriverIds reads canonical and legacy manifest assignment leaves', () => {
  assert.deepEqual(
    __testables.collectAssignedDriverIds({
      assigned_drivers: {
        'D-BONDY': true,
        'D-INACTIVE': null,
      },
      assigned_driver_codes: {
        'D-SMITH': {
          driverId: 'D-SMITH',
          tourId: '5112D_8',
        },
        'bad.driver': true,
      },
    }),
    ['D-BONDY', 'D-SMITH'],
  );
});

test('isDriverProfileAssignedToTour accepts canonical and legacy active tour matches', () => {
  assert.equal(
    __testables.isDriverProfileAssignedToTour({ currentTourId: '5112D 8' }, '5112D_8'),
    true,
  );
  assert.equal(
    __testables.isDriverProfileAssignedToTour({ activeTourId: '5112D_8' }, '5112D_8'),
    true,
  );
  assert.equal(
    __testables.isDriverProfileAssignedToTour({ currentTourId: 'OTHER_TOUR' }, '5112D_8'),
    false,
  );
});

test('resolveAssignedDriverRecipientIds maps assigned driver records to auth uids', async () => {
  const profiles = {
    'D-BONDY': {
      authUid: 'driver-auth-1',
      currentTourId: '5112D_8',
    },
    'D-SMITH': {
      authUid: 'driver-auth-2',
      activeTourId: '5112D 8',
    },
    'D-STALE': {
      authUid: 'driver-auth-stale',
      currentTourId: 'OTHER_TOUR',
    },
    'D-NOAUTH': {
      currentTourId: '5112D_8',
    },
  };

  const result = await __testables.resolveAssignedDriverRecipientIds({
    tourId: '5112D_8',
    manifestData: {
      assigned_drivers: {
        'D-BONDY': true,
        'D-STALE': true,
      },
      assigned_driver_codes: {
        'D-SMITH': { driverId: 'D-SMITH', tourId: '5112D_8' },
        'D-NOAUTH': { driverId: 'D-NOAUTH', tourId: '5112D_8' },
      },
    },
    loadProfile: async (driverId) => profiles[driverId] || null,
    context: { tourId: '5112D_8', notificationType: 'itinerary' },
  });

  assert.deepEqual(result, ['driver-auth-1', 'driver-auth-2']);
});

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

test('buildPhotoVariantPaths maps private variants to supplied owner key', () => {
  assert.deepEqual(__testables.buildPhotoVariantPaths({
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'pax_v1:T123:email_2E_example',
    filename: 'source.jpg',
  }), {
    viewerPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/viewers/source_viewer.jpg',
    thumbnailPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/thumbnails/source_thumb.jpg',
  });
});

test('buildFirebaseStorageDownloadUrl encodes object paths for token URLs', () => {
  assert.equal(
    __testables.buildFirebaseStorageDownloadUrl({
      bucketName: 'demo-bucket.appspot.com',
      objectPath: 'private_tour_photos/tour-1/pax_v1:T123:email_2E_example/viewers/source_viewer.jpg',
      token: 'token-1',
    }),
    'https://firebasestorage.googleapis.com/v0/b/demo-bucket.appspot.com/o/private_tour_photos%2Ftour-1%2Fpax_v1%3AT123%3Aemail_2E_example%2Fviewers%2Fsource_viewer.jpg?alt=media&token=token-1',
  );
});

test('generatePhotoVariantsForRecord dry run reports target variant paths without writing', async () => {
  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'group',
    tourId: 'tour-1',
    photoId: 'photo-1',
    dryRun: true,
    photoRecord: {
      storagePath: 'group_tour_photos/tour-1/source.jpg',
    },
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.viewerPath, 'group_tour_photos/tour-1/viewers/source_viewer.jpg');
  assert.equal(result.thumbnailPath, 'group_tour_photos/tour-1/thumbnails/source_thumb.jpg');
});

test('generatePhotoVariantsForRecord writes ready variant fields', async () => {
  const savedPaths = [];
  const saveMetadataByPath = {};
  const updates = [];
  const storageBucket = {
    file: (path) => ({
      download: async () => [Buffer.from('source')],
      save: async (_buffer, options) => {
        savedPaths.push(path);
        saveMetadataByPath[path] = options?.metadata?.metadata || {};
      },
    }),
  };
  const dbRoot = {
    child: (photoId) => ({
      update: async (payload) => {
        updates.push({ photoId, payload });
      },
    }),
  };

  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'group',
    tourId: 'tour-1',
    photoId: 'photo-1',
    storageBucket,
    dbRoot,
    photoRecord: {
      idempotencyKey: 'idem-1',
      storagePath: 'group_tour_photos/tour-1/source.jpg',
    },
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(savedPaths, [
    'group_tour_photos/tour-1/viewers/source_viewer.jpg',
    'group_tour_photos/tour-1/thumbnails/source_thumb.jpg',
  ]);
  assert.equal(updates[0].photoId, 'photo-1');
  assert.equal(updates[0].payload.variantStatus, 'ready');
  assert.match(
    updates[0].payload.viewerUrl,
    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/demo-bucket\.appspot\.com\/o\/group_tour_photos%2Ftour-1%2Fviewers%2Fsource_viewer\.jpg\?alt=media&token=/,
  );
  assert.match(
    updates[0].payload.thumbnailUrl,
    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/demo-bucket\.appspot\.com\/o\/group_tour_photos%2Ftour-1%2Fthumbnails%2Fsource_thumb\.jpg\?alt=media&token=/,
  );
  assert.equal(typeof saveMetadataByPath['group_tour_photos/tour-1/viewers/source_viewer.jpg'].firebaseStorageDownloadTokens, 'string');
  assert.equal(typeof saveMetadataByPath['group_tour_photos/tour-1/thumbnails/source_thumb.jpg'].firebaseStorageDownloadTokens, 'string');
});

test('generatePhotoVariantsForRecord marks failed when source download fails', async () => {
  const updates = [];
  const storageBucket = {
    file: () => ({
      download: async () => {
        throw new Error('download failed');
      },
    }),
  };
  const dbRoot = {
    child: (photoId) => ({
      update: async (payload) => {
        updates.push({ photoId, payload });
      },
    }),
  };

  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
    photoId: 'photo-2',
    storageBucket,
    dbRoot,
    photoRecord: {
      storagePath: 'private_tour_photos/tour-1/owner-1/source.jpg',
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'download failed');
  assert.equal(updates[0].photoId, 'photo-2');
  assert.equal(updates[0].payload.variantStatus, 'failed');
  assert.equal(updates[0].payload.variantError, 'download failed');
});
