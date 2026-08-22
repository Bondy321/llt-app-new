#!/usr/bin/env node

const { parsePositiveInteger, trimString } = require('./scriptUtils');

const compareKeys = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const parseArgs = (argv = []) => ({
  dryRun: !argv.includes('--apply'),
  tourId: trimString((argv.find((arg) => arg.startsWith('--tourId=')) || '').slice(9)),
  ownerKey: trimString((argv.find((arg) => arg.startsWith('--ownerKey=')) || '').slice(11)),
  limit: parsePositiveInteger((argv.find((arg) => arg.startsWith('--limit=')) || '').slice(8), {
    defaultValue: 50,
    max: 500,
  }),
  afterCursor: trimString((argv.find((arg) => arg.startsWith('--after=')) || '').slice(8)),
});

const buildCandidate = ({ tourId, ownerKey, photoId, record }) => {
  if (!record || typeof record !== 'object') return null;
  const prefix = `private_tour_photos/${tourId}/${ownerKey}/`;
  const objectPaths = [record.storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
    .filter((value) => typeof value === 'string' && value.startsWith(prefix) && !value.includes('..'));
  const urlFields = ['sourceUrl', 'viewerUrl', 'thumbnailUrl'].filter((field) => (
    typeof record[field] === 'string' && /^https?:\/\//i.test(record[field])
  ));
  if (objectPaths.length === 0 && urlFields.length === 0) return null;
  return { cursor: photoId, tourId, ownerKey, photoId, objectPaths: [...new Set(objectPaths)], urlFields };
};

const collectCandidates = ({ records, tourId, ownerKey }) => Object.entries(records || {})
  .sort(([left], [right]) => compareKeys(left, right))
  .map(([photoId, record]) => buildCandidate({ tourId, ownerKey, photoId, record }))
  .filter(Boolean);

const isObjectNotFound = (error) => (
  error?.code === 404
  || error?.code === '404'
  || error?.code === 'storage/object-not-found'
  || error?.code === 'not-found'
);

const readPhotoPage = async ({ ownerRef, afterCursor, limit }) => {
  let query = ownerRef.orderByKey();
  if (afterCursor) query = query.startAt(afterCursor);
  const snapshot = await query.limitToFirst(limit + (afterCursor ? 2 : 1)).once('value');
  const ordered = Object.entries(snapshot.val() || {}).sort(([left], [right]) => compareKeys(left, right));
  const unseen = ordered.filter(([photoId]) => !afterCursor || compareKeys(photoId, afterCursor) > 0);
  const page = unseen.slice(0, limit);
  return {
    records: Object.fromEntries(page),
    nextCursor: unseen.length > limit && page.length > 0 ? page[page.length - 1][0] : null,
    scannedCount: page.length,
  };
};

const run = async ({ admin, options }) => {
  if (!options.tourId || !options.ownerKey) {
    throw new Error('Bounded migration requires both --tourId and --ownerKey');
  }
  const db = admin.database();
  const bucket = admin.storage().bucket();
  const ownerRef = db.ref(`private_tour_photos/${options.tourId}/${options.ownerKey}`);
  const page = await readPhotoPage({
    ownerRef,
    afterCursor: options.afterCursor,
    limit: options.limit,
  });
  const candidates = collectCandidates({
    records: page.records,
    tourId: options.tourId,
    ownerKey: options.ownerKey,
  });
  if (!options.dryRun) {
    for (const candidate of candidates) {
      for (const objectPath of candidate.objectPaths) {
        try {
          await bucket.file(objectPath).setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
        } catch (error) {
          if (!isObjectNotFound(error)) throw error;
        }
      }
      const updates = Object.fromEntries(candidate.urlFields.map((field) => [field, null]));
      if (Object.keys(updates).length > 0) {
        await ownerRef.child(candidate.photoId).update(updates);
      }
    }
  }
  return { dryRun: options.dryRun, candidates, nextCursor: page.nextCursor, scannedCount: page.scannedCount };
};

if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  run({ admin, options: parseArgs(process.argv.slice(2)) })
    .then((result) => console.log(JSON.stringify({
      dryRun: result.dryRun,
      scannedCount: result.scannedCount,
      candidateCount: result.candidates.length,
      nextCursor: result.nextCursor,
    }, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {
  buildCandidate,
  collectCandidates,
  compareKeys,
  isObjectNotFound,
  parseArgs,
  readPhotoPage,
  run,
};
