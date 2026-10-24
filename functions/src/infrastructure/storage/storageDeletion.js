'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');

const normalizeCleanupCursor = (cursor, prefixes) => {
  const prefixIndex = cursor?.prefixIndex || 0;
  const lastName = cursor?.lastName || null;
  if (!Number.isInteger(prefixIndex) || prefixIndex < 0 || prefixIndex > prefixes.length
    || (lastName && (typeof lastName !== 'string' || !lastName.startsWith(prefixes[prefixIndex])))) throw new Error('Invalid storage cleanup cursor');
  return { prefixIndex, lastName };
};
const storagePageQuery = ({ prefix, pageToken, lastName, remaining }) => ({
  prefix, autoPaginate: false, maxResults: Math.min(50, remaining),
  ...(pageToken ? { pageToken } : lastName ? { startOffset: lastName } : {}),
});
const storageBudgetExhausted = (inspected, maximum, deadline) => inspected >= maximum || Date.now() >= deadline;

/** @type {(...args: any[]) => Promise<any>} */
const deleteStoragePrefixes = async ({ bucket = admin.storage().bucket(), prefixes = [], beforePage = async () => {},
  maxObjects = 2000, maxPages = 40, cursor = null, onProgress = async () => {} }) => {
  const uniquePrefixes = [...new Set(prefixes.filter(Boolean))];
  let { prefixIndex, lastName } = normalizeCleanupCursor(cursor, uniquePrefixes);
  let deleted = 0; let inspected = 0; let pages = 0;
  const deadline = Date.now() + 210000;
  const pending = () => Object.assign(new Error('Storage cleanup is pending; retry the same deletion.'), { code: 'STORAGE_CLEANUP_PENDING' });
  while (prefixIndex < uniquePrefixes.length) {
    const prefix = uniquePrefixes[prefixIndex]; let pageToken;
    do {
      if (pages >= maxPages || inspected >= maxObjects || Date.now() >= deadline) throw pending();
      await beforePage();
      const [files, nextQuery] = await bucket.getFiles(storagePageQuery({ prefix, pageToken, lastName, remaining: maxObjects - inspected }));
      pages += 1;
      for (const file of files) {
        // startOffset includes the durable cursor. Retained sentinels must not
        // trap a later bounded invocation on the same page forever.
        if (file.name === lastName) continue;
        if (storageBudgetExhausted(inspected, maxObjects, deadline)) throw pending();
        await beforePage();
        if (await deleteExactStorageGeneration(file)) deleted += 1;
        inspected += 1; lastName = file.name;
        await onProgress({ prefixIndex, lastName });
      }
      pageToken = nextQuery?.pageToken;
    } while (pageToken);
    prefixIndex += 1; lastName = null;
    await onProgress({ prefixIndex, lastName });
  }
  return deleted;
};

const deleteExactStorageGeneration = async (file) => {
  let metadata = file.metadata;
  if (!metadata?.generation || metadata.size === undefined) {
    try { [metadata] = await file.getMetadata(); }
    catch (error) { if (Number(error?.code) === 404) return; throw error; }
  }
  // Permanent empty cancellation objects fence delayed generation-zero writes.
  // Deleting them would reopen the path after this operation reports success.
  if (metadata?.metadata?.cancelled === 'true' && Number(metadata.size) === 0) return false;
  const generation = metadata?.generation;
  if (!generation) throw new Error('Storage object generation is required for safe deletion');
  // A replaced object is a different object. A late deletion must never remove it.
  try { await file.delete({ ignoreNotFound: true, ifGenerationMatch: generation }); }
  catch (error) { if (Number(error?.code) !== 404) throw error; }
  return true;
};

/** @type {(...args: any[]) => Promise<any>} */
const deleteStoragePaths = async ({ bucket = admin.storage().bucket(), paths = [] }) => {
  const uniquePaths = [...new Set(paths.filter(/** @param {unknown} path */ (path) => typeof path === 'string' && path.trim()))];
  if (uniquePaths.length > 100) throw new Error('Too many storage paths');
  for (let index = 0; index < uniquePaths.length; index += 4) {
    await Promise.all(uniquePaths.slice(index, index + 4).map((path) => deleteExactStorageGeneration(bucket.file(path))));
  }
  return uniquePaths.length;
};


module.exports = { deleteStoragePaths, deleteStoragePrefixes };
