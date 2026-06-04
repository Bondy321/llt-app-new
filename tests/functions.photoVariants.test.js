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

test('sanitizeLogText redacts sensitive identifiers from Functions error text', () => {
  const raw = [
    'Failed for traveller@example.com',
    'https://example.test/file.jpg?alt=media&token=secret-token-123',
    'ExponentPushToken[abc123]',
    'eyJaaaaaaaaaaaa.eyJbbbbbbbbbbbb.cccccccccccccc',
  ].join(' ');

  const sanitized = __testables.sanitizeLogText(raw);

  assert.equal(sanitized.includes('traveller@example.com'), false);
  assert.equal(sanitized.includes('secret-token-123'), false);
  assert.equal(sanitized.includes('ExponentPushToken[abc123]'), false);
  assert.equal(sanitized.includes('eyJaaaaaaaaaaaa.eyJbbbbbbbbbbbb.cccccccccccccc'), false);
  assert.match(sanitized, /\[redacted-email\]/);
  assert.match(sanitized, /token=\[redacted\]/);
  assert.match(sanitized, /ExponentPushToken\[redacted\]/);
  assert.match(sanitized, /\[redacted-jwt\]/);
});

test('toRealtimeKeySegment encodes stable passenger IDs for RTDB paths', () => {
  assert.equal(
    __testables.toRealtimeKeySegment('pax_v1:T123659:msandreayoung@yahoo.co.uk'),
    'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk',
  );
});

test('buildVerifiedLoginGrantUpdates scopes passenger grants to booking, tour, and auth uid', () => {
  const updates = __testables.buildVerifiedLoginGrantUpdates({
    authUid: 'auth-uid-1',
    bookingRef: 'ABC123',
    normalizedPassengerEmail: 'traveller@example.com',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    nowMs: 1770000000000,
  });

  assert.deepEqual(Object.keys(updates).sort(), [
    'booking_access_grants/ABC123/auth-uid-1',
    'tour_access_grants/5112D_8/auth-uid-1',
  ]);
  assert.equal(updates['tour_access_grants/5112D_8/auth-uid-1'].expiresAtMs, 1770001800000);
  assert.equal(updates['tour_access_grants/5112D_8/auth-uid-1'].bookingRef, 'ABC123');
  assert.equal(updates['booking_access_grants/ABC123/auth-uid-1'].tourId, '5112D_8');
});

const createMockRealtimeDb = (state) => {
  const getValue = (dbPath = '') => dbPath
    .split('/')
    .filter(Boolean)
    .reduce((node, key) => (node || {})[key], state);

  const snapshotFor = (value) => ({
    exists: () => value !== undefined && value !== null,
    val: () => value,
  });

  return {
    ref(dbPath = '') {
      const value = () => getValue(dbPath);
      return {
        async once() {
          return snapshotFor(value());
        },
        orderByChild(childKey) {
          return {
            equalTo(expected) {
              return {
                async once() {
                  const collection = value() || {};
                  const filtered = Object.entries(collection).reduce((acc, [key, child]) => {
                    if (child?.[childKey] === expected) {
                      acc[key] = child;
                    }
                    return acc;
                  }, {});
                  return snapshotFor(Object.keys(filtered).length > 0 ? filtered : null);
                },
              };
            },
          };
        },
      };
    },
  };
};

test('buildTourManifestPayload assembles normalized bookings and live passenger statuses', async () => {
  const db = createMockRealtimeDb({
    tours: {
      '5112D_8': { name: 'Highlands', tourCode: '5112D 8' },
    },
    bookings: {
      ABC123: {
        tourCode: '5112D 8',
        passengers: ['Alex', 'Sam'],
        pickupLocation: 'Balloch',
        pickupTime: '08:00',
      },
      BY_TOUR_ID: {
        tourId: '5112D_8',
        passengerNames: ['Jamie'],
        pickupPoints: [{ location: 'Luss', time: '08:30' }],
      },
    },
    tour_manifests: {
      '5112D_8': {
        bookings: {
          ABC123: {
            passengerStatus: ['BOARDED', 'NO_SHOW'],
          },
          BY_TOUR_ID: {
            status: 'BOARDED',
          },
        },
      },
    },
  });

  const manifest = await __testables.buildTourManifestPayload({ tourId: '5112D_8', db });

  assert.equal(manifest.bookings.length, 2);
  const booking = manifest.bookings.find((item) => item.id === 'ABC123');
  assert.deepEqual(booking.passengerNames, ['Alex', 'Sam']);
  assert.deepEqual(booking.pickupPoints, [{ location: 'Balloch', time: '08:00' }]);
  assert.equal(booking.status, 'PARTIAL');
  assert.deepEqual(booking.passengerStatus, ['BOARDED', 'NO_SHOW']);
  assert.equal(manifest.stats.totalPax, 3);
  assert.equal(manifest.stats.checkedIn, 2);
  assert.equal(manifest.stats.noShows, 1);
});

test('resolveDriverAssignment recovers legacy manifest driver-code assignments server-side', async () => {
  const db = createMockRealtimeDb({
    tour_manifests: {
      '5112D_8': {
        tourCode: '5112D 8',
        assigned_driver_codes: {
          'D-BONDY': {
            driverId: 'D-BONDY',
            tourId: '5112D_8',
            tourCode: '5112D 8',
          },
        },
      },
    },
  });

  const assignment = await __testables.resolveDriverAssignment({
    driverId: 'D-BONDY',
    driverData: {},
    db,
  });

  assert.equal(assignment.assignedTourId, '5112D_8');
  assert.equal(assignment.assignedTourCode, '5112D 8');
  assert.equal(assignment.assignmentSource, 'manifest_driver_code');
});

test('verifyTourManifestAccess denies ordinary passengers full manifest access', async () => {
  const db = createMockRealtimeDb({
    tours: {
      '5112D_8': {
        participants: {
          'passenger-auth-1': { userId: 'passenger-auth-1' },
        },
      },
    },
    users: {
      'passenger-auth-1': {
        bookingRef: 'ABC123',
        principalType: 'passenger',
      },
    },
  });

  const access = await __testables.verifyTourManifestAccess({
    authUid: 'passenger-auth-1',
    tourId: '5112D_8',
    db,
  });

  assert.equal(access.allowed, false);
  assert.equal(access.reason, 'NOT_TOUR_MEMBER');
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

test('selectNotificationRecipients sends once per unique Expo push token', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['auth-uid-1', 'auth-uid-2', 'auth-uid-3'],
    usersMap: {
      'auth-uid-1': {
        pushToken: ' ExponentPushToken[shared-token] ',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-2': {
        pushToken: 'ExponentPushToken[shared-token]',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-3': {
        pushToken: 'ExponentPushToken[unique-token]',
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
    ['auth-uid-1', 'auth-uid-3'],
  );
  assert.deepEqual(
    result.validRecipients.map((recipient) => recipient.userData.pushToken),
    ['ExponentPushToken[shared-token]', 'ExponentPushToken[unique-token]'],
  );
  assert.equal(result.duplicateTokenRecipientCount, 1);
});

test('selectNotificationRecipients excludes stale participant profiles sharing the sender push token', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['current-auth-uid', 'old-auth-uid', 'recipient-auth-uid'],
    usersMap: {
      'current-auth-uid': {
        pushToken: 'ExponentPushToken[current-device]',
        preferences: { ops: { group_chat: true } },
      },
      'old-auth-uid': {
        pushToken: 'ExponentPushToken[current-device]',
        preferences: { ops: { group_chat: true } },
      },
      'recipient-auth-uid': {
        pushToken: 'ExponentPushToken[recipient-device]',
        preferences: { ops: { group_chat: true } },
      },
    },
    preferencePath: ['preferences', 'ops', 'group_chat'],
    senderId: 'pax_v1:T123659:msandreayoung@yahoo.co.uk',
    senderParticipantIds: ['current-auth-uid'],
    excludeSender: true,
    context: { tourId: 'tour-1', notificationType: 'chat' },
  });

  assert.deepEqual(
    result.validRecipients.map((recipient) => recipient.userId),
    ['recipient-auth-uid'],
  );
  assert.equal(result.excludedSenderTokenRecipientCount, 1);
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
    __testables.isDriverProfileAssignedToTour({ activeTourId: '5112d 8' }, '5112D_8'),
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
