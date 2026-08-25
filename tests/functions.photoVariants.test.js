const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' });
process.env.NODE_ENV = 'test';
const originalLoad = Module._load;
Module._load = function mockedLoad(request, _parent, _isMain) {
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
const { buildBookingRepairPlan } = require('../functions/scripts/repairDuplicateManifestPassengers.js');
const { setSharpFactoryForTests } = require('../functions/src/infrastructure/storage/mediaProcessor');
setSharpFactoryForTests(require('sharp'));
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

test('private media request validation is bounded and path authorization is exact', () => {
  assert.deepEqual(__testables.normalizePrivateMediaRequest({
    tourId: 'TOUR_1', ownerKey: 'owner-1', photoIds: ['photo-1', 'photo-1'],
  }), { tourId: 'TOUR_1', ownerKey: 'owner-1', photoIds: ['photo-1'] });
  assert.equal(__testables.normalizePrivateMediaRequest({
    tourId: 'TOUR_1', ownerKey: 'owner-1', photoIds: Array.from({ length: 51 }, (_, index) => `p${index}`),
  }), null);
  assert.equal(__testables.isPrivateMediaPathForRecord({
    path: 'private_tour_photos/TOUR_1/owner-1/source.jpg', tourId: 'TOUR_1', ownerKey: 'owner-1',
  }), true);
  assert.equal(__testables.isPrivateMediaPathForRecord({
    path: 'private_tour_photos/TOUR_1/owner-2/source.jpg', tourId: 'TOUR_1', ownerKey: 'owner-1',
  }), false);
});

test('private media record reads target only requested exact leaves with bounded concurrency', async () => {
  const paths = [];
  let active = 0;
  let maxActive = 0;
  const db = { ref: (path) => ({ once: async () => {
    paths.push(path);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { exists: () => true, val: () => ({ storagePath: `${path}/source.jpg` }) };
  } }) };
  const photoIds = Array.from({ length: 20 }, (_, index) => `photo-${index}`);
  const records = await __testables.readPrivateMediaRecords({
    db, tourId: 'TOUR_1', ownerKey: 'owner-1', photoIds, concurrency: 4,
  });
  assert.equal(Object.keys(records).length, 20);
  assert.equal(maxActive, 4);
  assert.equal(paths.includes('private_tour_photos/TOUR_1/owner-1'), false);
  assert.deepEqual(paths.sort(), photoIds.map(
    (photoId) => `private_tour_photos/TOUR_1/owner-1/${photoId}`,
  ).sort());
});

test('private media signing is path-scoped and concurrency bounded', async () => {
  let active = 0;
  let maxActive = 0;
  const signedPaths = [];
  const bucket = { file: (objectPath) => ({ getSignedUrl: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    signedPaths.push(objectPath);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return [`https://signed.invalid/${encodeURIComponent(objectPath)}`];
  } }) };
  const input = { tourId: 'TOUR_1', ownerKey: 'owner-1', photoIds: ['p1', 'p2', 'p3'] };
  const records = Object.fromEntries(input.photoIds.map((photoId) => [photoId, {
    storagePath: `private_tour_photos/TOUR_1/owner-1/${photoId}.jpg`,
    viewerStoragePath: `private_tour_photos/TOUR_1/owner-1/viewers/${photoId}.jpg`,
    thumbnailStoragePath: 'private_tour_photos/TOUR_1/foreign-owner/rejected.jpg',
  }]));
  const media = await __testables.signPrivateMediaRecords({
    bucket, input, records, expires: 12345, concurrency: 2,
  });
  assert.equal(maxActive, 2);
  assert.equal(signedPaths.length, 6);
  assert.deepEqual(Object.keys(media), input.photoIds);
  assert.equal(Object.values(media).every((item) => item.sourceUrl && item.viewerUrl && !item.thumbnailUrl), true);
});

test('admin HTTPS actions allow only the deployed portal, explicit custom origins, or local development', () => {
  assert.equal(__testables.isAllowedAdminOrigin('https://loch-lomond-travel-admin.web.app'), true);
  assert.equal(__testables.isAllowedAdminOrigin('https://loch-lomond-travel-admin.firebaseapp.com'), true);
  assert.equal(__testables.isAllowedAdminOrigin('http://localhost:5173'), true);
  assert.equal(__testables.isAllowedAdminOrigin('http://127.0.0.1:4173'), true);
  assert.equal(__testables.isAllowedAdminOrigin('', ''), true);
  assert.equal(__testables.isAllowedAdminOrigin('https://admin.example.com', 'https://admin.example.com'), true);
  assert.equal(__testables.isAllowedAdminOrigin('https://evil.example'), false);
  assert.equal(__testables.isAllowedAdminOrigin('https://loch-lomond-travel-admin.web.app.evil.example'), false);
  assert.equal(__testables.isAllowedAdminOrigin('null'), false);
});

test('toRealtimeKeySegment encodes stable passenger IDs for RTDB paths', () => {
  assert.equal(
    __testables.toRealtimeKeySegment('pax_v1:T123659:msandreayoung@yahoo.co.uk'),
    'pax_v1:T123659:msandreayoung@yahoo_2E_co_2E_uk',
  );
});

const createWindowLimiter = () => {
  const counts = new Map();
  return (key, maxRequests) => {
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    return next <= maxRequests;
  };
};

test('passenger login limits allow launch cohorts behind one shared network', async () => {
  const limiter = createWindowLimiter();
  for (let index = 0; index < 50; index += 1) {
    const result = await __testables.checkPassengerLoginRateLimits({
      authUid: `auth-user-${index}`,
      clientKey: '203.0.113.10:Expo/55 shared-agent',
      bookingRef: `BOOKING-${index}`,
      email: `passenger-${index}@example.test`,
      limiter,
    });
    assert.equal(result.allowed, true);
  }
});

test('passenger login limits still stop repeated credential guessing by one account', async () => {
  const credentialLimiter = createWindowLimiter();
  let result;
  for (let index = 0; index < 9; index += 1) {
    result = await __testables.checkPassengerLoginRateLimits({
      authUid: 'one-auth-user',
      clientKey: '203.0.113.20:Expo/55',
      bookingRef: 'SAME-BOOKING',
      email: 'same@example.test',
      limiter: credentialLimiter,
    });
  }
  assert.equal(result.allowed, false);
  assert.equal(result.scope, 'credential');

  const accountLimiter = createWindowLimiter();
  for (let index = 0; index < 25; index += 1) {
    result = await __testables.checkPassengerLoginRateLimits({
      authUid: `rotated-anonymous-auth-${index}`,
      clientKey: '203.0.113.20:Expo/55',
      bookingRef: 'SAME-TARGET-BOOKING',
      email: `guess-${index}@example.test`,
      limiter: accountLimiter,
    });
  }
  assert.equal(result.allowed, false);
  assert.equal(result.scope, 'account');
});

test('buildVerifiedLoginGrantUpdates scopes passenger grants to booking, tour, and auth uid', () => {
  const updates = __testables.buildVerifiedLoginGrantUpdates({
    authUid: 'auth-uid-1',
    bookingRef: 'ABC123',
    normalizedPassengerEmail: 'traveller@example.com',
    tourId: '5112D_8',
    nowMs: 1770000000000,
  });

  assert.deepEqual(Object.keys(updates).sort(), [
    'booking_access_grants/ABC123/auth-uid-1',
    'tour_access_grants/5112D_8/auth-uid-1',
  ]);
  assert.equal(updates['tour_access_grants/5112D_8/auth-uid-1'].expiresAtMs, 1770001800000);
  assert.equal(updates['tour_access_grants/5112D_8/auth-uid-1'].bookingRef, 'ABC123');
  assert.equal(updates['booking_access_grants/ABC123/auth-uid-1'].tourId, '5112D_8');
  assert.equal('tourCode' in updates['booking_access_grants/ABC123/auth-uid-1'], false);
});

test('passenger login projections allowlist customer data and drop operational fields', () => {
  const booking = __testables.buildPassengerSafeBooking('ABC123', {
    tourId: '5112D_8',
    tourCode: '5112D 8',
    passengerNames: ['Alex Example'],
    seatNumbers: ['S12'],
    pickupDate: '24/08/2026',
    pickupPoints: [{
      date: '24/08/2026',
      time: '08:00',
      location: 'Balloch Tourist Information Centre',
      address: 'Old Luss Road, Balloch',
      supplierPhone: '01234 567890',
    }],
    email: 'traveller@example.com',
    phone: '07123 456789',
    serviceContracts: [{ reference: 'SECRET' }],
    internalNotes: 'Do not expose',
  }, '5112D_8');
  const tour = __testables.buildPassengerSafeTour('5112D_8', {
    name: 'Highlands Escape',
    tourCode: '5112D 8',
    startDate: '24/08/2026',
    isActive: true,
    currentParticipants: 21,
    driverName: 'Jamie',
    driverPhone: '07111 222333',
    itinerary: {
      title: 'Your itinerary',
      days: [{ day: 1, content: 'Welcome', supplierReference: 'SECRET' }],
      serviceContracts: [{ price: 100 }],
    },
    driver_itinerary: 'Depot and supplier instructions',
    services: [{ reference: 'SECRET' }],
    contracts: [{ price: 100 }],
    participants: { passengerUid: { email: 'hidden@example.com' } },
  });

  assert.deepEqual(Object.keys(booking).sort(), [
    'id', 'passengerNames', 'pickupDate', 'pickupLocation', 'pickupPoints', 'pickupTime',
    'seatNumbers', 'totalPax', 'tourCode', 'tourId',
  ]);
  assert.deepEqual(Object.keys(booking.pickupPoints[0]).sort(), ['address', 'date', 'location', 'time']);
  assert.equal(JSON.stringify(booking).includes('example.com'), false);
  assert.deepEqual(Object.keys(tour).sort(), [
    'currentParticipants', 'driverName', 'driverPhone', 'id', 'isActive', 'itinerary',
    'name', 'startDate', 'tourCode',
  ]);
  assert.deepEqual(tour.itinerary.days[0], { day: 1, content: 'Welcome' });
  assert.equal(JSON.stringify(tour).includes('SECRET'), false);
  assert.equal(JSON.stringify(tour).includes('driver_itinerary'), false);
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
        tourId: '5112D_8',
        passengerNames: ['Alex', 'Sam'],
        pickupPoints: [{ location: 'Balloch', time: '08:00' }],
        email: 'must-not-cross@example.com',
        phone: '+441234567890',
        service: 'Internal service name',
        contract: 'Internal contract name',
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
  assert.equal(booking.pickupLocation, 'Balloch');
  assert.equal(booking.pickupTime, '08:00');
  assert.equal(booking.status, 'PARTIAL');
  assert.deepEqual(booking.passengerStatus, ['BOARDED', 'NO_SHOW']);
  assert.deepEqual(Object.keys(booking).sort(), [
    'hasPassengerStatuses',
    'id',
    'passengerNames',
    'passengerStatus',
    'pickupDate',
    'pickupLocation',
    'pickupTime',
    'seatLabels',
    'seatNumbers',
    'status',
  ]);
  const legacyBooking = manifest.bookings.find((item) => item.id === 'BY_TOUR_ID');
  assert.equal(legacyBooking.status, 'BOARDED');
  assert.deepEqual(legacyBooking.passengerStatus, ['BOARDED']);
  assert.equal(manifest.stats.totalPax, 3);
  assert.equal(manifest.stats.checkedIn, 2);
  assert.equal(manifest.stats.noShows, 1);
});

test('buildTourManifestPayload removes sync duplicates by passenger and seat identity', async () => {
  const duplicatedDetails = [
    { name: 'Ms Patricia Saunders', seatNo: 13, seatLabel: 'S13', pickupDate: '20/08/2026' },
    { name: 'Mrs Emily Mckay', seatNo: 14, seatLabel: 'S14', pickupDate: '20/08/2026' },
    { name: 'Ms Patricia Saunders', seatNo: 13, seatLabel: 'S13', pickupDate: '20/08/2026 00:00:00' },
    { name: 'Mrs Emily Mckay', seatNo: 14, seatLabel: 'S14', pickupDate: '20/08/2026 00:00:00' },
  ];
  const db = createMockRealtimeDb({
    tours: { '5155D_10': { name: 'Highlands', tourCode: '5155D 10' } },
    bookings: {
      T139956: {
        tourId: '5155D_10',
        passengerDetails: duplicatedDetails,
        passengerNames: duplicatedDetails.map((passenger) => passenger.name),
        passengers: duplicatedDetails.map((passenger) => passenger.name),
        seatNumbers: duplicatedDetails.map((passenger) => passenger.seatNo),
        seatLabels: duplicatedDetails.map((passenger) => passenger.seatLabel),
        pickupPoints: [{ location: 'Dundee', time: '09:30' }],
      },
    },
    tour_manifests: {
      '5155D_10': {
        bookings: {
          T139956: { passengerStatus: ['BOARDED', 'NO_SHOW', 'PENDING', 'PENDING'] },
        },
      },
    },
  });

  const manifest = await __testables.buildTourManifestPayload({ tourId: '5155D_10', db });
  const booking = manifest.bookings[0];

  assert.deepEqual(booking.passengerNames, ['Ms Patricia Saunders', 'Mrs Emily Mckay']);
  assert.deepEqual(booking.seatNumbers, [13, 14]);
  assert.deepEqual(booking.seatLabels, ['S13', 'S14']);
  assert.deepEqual(booking.passengerStatus, ['BOARDED', 'NO_SHOW']);
  assert.equal(booking.status, 'PARTIAL');
  assert.equal(manifest.stats.totalPax, 2);
  assert.equal(manifest.stats.checkedIn, 1);
  assert.equal(manifest.stats.noShows, 1);
});

test('manifest normalization preserves matching names when their seats differ', () => {
  const booking = __testables.normalizeManifestBooking('TWINS', {
    passengerNames: ['Alex Smith', 'Alex Smith'],
    seatNumbers: [7, 8],
  });

  assert.deepEqual(booking.passengerNames, ['Alex Smith', 'Alex Smith']);
  assert.deepEqual(booking.seatNumbers, [7, 8]);
});

test('duplicate manifest repair plan is reversible and preserves resolved status', () => {
  const booking = {
    tourId: '5155D_10',
    passengerNames: ['Patricia', 'Emily', 'Patricia', 'Emily'],
    passengerDetails: [
      { name: 'Patricia', seatNo: 13, seatLabel: 'S13' },
      { name: 'Emily', seatNo: 14, seatLabel: 'S14' },
      { name: 'Patricia', seatNo: 13, seatLabel: 'S13' },
      { name: 'Emily', seatNo: 14, seatLabel: 'S14' },
    ],
    seatNumbers: [13, 14, 13, 14],
    seatLabels: ['S13', 'S14', 'S13', 'S14'],
    pickupPoints: [
      { date: '20/08/2026', location: 'Dundee', time: '09:30' },
      { date: '20/08/2026 00:00:00', location: 'Dundee', time: '09:30' },
    ],
  };
  const manifestRecord = {
    passengerStatus: ['PENDING', 'NO_SHOW', 'BOARDED', 'NO_SHOW'],
    status: 'PARTIAL',
  };
  const plan = buildBookingRepairPlan({ bookingRef: 'T139956', booking, manifestRecord });

  assert.equal(plan.duplicateCount, 2);
  assert.deepEqual(plan.repairedBooking.passengerNames, ['Patricia', 'Emily']);
  assert.equal(plan.repairedBooking.pickupPoints.length, 1);
  assert.deepEqual(plan.repairedManifest.passengerStatus, ['BOARDED', 'NO_SHOW']);
  assert.equal(plan.repairedManifest.status, 'PARTIAL');
  assert.deepEqual(plan.originalBooking, booking);
  assert.deepEqual(plan.originalManifest, manifestRecord);
});

test('resolveDriverAssignment reads canonical driver profile assignment', async () => {
  const assignment = await __testables.resolveDriverAssignment({
    driverId: 'D-BONDY',
    driverData: {
      currentTourId: '5112D 8',
      currentTourCode: '5112D 8',
    },
  });

  assert.equal(assignment.assignedTourId, '5112D_8');
  assert.equal(assignment.assignedTourCode, '5112D 8');
  assert.equal(assignment.assignmentSource, 'driver_profile');
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

test('resolveChatSenderParticipantIds ignores messages without stable sender identity', async () => {
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

  assert.deepEqual(result, []);
  assert.deepEqual(lookups, []);
});

test('selectNotificationRecipients excludes sender auth uid resolved from stable identity', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['auth-uid-1', 'auth-uid-2'],
    usersMap: {
      'auth-uid-1': {
        pushToken: 'ExponentPushToken[sender]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-2': {
        pushToken: 'ExponentPushToken[recipient]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
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

test('selectNotificationRecipients skips unavailable, invalid, denied, and missing-status profiles', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['missing-status-user', 'unavailable-user', 'invalid-user', 'denied-user', 'active-user'],
    usersMap: {
      'missing-status-user': {
        pushToken: 'ExponentPushToken[missing-status]',
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
      'active-user': {
        pushToken: 'ExponentPushToken[active]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
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
    ['active-user'],
  );
});

test('selectNotificationRecipients sends once per unique Expo push token', () => {
  const result = __testables.selectNotificationRecipients({
    participantIds: ['auth-uid-1', 'auth-uid-2', 'auth-uid-3'],
    usersMap: {
      'auth-uid-1': {
        pushToken: ' ExponentPushToken[shared-token] ',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-2': {
        pushToken: 'ExponentPushToken[shared-token]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
        preferences: { ops: { group_chat: true } },
      },
      'auth-uid-3': {
        pushToken: 'ExponentPushToken[unique-token]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
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
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
        preferences: { ops: { group_chat: true } },
      },
      'old-auth-uid': {
        pushToken: 'ExponentPushToken[current-device]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
        preferences: { ops: { group_chat: true } },
      },
      'recipient-auth-uid': {
        pushToken: 'ExponentPushToken[recipient-device]',
        pushTokenStatus: 'ACTIVE',
        pushPermissionState: 'granted',
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

test('category broadcast preference resolver supports canonical and legacy tour interest opt-ins', () => {
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { day_trips: true } },
    }, 'day_trips'),
    true,
  );
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { mystery_tours: true } },
    }, 'mystery_breaks'),
    true,
  );
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { scotland_classics: true } },
    }, 'scotland_highlands_islands'),
    true,
  );
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { steam_trains: 'on' } },
    }, 'steam_train_tours'),
    true,
  );
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { theatre_concerts: false } },
    }, 'theatre_concerts'),
    false,
  );
  assert.equal(
    __testables.userWantsTourCategoryBroadcast({
      preferences: { marketing: { mystery_tours: true } },
    }, 'day_trips'),
    false,
  );
});

test('category broadcast validator requires a supported matching category payload', () => {
  const validPayload = {
    message: 'New dates are now available.',
    createdAtMs: 1780994000000,
    createdByUid: 'admin-uid',
    source: 'web_admin',
    categoryKey: 'day_trips',
    categoryLabel: 'Day Trips',
  };

  assert.deepEqual(
    __testables.validateCategoryBroadcastData('day_trips', validPayload),
    { valid: true, errors: [] },
  );

  const mismatch = __testables.validateCategoryBroadcastData('mystery_breaks', validPayload);
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.errors.join(' '), /categoryKey must match/);

  const unsupported = __testables.validateCategoryBroadcastData('not_a_category', {
    ...validPayload,
    categoryKey: 'not_a_category',
  });
  assert.equal(unsupported.valid, false);
  assert.match(unsupported.errors.join(' '), /Unsupported tour notification category/);

  const missingMessage = __testables.validateCategoryBroadcastData('day_trips', {
    ...validPayload,
    message: '',
  });
  assert.equal(missingMessage.valid, false);
  assert.match(missingMessage.errors.join(' '), /Missing broadcast message/);
});

test('getPushTokenIneligibilityReason reports token and permission suppression reasons', () => {
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushToken: 'ExponentPushToken[missing-status]' }),
    'token_status_missing',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'UNAVAILABLE' }),
    'token_status_unavailable',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'INVALID' }),
    'token_status_invalid',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'ACTIVE' }),
    'permission_missing',
  );
  assert.equal(
    __testables.getPushTokenIneligibilityReason({ pushTokenStatus: 'ACTIVE', pushPermissionState: 'blocked' }),
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

test('collectAssignedDriverIds reads canonical manifest assignment leaves', () => {
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

test('isDriverProfileAssignedToTour accepts canonical current tour matches only', () => {
  assert.equal(
    __testables.isDriverProfileAssignedToTour({ currentTourId: '5112D 8' }, '5112D_8'),
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
        'D-NOAUTH': { driverId: 'D-NOAUTH', tourId: '5112D_8' },
      },
    },
    loadProfile: async (driverId) => profiles[driverId] || null,
    context: { tourId: '5112D_8', notificationType: 'itinerary' },
  });

  assert.deepEqual(result, ['driver-auth-1']);
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

test('buildTourManifestPayload uses canonical pickup fields when no pickup point array exists', async () => {
  const db = createMockRealtimeDb({
    tours: { TOUR_1: { name: 'Day tour', tourCode: 'TOUR 1' } },
    bookings: {
      PICKUP1: {
        tourId: 'TOUR_1',
        passengerNames: ['A Passenger'],
        pickupLocation: 'Glasgow Central',
        pickupTime: '09:15',
      },
    },
  });

  const manifest = await __testables.buildTourManifestPayload({ tourId: 'TOUR_1', db });
  assert.equal(manifest.bookings[0].pickupLocation, 'Glasgow Central');
  assert.equal(manifest.bookings[0].pickupTime, '09:15');
});

test('findPhotoRecordByStoragePath tolerates the Storage-finalize versus RTDB-write race', async () => {
  let reads = 0;
  const waits = [];
  const dbRoot = {
    orderByChild: (field) => {
      assert.equal(field, 'storagePath');
      return {
        equalTo: (path) => ({
          once: async () => {
            reads += 1;
            return { val: () => (reads < 3 ? null : { photo_1: { storagePath: path } }) };
          },
        }),
      };
    },
  };
  const result = await __testables.findPhotoRecordByStoragePath({
    dbRoot,
    objectPath: 'group_tour_photos/tour-1/source.jpg',
    wait: async (delayMs) => waits.push(delayMs),
  });
  assert.deepEqual(result, {
    photoId: 'photo_1',
    photoRecord: { storagePath: 'group_tour_photos/tour-1/source.jpg' },
  });
  assert.deepEqual(waits, [250, 500]);
});

test('variant readiness uses tokenless Storage paths for private and group media', () => {
  assert.equal(__testables.isPhotoVariantRecordReady({
    visibility: 'private',
    photoRecord: {
      variantStatus: 'ready',
      viewerStoragePath: 'private/viewer.jpg',
      thumbnailStoragePath: 'private/thumb.jpg',
      viewerUrl: null,
      thumbnailUrl: null,
    },
  }), true);
  assert.equal(__testables.isPhotoVariantRecordReady({
    visibility: 'group',
    photoRecord: {
      variantStatus: 'ready',
      viewerStoragePath: 'group/viewer.jpg',
      thumbnailStoragePath: 'group/thumb.jpg',
    },
  }), true);
  assert.equal(__testables.isPhotoVariantRecordReady({
    visibility: 'private',
    photoRecord: {
      variantStatus: 'ready',
      viewerStoragePath: 'private/viewer.jpg',
    },
  }), false);
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
  const sourceMetadataUpdates = [];
  const updates = [];
  const storageBucket = {
    file: (path) => ({
      download: async () => [Buffer.from('source')],
      getMetadata: async () => [{ metadata: { authUid: 'auth-1' } }],
      setMetadata: async (metadata) => sourceMetadataUpdates.push(metadata),
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
  assert.equal(updates[0].payload.viewerUrl, null);
  assert.equal(updates[0].payload.thumbnailUrl, null);
  assert.deepEqual(saveMetadataByPath['group_tour_photos/tour-1/viewers/source_viewer.jpg'], {
    visibility: 'group', sourceRole: 'viewer',
  });
  assert.deepEqual(saveMetadataByPath['group_tour_photos/tour-1/thumbnails/source_thumb.jpg'], {
    visibility: 'group', sourceRole: 'thumbnail',
  });
  assert.deepEqual(sourceMetadataUpdates, [{ metadata: {
    visibility: 'group', sourceRole: 'source', firebaseStorageDownloadTokens: null,
  } }]);
});

test('private variant generation revokes source tokens and creates path-only tokenless variants', async () => {
  const sourceMetadataUpdates = [];
  const savedMetadata = {};
  const updates = [];
  const sourcePath = 'private_tour_photos/tour-1/owner-1/source.jpg';
  const storageBucket = {
    file: (path) => (path === sourcePath ? {
      download: async () => [Buffer.from('source')],
      getMetadata: async () => [{ metadata: {
        authUid: 'auth-1',
        bookingRef: 'must-be-removed',
        firebaseStorageDownloadTokens: 'legacy-token',
      } }],
      setMetadata: async (metadata) => sourceMetadataUpdates.push(metadata),
    } : {
      save: async (_buffer, options) => { savedMetadata[path] = options.metadata.metadata; },
    }),
  };
  const dbRoot = { child: () => ({ update: async (payload) => updates.push(payload) }) };
  const result = await __testables.generatePhotoVariantsForRecord({
    bucketName: 'demo-bucket.appspot.com',
    visibility: 'private',
    tourId: 'tour-1',
    ownerKey: 'owner-1',
    photoId: 'photo-1',
    storageBucket,
    dbRoot,
    photoRecord: { storagePath: sourcePath },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(sourceMetadataUpdates, [{ metadata: {
    authUid: 'auth-1',
    visibility: 'private',
    sourceRole: 'source',
    firebaseStorageDownloadTokens: null,
  } }]);
  assert.deepEqual(savedMetadata[result.viewerPath], { visibility: 'private', sourceRole: 'viewer' });
  assert.deepEqual(savedMetadata[result.thumbnailPath], { visibility: 'private', sourceRole: 'thumbnail' });
  assert.equal(updates[0].viewerUrl, null);
  assert.equal(updates[0].thumbnailUrl, null);
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

test('tour deletion plan removes all tour-scoped app data and canonical assignment links', () => {
  const updates = __testables.buildTourDeletionUpdates({
    tourId: 'TOUR_1',
    bookings: { BOOK_1: { tourId: 'TOUR_1' } },
    drivers: {
      'D-ALICE': { currentTourId: 'TOUR 1', authUid: 'driver-auth', assignments: { TOUR_1: true } },
      'D-BOB': { currentTourId: 'OTHER', assignments: { TOUR_1: true, OTHER: true } },
    },
    contentReports: { report_1: { tourId: 'TOUR_1' }, report_2: { tourId: 'OTHER' } },
    globalSafetyAlerts: { alert_1: { tourId: 'TOUR_1' }, alert_2: { tourId: 'OTHER' } },
  });

  for (const path of [
    'tours/TOUR_1',
    'tour_manifests/TOUR_1',
    'pickupPoints/TOUR_1',
    'chats/TOUR_1',
    'internal_chats/TOUR_1',
    'group_tour_photos/TOUR_1',
    'private_tour_photos/TOUR_1',
    'broadcasts/TOUR_1',
    'tour_notifications/TOUR_1',
    'notification_read_state/TOUR_1',
    'notification_read_migration_requests/TOUR_1',
    'notification_read_legacy_cleanup_queue/TOUR_1',
    'tour_access_grants/TOUR_1',
    'bookings/BOOK_1',
    'booking_identities/BOOK_1',
    'booking_access_grants/BOOK_1',
    'drivers/D-ALICE/currentTourId',
    'drivers/D-ALICE/currentTourCode',
    'drivers/D-ALICE/assignments/TOUR_1',
    'drivers/D-BOB/assignments/TOUR_1',
    'content_reports/report_1',
    'globalSafetyAlerts/alert_1',
  ]) {
    assert.equal(updates[path], null, `${path} must be deleted`);
  }
  assert.equal(updates['users/driver-auth/driverAssignedTourId'], null);
  assert.equal(updates['drivers/D-BOB/currentTourId'], undefined);
  assert.equal(updates['content_reports/report_2'], undefined);
});

test('tour deletion retry plan remains safe when the primary tour is already absent', () => {
  const updates = __testables.buildTourDeletionUpdates({ tourId: 'TOUR_1' });
  assert.equal(updates['tours/TOUR_1'], null);
  assert.equal(updates['tour_manifests/TOUR_1'], null);
  assert.equal(updates['group_tour_photos/TOUR_1'], null);
  assert.equal(updates['private_tour_photos/TOUR_1'], null);
  assert.equal(updates['tour_access_grants/TOUR_1'], null);
});

test('tour notification ids are deterministic, compact, and scoped by source', () => {
  const first = __testables.buildTourNotificationId({
    type: 'announcement',
    tourId: 'TOUR_1',
    sourceId: 'broadcast_1',
  });
  const repeated = __testables.buildTourNotificationId({
    type: 'announcement',
    tourId: 'TOUR_1',
    sourceId: 'broadcast_1',
  });
  const other = __testables.buildTourNotificationId({
    type: 'announcement',
    tourId: 'TOUR_1',
    sourceId: 'broadcast_2',
  });

  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.match(first, /^ntf_[a-f0-9]{32}$/);
});

test('push navigation payloads preserve durable notice and exact destination context', () => {
  assert.deepEqual(__testables.buildPushNavigationData({
    screen: 'Chat',
    tourId: 'TOUR_1',
    noticeId: 'notice-1',
    messageId: 'message-1',
    notificationType: 'announcement',
    timestamp: 100,
  }), {
    screen: 'Chat',
    tourId: 'TOUR_1',
    noticeId: 'notice-1',
    messageId: 'message-1',
    notificationType: 'announcement',
    timestamp: 100,
  });
  assert.deepEqual(__testables.buildPushNavigationData({
    screen: 'NotificationPreferences',
    categoryKey: 'day_trips',
    broadcastId: 'broadcast-1',
    notificationType: 'category_broadcast',
    timestamp: 200,
  }), {
    screen: 'NotificationPreferences',
    categoryKey: 'day_trips',
    broadcastId: 'broadcast-1',
    notificationType: 'category_broadcast',
    timestamp: 200,
  });
  assert.deepEqual(__testables.buildPushNavigationData({
    screen: 'DriverTourPack',
    tourId: '5001D_1',
    departureKey: '2026-09-10::5001D_1',
    revision: 4,
    changedSections: ['pickups', 'timeline'],
    critical: true,
    requiresAcknowledgement: true,
    notificationType: 'driver_tour_pack',
    timestamp: 300,
  }), {
    screen: 'DriverTourPack',
    tourId: '5001D_1',
    departureKey: '2026-09-10::5001D_1',
    revision: 4,
    changedSections: 'pickups,timeline',
    critical: true,
    requiresAcknowledgement: true,
    notificationType: 'driver_tour_pack',
    timestamp: 300,
  });
  assert.throws(
    () => __testables.buildPushNavigationData({ screen: 'Chat' }),
    /requires a tour id/,
  );
});

test('category broadcast fanout builds valid marketing payloads without chat-only variables', () => {
  const messages = __testables.buildCategoryBroadcastPushMessages({
    validRecipients: [
      { userId: 'user-2', userData: { pushToken: 'ExponentPushToken[recipient-device-2]' } },
      { userId: 'user-1', userData: { pushToken: 'ExponentPushToken[recipient-device-1]' } },
    ],
    categoryKey: 'day_trips',
    categoryLabel: 'Day Trips',
    broadcastId: 'broadcast-1',
    message: 'A new day trip is available.',
    timestamp: 1234,
  });

  assert.deepEqual(messages.map((payload) => payload.to), [
    'ExponentPushToken[recipient-device-1]',
    'ExponentPushToken[recipient-device-2]',
  ]);
  assert.deepEqual(messages[0], {
      to: 'ExponentPushToken[recipient-device-1]',
      sound: 'default',
      title: 'New Day Trips tour alert',
      body: 'A new day trip is available.',
      data: {
        screen: 'NotificationPreferences',
        notificationType: 'category_broadcast',
        categoryKey: 'day_trips',
        broadcastId: 'broadcast-1',
        timestamp: 1234,
      },
      priority: 'default',
      channelId: 'default',
    });
  assert.throws(() => __testables.buildCategoryBroadcastPushMessages({
    validRecipients: [],
    categoryKey: 'unsupported',
    broadcastId: 'broadcast-1',
    message: 'Invalid',
  }), /Invalid category broadcast/);
});

test('driver Tour Pack inbox records contain semantic metadata but no operational payload', () => {
  const record = __testables.buildTourNotificationRecord({
    type: 'driver_tour_pack',
    tourId: '5001D_1',
    sourceId: '2026-09-10::5001D_1:4',
    title: 'Operational information changed',
    body: 'Open the Driver Command Centre to review the updated sections.',
    screen: 'DriverTourPack',
    departureKey: '2026-09-10::5001D_1',
    revision: 4,
    changedSections: ['hotels', 'services'],
    createdAtMs: 300,
  });

  assert.equal(record.departureKey, '2026-09-10::5001D_1');
  assert.equal(record.changedSections, 'hotels,services');
  assert.equal(record.revision, 4);
  assert.equal(record.passengerName, undefined);
  assert.equal(record.hotelName, undefined);
  assert.equal(record.critical, undefined);
});

test('itinerary notifications describe the specific schedule change', () => {
  assert.deepEqual(
    __testables.summarizeItineraryChange(
      { days: [{ day: 1, content: 'Luss' }, { day: 2, content: 'Oban' }] },
      { days: [{ day: 1, content: 'Luss' }, { day: 2, content: 'Glencoe' }] },
    ),
    {
      title: 'Itinerary updated',
      body: 'Day 2 has changed. Tap to review the updated schedule.',
      changedDayCount: 1,
      changeType: 'updated',
      hasMeaningfulChange: true,
    },
  );

  assert.equal(
    __testables.summarizeItineraryChange({}, { days: [{ day: 1 }, { day: 2 }, { day: 3 }] }).body,
    'Your 3-day itinerary is now available. Tap to review the schedule.',
  );

  const firstPublication = __testables.summarizeItineraryChange(
    {},
    { title: 'Tour', days: [{ day: 1, content: 'Luss' }] },
  );
  assert.equal(firstPublication.title, 'Itinerary available');
  assert.equal(firstPublication.changeType, 'published');
  assert.equal(firstPublication.hasMeaningfulChange, true);

  const metadataOnly = __testables.summarizeItineraryChange(
    { title: 'Tour', days: [{ day: 1, content: 'Luss' }], revision: 1 },
    { title: 'Tour', days: [{ day: 1, content: 'Luss' }], revision: 2, updatedAt: 100 },
  );
  assert.equal(metadataOnly.hasMeaningfulChange, false);
  assert.equal(metadataOnly.body, null);
});

test('tour notification persistence is idempotent and retains only the newest 100 records', async () => {
  let storedValue = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `old_${index}`,
    {
      noticeId: `old_${index}`,
      createdAtMs: index + 1,
    },
  ]));
  const cleanupJobs = {};
  let cleanupJobTransactions = 0;
  const db = {
    ref: (path = '') => {
      if (path === 'tour_notifications/TOUR_1') {
        return {
          transaction: async (mutator) => {
            storedValue = mutator(storedValue);
            return { snapshot: { val: () => storedValue } };
          },
        };
      }
      if (path.startsWith('notification_read_cleanup_jobs/')) {
        const jobId = path.split('/').at(-1);
        return {
          transaction: async (mutator) => {
            cleanupJobTransactions += 1;
            cleanupJobs[jobId] = mutator(cleanupJobs[jobId] || null);
          },
        };
      }
      return { update: async () => {} };
    },
  };
  const record = __testables.buildTourNotificationRecord({
    type: 'itinerary',
    tourId: 'TOUR_1',
    sourceId: 'event_101',
    title: 'Itinerary updated',
    body: 'Day 2 has changed.',
    screen: 'Itinerary',
    createdAtMs: 101,
    messageId: 'message_101',
  });

  await __testables.persistTourNotification({ db, record });
  await __testables.persistTourNotification({ db, record });

  assert.equal(Object.keys(storedValue).length, 100);
  assert.equal(storedValue.old_0, undefined);
  assert.deepEqual(storedValue[record.noticeId], record);
  assert.equal(record.messageId, 'message_101');
  assert.equal(Object.keys(cleanupJobs).length, 1);
  assert.equal(cleanupJobTransactions, 1);
  assert.equal(Object.values(cleanupJobs)[0].noticeId, 'old_0');
});

test('notification read-state cleanup jobs page users and resume from a durable cursor', async () => {
  const noticeId = 'evicted_notice';
  const stateByUser = Object.fromEntries(Array.from({ length: 52 }, (_, index) => [
    `user_${String(index).padStart(3, '0')}`,
    { [noticeId]: index + 1, retained_notice: index + 2 },
  ]));
  const rootUpdates = [];
  const jobUpdates = [];
  let removed = false;
  let startAfter = null;
  let queryLimit = null;
  const db = {
    ref: (path = '') => {
      if (path === 'notification_read_state/TOUR_1') {
        const query = {
          orderByKey: () => query,
          startAt: (value) => { startAfter = value; return query; },
          limitToFirst: (value) => { queryLimit = value; return query; },
          once: async () => {
            const entries = Object.entries(stateByUser)
              .filter(([userId]) => !startAfter || userId >= startAfter)
              .slice(0, queryLimit);
            return { val: () => Object.fromEntries(entries) };
          },
        };
        return query;
      }
      if (path === 'notification_read_cleanup_jobs/job_1') {
        return {
          update: async (value) => jobUpdates.push(value),
          remove: async () => { removed = true; },
        };
      }
      return { update: async (value) => rootUpdates.push(value) };
    },
  };
  const job = {
    version: 1,
    jobId: 'job_1',
    tourId: 'TOUR_1',
    noticeId,
    processedUserCount: 0,
  };

  const firstPage = await __testables.processNotificationReadCleanupJob({
    db, jobId: 'job_1', job, now: 1000,
  });
  assert.equal(firstPage.completed, false);
  assert.equal(firstPage.processedUserCount, 50);
  assert.equal(Object.keys(rootUpdates[0]).length, 50);
  assert.equal(jobUpdates[0].afterUserId, 'user_049');
  assert.equal(removed, false);

  startAfter = null;
  const secondPage = await __testables.processNotificationReadCleanupJob({
    db,
    jobId: 'job_1',
    job: { ...job, ...jobUpdates[0] },
    now: 2000,
  });
  assert.equal(secondPage.completed, true);
  assert.equal(secondPage.processedUserCount, 2);
  assert.equal(Object.keys(rootUpdates[1]).length, 2);
  assert.equal(removed, true);
});

test('notification read-state upgrade deletes ambiguous legacy UID markers without copying them', async () => {
  const rootUpdates = [];
  const db = {
    ref: (path = '') => {
      if (path === 'users/shared-auth') {
        return { once: async () => ({ val: () => ({
          stablePassengerId: 'pax_v1:BOOKING1:passenger@example.com',
          stablePassengerKey: 'pax_v1:BOOKING1:passenger_40_example_2E_com',
        }) }) };
      }
      if (path === '') return { update: async (updates) => rootUpdates.push(updates) };
      return { remove: async () => {} };
    },
  };

  const result = await __testables.processNotificationReadMigrationRequest({
    db,
    tourId: 'TOUR_1',
    authUid: 'shared-auth',
    request: {
      version: 1,
      principalId: 'pax_v1:BOOKING1:passenger_40_example_2E_com',
      requestedAtMs: 1000,
    },
    now: 2000,
  });

  assert.equal(result.legacyRemoved, true);
  assert.deepEqual(rootUpdates, [{
    'notification_read_state/TOUR_1/shared-auth': null,
    'notification_read_migration_requests/TOUR_1/shared-auth': null,
    'users/shared-auth/notificationReadStateUpgradedTours/TOUR_1': true,
  }]);
});

test('legacy notification cleanup seeds a durable tour queue once', async () => {
  const queueUpdates = [];
  const stateWrites = [];
  const db = {
    ref: (path = '') => {
      if (path === 'notification_read_legacy_cleanup_state/v1') {
        return {
          once: async () => ({ val: () => null }),
          set: async (value) => stateWrites.push(value),
        };
      }
      if (path === 'notification_read_legacy_cleanup_queue') {
        return { update: async (updates) => queueUpdates.push(updates) };
      }
      throw new Error(`Unexpected path ${path}`);
    },
  };

  const result = await __testables.processLegacyNotificationReadStateCleanup({
    db,
    listTourIds: async () => ['TOUR_2', 'TOUR_1'],
    now: 2000,
  });

  assert.equal(result.seeded, true);
  assert.equal(result.discoveredTourCount, 2);
  assert.deepEqual(queueUpdates, [{
    TOUR_2: { version: 1, afterPrincipalId: null },
    TOUR_1: { version: 1, afterPrincipalId: null },
  }]);
  assert.deepEqual(stateWrites, [{
    version: 1, seeded: true, completed: false, updatedAtMs: 2000,
  }]);
});

test('legacy notification cleanup seeds large tour sets in bounded durable writes', async () => {
  const batchSizes = [];
  let stateWrite = null;
  const db = {
    ref: (path = '') => {
      if (path === 'notification_read_legacy_cleanup_state/v1') {
        return {
          once: async () => ({ val: () => null }),
          set: async (value) => { stateWrite = value; },
        };
      }
      if (path === 'notification_read_legacy_cleanup_queue') {
        return { update: async (updates) => batchSizes.push(Object.keys(updates).length) };
      }
      throw new Error(`Unexpected path ${path}`);
    },
  };

  await __testables.processLegacyNotificationReadStateCleanup({
    db,
    listTourIds: async () => Array.from({ length: 451 }, (_, index) => `TOUR_${String(index).padStart(3, '0')}`),
    now: 2500,
  });

  assert.deepEqual(batchSizes, [200, 200, 51]);
  assert.equal(stateWrite.seeded, true);
  assert.equal(stateWrite.completed, false);
});

test('legacy notification cleanup shallow discovery authenticates and returns deterministic keys', async () => {
  let request = null;
  const db = {
    app: {
      options: {
        databaseURL: 'https://example-default-rtdb.europe-west1.firebasedatabase.app/',
        credential: { getAccessToken: async () => ({ access_token: 'access-token' }) },
      },
    },
  };

  const keys = await __testables.fetchRealtimeDatabaseShallowKeys({
    db,
    path: 'notification_read_state',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ TOUR_2: true, 'invalid.key': true, TOUR_1: true }),
      };
    },
  });

  assert.deepEqual(keys, ['TOUR_1', 'TOUR_2']);
  assert.equal(request.url, 'https://example-default-rtdb.europe-west1.firebasedatabase.app/notification_read_state.json?shallow=true');
  assert.deepEqual(request.options, { headers: { Authorization: 'Bearer access-token' } });
});

test('legacy notification cleanup deletes only obsolete and deleted-auth UID branches', async () => {
  const rootUpdates = [];
  const profileReads = [];
  const profiles = {
    'legacy-bound': { stablePassengerId: 'pax_v1:B1:a@example.com', stablePassengerKey: 'pax_v1:B1:a_40_example_2E_com' },
    'legacy-current': { preferences: { ops: {} } },
    'orphan-active': null,
    'orphan-deleted': null,
  };
  const query = (value) => ({
    orderByKey() { return this; },
    startAt() { return this; },
    limitToFirst() { return this; },
    once: async () => ({ val: () => value }),
  });
  const db = {
    ref: (path = '') => {
      if (path === 'notification_read_legacy_cleanup_state/v1') {
        return { once: async () => ({ val: () => ({ seeded: true }) }), set: async () => {} };
      }
      if (path === 'notification_read_legacy_cleanup_queue') {
        return query({ TOUR_1: { version: 1, afterPrincipalId: null } });
      }
      if (path === 'notification_read_state/TOUR_1') {
        return query({
          'driver:D-1': { notice: 1 },
          'legacy-bound': { notice: 1 },
          'legacy-current': { notice: 1 },
          'orphan-active': { notice: 1 },
          'orphan-deleted': { notice: 1 },
          'pax_v1:B1:a_40_example_2E_com': { notice: 1 },
        });
      }
      if (path.startsWith('users/')) {
        const userId = path.split('/').at(-1);
        return { once: async () => {
          profileReads.push(userId);
          return { val: () => profiles[userId] ?? null };
        } };
      }
      if (path === '') return { update: async (updates) => rootUpdates.push(updates) };
      throw new Error(`Unexpected path ${path}`);
    },
  };

  const result = await __testables.processLegacyNotificationReadStateCleanup({
    db,
    resolveExistingAuthUids: async () => new Set(['orphan-active']),
    now: 3000,
  });

  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 6);
  assert.equal(result.deletedCount, 3);
  assert.deepEqual(profileReads.sort(), [
    'legacy-bound', 'legacy-current', 'orphan-active', 'orphan-deleted',
    'pax_v1:B1:a_40_example_2E_com',
  ]);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/legacy-bound'], null);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/pax_v1:B1:a_40_example_2E_com'], null);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/orphan-deleted'], null);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/orphan-active'], undefined);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/legacy-current'], undefined);
  assert.equal(rootUpdates[0]['notification_read_state/TOUR_1/driver:D-1'], undefined);
  assert.equal(rootUpdates[0]['notification_read_legacy_cleanup_queue/TOUR_1'], null);
  assert.equal(rootUpdates[0]['notification_read_legacy_cleanup_state/v1'].completed, true);
});

test('legacy notification cleanup resumes with the next queued tour after a tour is deleted', async () => {
  const rootUpdates = [];
  let principalLimit = null;
  const db = {
    ref: (path = '') => {
      if (path === 'notification_read_legacy_cleanup_state/v1') {
        return { once: async () => ({ val: () => ({ seeded: true }) }) };
      }
      if (path === 'notification_read_legacy_cleanup_queue') {
        return {
          orderByKey() { return this; },
          limitToFirst: () => ({ once: async () => ({ val: () => ({ TOUR_2: { version: 1 } }) }) }),
        };
      }
      if (path === 'notification_read_state/TOUR_2') {
        return {
          orderByKey() { return this; },
          limitToFirst(limit) {
            principalLimit = limit;
            return { once: async () => ({ val: () => ({}) }) };
          },
        };
      }
      if (path === '') return { update: async (updates) => rootUpdates.push(updates) };
      throw new Error(`Unexpected path ${path}`);
    },
  };

  const result = await __testables.processLegacyNotificationReadStateCleanup({
    db, resolveExistingAuthUids: async () => new Set(), now: 4000,
  });

  assert.equal(result.tourId, 'TOUR_2');
  assert.equal(result.completed, true);
  assert.equal(principalLimit, 51);
  assert.equal(rootUpdates[0]['notification_read_legacy_cleanup_queue/TOUR_2'], null);
});

test('reported photo cleanup resolves source and generated variant storage objects', () => {
  const paths = __testables.resolveReportedPhotoStoragePaths({
    tourId: 'TOUR_1',
    photo: { storagePath: 'group_tour_photos/TOUR_1/holiday.jpeg' },
  });
  assert.deepEqual(paths.sort(), [
    'group_tour_photos/TOUR_1/holiday.jpeg',
    'group_tour_photos/TOUR_1/thumbnails/holiday_thumb.jpg',
    'group_tour_photos/TOUR_1/viewers/holiday_viewer.jpg',
  ].sort());
});

test('broadcast delivery status distinguishes accepted, partial, failed, and empty fanout', () => {
  assert.equal(__testables.resolveBroadcastDeliveryStatus({ recipientCount: 0 }), 'no_recipients');
  assert.equal(__testables.resolveBroadcastDeliveryStatus({ recipientCount: 2, successCount: 2 }), 'delivered');
  assert.equal(__testables.resolveBroadcastDeliveryStatus({ recipientCount: 2, successCount: 1, errorCount: 1 }), 'partial');
  assert.equal(__testables.resolveBroadcastDeliveryStatus({ recipientCount: 2, successCount: 0, errorCount: 2 }), 'failed');
});
