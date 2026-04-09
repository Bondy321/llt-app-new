import * as FileSystem from 'expo-file-system';

const CACHE_DIR = `${FileSystem.cacheDirectory || FileSystem.documentDirectory}photo-viewer-cache/`;
const MAX_CACHE_ENTRIES = 160;
const TARGET_CACHE_ENTRIES = 120;

const inFlightDownloads = new Map();
let cacheDirReady = false;

const hashString = (input) => {
  const value = String(input || '');
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(i);
    hash &= 0x7fffffff;
  }
  return hash.toString(36);
};

const extractExtension = (uri) => {
  if (!uri || typeof uri !== 'string') return 'jpg';
  const match = uri.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  const ext = (match?.[1] || 'jpg').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext) ? ext : 'jpg';
};

const ensureCacheDirectory = async () => {
  if (cacheDirReady) return;
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
    cacheDirReady = true;
  } catch (error) {
    // Soft-fail and allow caller to continue with remote URI.
    cacheDirReady = false;
  }
};

const buildCacheFileUri = (remoteUri) => {
  const ext = extractExtension(remoteUri);
  const hash = hashString(remoteUri);
  return `${CACHE_DIR}${hash}.${ext}`;
};

const getFileInfo = async (uri) => {
  try {
    return await FileSystem.getInfoAsync(uri);
  } catch {
    return null;
  }
};

const isCacheFileValid = (info) => Boolean(info?.exists && Number(info?.size || 0) > 0);

const trimCacheIfNeeded = async () => {
  try {
    const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
    if (!Array.isArray(files) || files.length <= MAX_CACHE_ENTRIES) return;

    const filesWithMeta = await Promise.all(
      files.map(async (name) => {
        const uri = `${CACHE_DIR}${name}`;
        const info = await FileSystem.getInfoAsync(uri);
        return { uri, modified: info?.modificationTime || 0 };
      }),
    );

    filesWithMeta.sort((a, b) => a.modified - b.modified);
    const deleteCount = Math.max(0, filesWithMeta.length - TARGET_CACHE_ENTRIES);
    const toDelete = filesWithMeta.slice(0, deleteCount);

    await Promise.allSettled(
      toDelete.map(({ uri }) => FileSystem.deleteAsync(uri, { idempotent: true })),
    );
  } catch {
    // No-op: cache trim failure should never break image rendering.
  }
};

export const getCachedPhotoUri = async (remoteUri) => {
  if (!remoteUri || typeof remoteUri !== 'string') return null;
  if (!remoteUri.startsWith('http')) return remoteUri;

  await ensureCacheDirectory();
  if (!cacheDirReady) return remoteUri;

  const cacheUri = buildCacheFileUri(remoteUri);
  const cacheInfo = await getFileInfo(cacheUri);
  if (isCacheFileValid(cacheInfo)) {
    return cacheUri;
  }
  if (cacheInfo?.exists) {
    await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
  }

  const existingDownload = inFlightDownloads.get(remoteUri);
  if (existingDownload) {
    return existingDownload;
  }

  const downloadPromise = (async () => {
    const tempUri = `${cacheUri}.tmp`;
    try {
      await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
      const result = await FileSystem.downloadAsync(remoteUri, tempUri);
      const downloadedInfo = await getFileInfo(result?.uri || tempUri);
      if (result?.uri && isCacheFileValid(downloadedInfo)) {
        await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
        await FileSystem.moveAsync({ from: result.uri, to: cacheUri });
        await trimCacheIfNeeded();
        return cacheUri;
      }
      await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
      return remoteUri;
    } catch {
      await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
      return remoteUri;
    } finally {
      inFlightDownloads.delete(remoteUri);
    }
  })();

  inFlightDownloads.set(remoteUri, downloadPromise);
  return downloadPromise;
};

export const prefetchPhotoUris = async (uris = []) => {
  if (!Array.isArray(uris) || uris.length === 0) return;
  const uniqueUris = [...new Set(uris.filter((uri) => typeof uri === 'string' && uri.length > 0))];
  await Promise.allSettled(uniqueUris.map((uri) => getCachedPhotoUri(uri)));
};

export const __internal = {
  hashString,
  extractExtension,
  buildCacheFileUri,
  isCacheFileValid,
};
