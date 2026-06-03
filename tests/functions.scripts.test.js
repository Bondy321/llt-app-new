const test = require('node:test');
const assert = require('node:assert/strict');

const assignedDriverCodes = require('../functions/scripts/normalizeAssignedDriverCodes');
const privatePhotoOwners = require('../functions/scripts/migratePrivatePhotoOwnersToStablePassengerIds');
const broadcastTimestamps = require('../functions/scripts/normalizeLegacyBroadcastTimestamps');
const photoBackfill = require('../functions/scripts/backfillPhotoVariants');
const { toRealtimeKeySegment } = require('../functions/scripts/scriptUtils');

test('assigned driver code migration defaults to dry-run and builds canonical payloads', () => {
  assert.equal(assignedDriverCodes.parseArgs([]).dryRun, true);
  assert.equal(assignedDriverCodes.parseArgs(['--apply']).dryRun, false);

  const assignedAt = '2026-06-03T10:15:00.000Z';
  const { updates, summary } = assignedDriverCodes.buildAssignedDriverCodeUpdatePlan({
    '5112D_8': {
      tourCode: '5112D 8',
      assigned_driver_codes: {
        'D-BONDY': 'legacy-string',
        'D-CANONICAL': {
          driverId: 'D-CANONICAL',
          tourId: '5112D_8',
        },
      },
    },
  }, { assignedAt, assignedBy: 'test-runner' });

  assert.deepEqual(updates['tour_manifests/5112D_8/assigned_driver_codes/D-BONDY'], {
    driverId: 'D-BONDY',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    assignedAt,
    assignedBy: 'test-runner',
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.migrated, 1);
  assert.equal(summary.skippedNonLegacy, 1);
});

test('assigned driver code migration respects tour, driver, and limit filters', () => {
  const { updates, summary } = assignedDriverCodes.buildAssignedDriverCodeUpdatePlan({
    TOUR_A: {
      assigned_driver_codes: {
        'D-ONE': 'TOUR A',
        'D-TWO': 'TOUR A',
      },
    },
    TOUR_B: {
      assigned_driver_codes: {
        'D-ONE': 'TOUR B',
      },
    },
  }, {
    tourId: 'TOUR_A',
    driverId: 'd-one',
    limit: 1,
    assignedAt: '2026-06-03T10:15:00.000Z',
  });

  assert.deepEqual(Object.keys(updates), ['tour_manifests/TOUR_A/assigned_driver_codes/D-ONE']);
  assert.equal(summary.migrated, 1);
  assert.equal(summary.skippedByFilter, 2);
});

test('assigned driver code migration apply runs require explicit broad-scan approval', () => {
  assert.throws(
    () => assignedDriverCodes.validateOptions({ dryRun: false, tourId: null, allowFullScan: false }),
    /Refusing to apply/,
  );
  assert.doesNotThrow(
    () => assignedDriverCodes.validateOptions({ dryRun: false, tourId: 'TOUR_A', allowFullScan: false }),
  );
});

test('private photo owner migration maps booking refs to encoded stable owner keys', () => {
  const stablePassengerId = 'pax_v1:ABC123:person@example.com';
  const stableOwnerKey = toRealtimeKeySegment(stablePassengerId);
  const { updates, summary } = privatePhotoOwners.buildPrivatePhotoOwnerMigrationPlan({
    uid1: {
      bookingRef: 'ABC123',
      privatePhotoOwnerId: 'ABC123',
      stablePassengerId,
    },
  }, {
    TOUR_1: {
      ABC123: {
        photoA: {
          url: 'https://example.test/source-a.jpg',
          storagePath: 'private_tour_photos/TOUR_1/ABC123/source-a.jpg',
          userId: 'ABC123',
        },
      },
      [stableOwnerKey]: {
        photoB: {
          url: 'https://example.test/source-b.jpg',
          storagePath: `private_tour_photos/TOUR_1/${stableOwnerKey}/source-b.jpg`,
          userId: stablePassengerId,
        },
      },
    },
  });

  const target = updates[`private_tour_photos/TOUR_1/${stableOwnerKey}`];
  assert.equal(target.photoA.userId, stablePassengerId);
  assert.equal(target.photoB.userId, stablePassengerId);
  assert.equal(summary.copiedOwners, 1);
  assert.equal(summary.copiedPhotos, 1);
});

test('private photo owner migration preserves canonical records on conflict', () => {
  const stablePassengerId = 'pax_v1:ABC123:person@example.com';
  const stableOwnerKey = toRealtimeKeySegment(stablePassengerId);
  const { updates, summary } = privatePhotoOwners.buildPrivatePhotoOwnerMigrationPlan({
    uid1: {
      bookingRef: 'ABC123',
      stablePassengerId,
    },
  }, {
    TOUR_1: {
      ABC123: {
        photoA: {
          url: 'https://example.test/legacy.jpg',
          storagePath: 'private_tour_photos/TOUR_1/ABC123/legacy.jpg',
          caption: 'old caption',
        },
      },
      [stableOwnerKey]: {
        photoA: {
          url: 'https://example.test/canonical.jpg',
          storagePath: `private_tour_photos/TOUR_1/${stableOwnerKey}/canonical.jpg`,
          caption: 'fresh caption',
        },
      },
    },
  }, { deleteLegacy: true });

  assert.equal(updates[`private_tour_photos/TOUR_1/${stableOwnerKey}`], undefined);
  assert.equal(updates['private_tour_photos/TOUR_1/ABC123'], undefined);
  assert.equal(summary.conflictPhotos, 1);
  assert.equal(summary.deleteLegacyPrepared, 0);
});

test('private photo owner migration skips ambiguous owner mappings', () => {
  const { updates, summary } = privatePhotoOwners.buildPrivatePhotoOwnerMigrationPlan({
    uid1: {
      bookingRef: 'ABC123',
      stablePassengerId: 'pax_v1:ABC123:one@example.com',
    },
    uid2: {
      bookingRef: 'ABC123',
      stablePassengerId: 'pax_v1:ABC123:two@example.com',
    },
  }, {
    TOUR_1: {
      ABC123: {
        photoA: { url: 'https://example.test/a.jpg' },
      },
    },
  });

  assert.deepEqual(updates, {});
  assert.equal(summary.ambiguousMappingCount, 1);
  assert.equal(summary.skippedAmbiguousMapping, 1);
});

test('broadcast timestamp parser accepts only numeric or zoned ISO timestamps', () => {
  assert.equal(broadcastTimestamps.parseTimestamp(1770000000000), 1770000000000);
  assert.equal(broadcastTimestamps.parseTimestamp('1770000000000'), 1770000000000);
  assert.equal(
    broadcastTimestamps.parseTimestamp('2026-06-03T10:00:00.000Z'),
    Date.parse('2026-06-03T10:00:00.000Z'),
  );
  assert.equal(broadcastTimestamps.parseTimestamp('03/06/2026'), null);
  assert.equal(broadcastTimestamps.parseTimestamp('2026-06-03T10:00:00'), null);
  assert.equal(broadcastTimestamps.parseTimestamp('2026-02-31T10:00:00Z'), null);
});

test('broadcast timestamp migration only rewrites recent legacy broadcast timestamps', () => {
  const nowMs = Date.parse('2026-06-03T12:00:00.000Z');
  const { updates, summary } = broadcastTimestamps.buildBroadcastTimestampUpdatePlan({
    TOUR_1: {
      messages: {
        broadcastA: {
          messageType: 'ADMIN_BROADCAST',
          timestamp: '2026-06-03T10:00:00.000Z',
        },
        regularMessage: {
          text: 'hello',
          timestamp: '2026-06-03T10:30:00.000Z',
        },
        alreadyNumeric: {
          source: 'web_admin',
          timestamp: nowMs,
        },
      },
    },
  }, { nowMs, hours: 24 });

  assert.deepEqual(updates, {
    'chats/TOUR_1/messages/broadcastA/timestamp': Date.parse('2026-06-03T10:00:00.000Z'),
  });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.broadcastMessages, 2);
  assert.equal(summary.normalized, 1);
  assert.equal(summary.skippedAlreadyNumeric, 1);
});

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
