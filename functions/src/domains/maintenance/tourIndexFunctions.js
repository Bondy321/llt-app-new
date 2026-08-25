'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { buildDriverTourPackActionProjectionUpdates } = loadLegacyLibrary('driverTourPackOperations');
const { deriveTourDateIndexUpdate } = loadLegacyLibrary('tourDateIndex');

/** @param {any} snapshot */
const readSnapshotValue = (snapshot) => (
  snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null
);

/** @param {any} event */
const normalizeTourDateIndexesForEvent = async (event) => {
  const tourId = event.params.tourId;
  if (!isValidFirebaseKey(tourId)) return null;
  const tourRef = admin.database().ref(`tours/${tourId}`);
  const tourSnapshot = await tourRef.once('value');
  const tour = tourSnapshot.val() || null;
  if (!tour) return null;
  const indexUpdate = deriveTourDateIndexUpdate(tour);
  if (!indexUpdate) return null;
  await tourRef.update(indexUpdate);
  log.info('Tour date query indexes normalized', {
    tourId,
    indexed: indexUpdate.startDateEpochMs !== null,
  });
  return null;
};

const normalizeTourDateIndexes = onValueWritten(
  {
    ref: '/tours/{tourId}/startDate',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  normalizeTourDateIndexesForEvent,
);

const normalizeTourEndDateIndex = onValueWritten(
  {
    ref: '/tours/{tourId}/endDate',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  normalizeTourDateIndexesForEvent,
);

/**
 * @param {{ db: any, departureKey: string, driverId: string, beforeIssues: Record<string, unknown>, afterIssues: Record<string, unknown>, updates: Record<string, unknown> }} input
 */
const removeMatchingLegacyIssueProjections = async ({
  db, departureKey, driverId, beforeIssues, afterIssues, updates,
}) => {
  const changedIssueIds = [...new Set([...Object.keys(beforeIssues), ...Object.keys(afterIssues)])]
    .filter((issueId) => JSON.stringify(beforeIssues[issueId] ?? null) !== JSON.stringify(afterIssues[issueId] ?? null));
  await Promise.all(changedIssueIds.map(async (issueId) => {
    if (!isValidFirebaseKey(issueId)) return;
    const legacyPath = `driver_tour_pack_issues/${issueId}`;
    const legacySnapshot = await db.ref(legacyPath).once('value');
    const legacy = legacySnapshot.val();
    if (legacy?.departureKey === departureKey && legacy?.driverId === driverId && legacy?.issueId === issueId) {
      updates[legacyPath] = null;
    }
  }));
};

const projectDriverTourPackActionState = onValueWritten(
  {
    ref: '/driver_tour_pack_actions/{departureKey}/{driverId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 20,
  },
  async (event) => {
    const { departureKey, driverId } = event.params;
    if (!isValidFirebaseKey(departureKey) || !isValidFirebaseKey(driverId)) return null;
    const db = admin.database();
    const packSnapshot = await db.ref(`driver_tour_packs/${departureKey}`).once('value');
    const beforeActions = readSnapshotValue(event.data && event.data.before);
    const afterActions = readSnapshotValue(event.data && event.data.after);
    const updates = buildDriverTourPackActionProjectionUpdates({
      departureKey,
      driverId,
      pack: packSnapshot.val() || null,
      beforeActions,
      afterActions,
      updatedAtMs: Date.now(),
    });
    const beforeIssues = beforeActions && beforeActions.issues ? beforeActions.issues : {};
    const afterIssues = afterActions && afterActions.issues ? afterActions.issues : {};
    await removeMatchingLegacyIssueProjections({
      db, departureKey, driverId, beforeIssues, afterIssues, updates,
    });
    if (Object.keys(updates).length) await db.ref('/').update(updates);
    log.info('Driver Tour Pack action projection updated', {
      departureKey,
      driverId,
      updateCount: Object.keys(updates).length,
    });
    return null;
  },
);

module.exports = {
  normalizeTourDateIndexes,
  normalizeTourEndDateIndex,
  projectDriverTourPackActionState,
};
