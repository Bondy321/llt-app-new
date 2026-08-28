'use strict';

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');

const {
  acquireDriverLocationProjectionInvalidation,
  releaseDriverLocationProjectionInvalidation,
} = loadLegacyLibrary('driverLocationProjection');

/** @param {Record<string, any>} updates */
const collectAssignmentLocationTours = (updates) => Object.keys(updates || {})
  .map((path) => path.match(/^tours\/([^/]+)\/driverLocation$/)?.[1] || null)
  .filter(Boolean)
  .sort();

/** @type {(...args: any[]) => Promise<any[]>} */
const acquireAssignmentLocationInvalidations = async ({
  db,
  updates,
  leaseOwner,
  nowMs,
  acquireInvalidation = acquireDriverLocationProjectionInvalidation,
  releaseInvalidation = releaseDriverLocationProjectionInvalidation,
}) => {
  const invalidations = [];
  try {
    for (const tourId of collectAssignmentLocationTours(updates)) {
      invalidations.push(await acquireInvalidation({
        database: db,
        tourId,
        nowMs,
        leaseOwner: `${leaseOwner}:${tourId}`,
      }));
    }
    invalidations.forEach((invalidation) => {
      updates[invalidation.publicPath] = invalidation.tombstone;
    });
    return invalidations;
  } catch (error) {
    await Promise.all(invalidations.map((invalidation) => releaseInvalidation({
      database: db,
      invalidation,
    })));
    throw error;
  }
};

module.exports = {
  acquireAssignmentLocationInvalidations,
  releaseDriverLocationProjectionInvalidation,
};
