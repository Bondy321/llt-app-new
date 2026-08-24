#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { parsePositiveInteger, trimString } = require('./scriptUtils');

const compareKeys = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const parseArgs = (argv = []) => ({
  dryRun: !argv.includes('--apply'),
  tourId: trimString((argv.find((arg) => arg.startsWith('--tourId=')) || '').slice(9)),
  limit: parsePositiveInteger((argv.find((arg) => arg.startsWith('--limit=')) || '').slice(8), {
    defaultValue: 100,
    max: 500,
  }),
  afterCursor: trimString((argv.find((arg) => arg.startsWith('--after=')) || '').slice(8)),
});

const decodeFirebaseObjectPath = (url) => {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/o\/([^?]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (error) { return null; }
};

const isGroupObjectPath = (path, tourId) => (
  typeof path === 'string'
  && path.startsWith(`group_tour_photos/${tourId}/`)
  && !path.includes('..')
);

const buildCandidate = ({ tourId, photoId, record }) => {
  if (!record || typeof record !== 'object') return null;
  const legacySourcePath = [record.sourceUrl, record.url, record.fullUrl]
    .map(decodeFirebaseObjectPath)
    .find((path) => isGroupObjectPath(path, tourId));
  const derivedSourcePath = isGroupObjectPath(record.storagePath, tourId)
    ? record.storagePath
    : legacySourcePath;
  const storagePath = isGroupObjectPath(derivedSourcePath, tourId) ? derivedSourcePath : null;
  const objectPaths = [storagePath, record.viewerStoragePath, record.thumbnailStoragePath]
    .filter((path) => isGroupObjectPath(path, tourId));
  const urlFields = ['sourceUrl', 'viewerUrl', 'thumbnailUrl', 'url', 'fullUrl']
    .filter((field) => typeof record[field] === 'string' && /^https?:\/\//i.test(record[field]));
  if (!storagePath && objectPaths.length === 0 && urlFields.length === 0) return null;
  return {
    cursor: photoId,
    tourId,
    photoId,
    storagePath,
    objectPaths: [...new Set(objectPaths)],
    urlFields,
    legacyUrls: urlFields.map((field) => record[field]),
  };
};

const readPhotoPage = async ({ tourRef, afterCursor, limit }) => {
  let query = tourRef.orderByKey();
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

const isObjectNotFound = (error) => error?.code === 404 || error?.code === '404';

const findChatReferenceUpdates = ({ messages, candidates }) => {
  const photoByUrl = new Map();
  candidates.forEach((candidate) => candidate.legacyUrls.forEach((url) => photoByUrl.set(url, candidate.photoId)));
  const updates = {};
  Object.entries(messages || {}).forEach(([messageId, message]) => {
    if (!message || message.type !== 'image') return;
    const photoId = photoByUrl.get(message.imageUrl) || photoByUrl.get(message.thumbnailUrl);
    if (!photoId) return;
    updates[`chats/${candidates[0].tourId}/messages/${messageId}/photoId`] = photoId;
    updates[`chats/${candidates[0].tourId}/messages/${messageId}/imageUrl`] = null;
    updates[`chats/${candidates[0].tourId}/messages/${messageId}/thumbnailUrl`] = null;
  });
  return updates;
};

const isSafeLegacyOwner = (value) => {
  const principal = trimString(value);
  return Boolean(principal && principal.length <= 160
    && !principal.startsWith('pax_v1:')
    && !/[.#$\[\]/]/.test(principal));
};

const normalizeLegacyTimestamp = (value, fallbackMs) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
};

const buildOrphanChatMediaPlan = async ({
  bucket,
  tourId,
  messages,
  knownUrls,
  tourExists,
  nowMs = Date.now(),
}) => {
  const updates = {};
  const photoRecords = {};
  const existenceByPath = new Map();
  let referenceCount = 0;
  for (const [messageId, message] of Object.entries(messages || {})) {
    if (!message || message.type !== 'image') continue;
    const urls = [message.imageUrl, message.thumbnailUrl]
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
    if (urls.length === 0 || urls.some((url) => knownUrls.has(url))) continue;
    const objectPath = urls.map(decodeFirebaseObjectPath)
      .find((path) => isGroupObjectPath(path, tourId));
    if (!objectPath) continue;
    if (!existenceByPath.has(objectPath)) {
      existenceByPath.set(objectPath, (await bucket.file(objectPath).exists())[0]);
    }
    const ownerId = trimString(message.senderStableId || message.senderId);
    const canRecover = existenceByPath.get(objectPath) && tourExists && isSafeLegacyOwner(ownerId);
    if (canRecover) {
      const digest = createHash('sha256').update(`${tourId}:${objectPath}`).digest('hex').slice(0, 32);
      const photoId = `legacy_chat_${digest}`;
      photoRecords[photoId] = {
        userId: ownerId,
        caption: (trimString(message.caption || message.text) || '').slice(0, 500),
        uploaderName: (trimString(message.senderName) || 'Tour Member').slice(0, 100),
        timestamp: normalizeLegacyTimestamp(message.timestamp, nowMs),
        storagePath: objectPath,
        idempotencyKey: photoId,
        variantStatus: 'ready',
        variantUpdatedAt: nowMs,
        variantError: null,
        variantVersion: 2,
      };
      updates[`chats/${tourId}/messages/${messageId}/photoId`] = photoId;
    }
    updates[`chats/${tourId}/messages/${messageId}/imageUrl`] = null;
    updates[`chats/${tourId}/messages/${messageId}/thumbnailUrl`] = null;
    referenceCount += 1;
  }
  return { updates, photoRecords, referenceCount };
};

const listTokenizedObjects = async ({ bucket, tourId, concurrency = 12 }) => {
  const [files] = await bucket.getFiles({ prefix: `group_tour_photos/${tourId}/` });
  const tokenized = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (nextIndex < files.length) {
      const file = files[nextIndex];
      nextIndex += 1;
      // The list response can omit firebaseStorageDownloadTokens while still
      // returning other custom metadata. Read the object itself so a partial
      // listing cannot produce a false-negative security audit.
      const metadata = (await file.getMetadata())[0];
      if (metadata?.metadata?.firebaseStorageDownloadTokens) tokenized.push(file.name);
    }
  });
  await Promise.all(workers);
  return tokenized.sort(compareKeys);
};

const run = async ({ admin, options }) => {
  if (!options.tourId) throw new Error('Bounded migration requires --tourId');
  const db = admin.database();
  const bucket = admin.storage().bucket();
  const tourRef = db.ref(`group_tour_photos/${options.tourId}`);
  const page = await readPhotoPage({ tourRef, afterCursor: options.afterCursor, limit: options.limit });
  const candidates = Object.entries(page.records)
    .map(([photoId, record]) => buildCandidate({ tourId: options.tourId, photoId, record }))
    .filter(Boolean);
  const [chatSnapshot, tokenizedObjects, tourSnapshot] = await Promise.all([
    db.ref(`chats/${options.tourId}/messages`).once('value'),
    listTokenizedObjects({ bucket, tourId: options.tourId }),
    db.ref(`tours/${options.tourId}`).once('value'),
  ]);
  const messages = chatSnapshot.val() || {};
  const chatUpdates = findChatReferenceUpdates({ messages, candidates });
  const knownUrls = new Set(candidates.flatMap((candidate) => candidate.legacyUrls));
  const orphanPlan = await buildOrphanChatMediaPlan({
    bucket,
    tourId: options.tourId,
    messages,
    knownUrls,
    tourExists: tourSnapshot.exists(),
  });

  if (!options.dryRun) {
    for (const objectPath of tokenizedObjects) {
      try {
        await bucket.file(objectPath).setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
      } catch (error) {
        if (!isObjectNotFound(error)) throw error;
      }
    }
    const updates = { ...chatUpdates, ...orphanPlan.updates };
    candidates.forEach((candidate) => {
      if (candidate.storagePath) {
        updates[`group_tour_photos/${candidate.tourId}/${candidate.photoId}/storagePath`] = candidate.storagePath;
      }
      candidate.urlFields.forEach((field) => {
        updates[`group_tour_photos/${candidate.tourId}/${candidate.photoId}/${field}`] = null;
      });
    });
    Object.entries(orphanPlan.photoRecords).forEach(([photoId, record]) => {
      updates[`group_tour_photos/${options.tourId}/${photoId}`] = record;
    });
    if (Object.keys(updates).length > 0) await db.ref().update(updates);
  }
  return {
    dryRun: options.dryRun,
    scannedCount: page.scannedCount,
    candidates,
    chatReferenceCount: Object.keys(chatUpdates).length / 3,
    orphanChatReferenceCount: orphanPlan.referenceCount,
    recoveredOrphanPhotoCount: Object.keys(orphanPlan.photoRecords).length,
    tokenizedObjects,
    nextCursor: page.nextCursor,
  };
};

if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  run({ admin, options: parseArgs(process.argv.slice(2)) })
    .then((result) => console.log(JSON.stringify({
      dryRun: result.dryRun,
      scannedCount: result.scannedCount,
      candidateCount: result.candidates.length,
      chatReferenceCount: result.chatReferenceCount,
      orphanChatReferenceCount: result.orphanChatReferenceCount,
      recoveredOrphanPhotoCount: result.recoveredOrphanPhotoCount,
      tokenizedObjectCount: result.tokenizedObjects.length,
      nextCursor: result.nextCursor,
    }, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => {
      await Promise.all(admin.apps.map((app) => app.delete()));
    });
}

module.exports = {
  buildCandidate,
  buildOrphanChatMediaPlan,
  compareKeys,
  decodeFirebaseObjectPath,
  findChatReferenceUpdates,
  isGroupObjectPath,
  isObjectNotFound,
  listTokenizedObjects,
  parseArgs,
  readPhotoPage,
  run,
};
