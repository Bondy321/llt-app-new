const EMPTY_URI_STRINGS = new Set(['null', 'undefined', '[object object]']);
const LOADABLE_URI_PATTERN = /^(https?:\/\/|file:\/\/|content:\/\/|asset:\/\/|ph:\/\/|data:image\/|blob:)/i;

const normalizePhotoUri = (value) => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized) return null;

  if (EMPTY_URI_STRINGS.has(normalized.toLowerCase())) {
    return null;
  }

  return normalized;
};

const isLoadablePhotoUri = (value) => {
  const uri = normalizePhotoUri(value);
  return Boolean(uri && LOADABLE_URI_PATTERN.test(uri));
};

const firstPhotoUri = (...values) => {
  for (const value of values) {
    const uri = normalizePhotoUri(value);
    if (isLoadablePhotoUri(uri)) return uri;
  }

  return null;
};

const resolveViewerDisplayUri = (photo) => firstPhotoUri(
  photo?.viewerUrl,
  photo?.thumbnailUrl,
  photo?.sourceUrl,
);

const resolveSaveUri = (photo) => firstPhotoUri(
  photo?.sourceUrl,
  photo?.viewerUrl,
  photo?.thumbnailUrl,
);

const resolveFullQualityUri = (photo) => firstPhotoUri(
  photo?.sourceUrl,
);

const isProcessingVariantRecord = (photo) => (
  photo?.variantStatus === 'processing'
  && !normalizePhotoUri(photo?.thumbnailUrl)
  && !normalizePhotoUri(photo?.viewerUrl)
);

const resolveThumbnailDisplayUri = (photo) => {
  if (isProcessingVariantRecord(photo)) return null;

  return (
    firstPhotoUri(
      photo?.thumbnailUrl,
      photo?.viewerUrl,
      photo?.sourceUrl,
    )
  );
};

const normalizeCacheKeyPart = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return null;

  const normalized = String(value).trim();
  if (EMPTY_URI_STRINGS.has(normalized.toLowerCase())) return null;

  return normalized.length > 0 ? normalized : null;
};

const hashCacheKey = (value) => {
  const input = String(value || '');
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(index);
    hash &= 0x7fffffff;
  }

  return hash.toString(36);
};

const normalizeCacheKeyPrefix = (value) => (
  normalizeCacheKeyPart(value)?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'viewer'
);

const buildPhotoCacheKey = (photo, variant = 'viewer') => {
  if (!photo || typeof photo !== 'object') return null;

  const variantPrefix = normalizeCacheKeyPrefix(variant);
  const version = normalizeCacheKeyPart(photo.variantVersion)
    || normalizeCacheKeyPart(photo.variantUpdatedAt)
    || 'current';

  const storagePathByVariant = {
    thumbnail: photo.thumbnailStoragePath,
    viewer: photo.viewerStoragePath,
    full: photo.storagePath,
    source: photo.storagePath,
  };
  const storagePath = normalizeCacheKeyPart(storagePathByVariant[variantPrefix])
    || normalizeCacheKeyPart(photo.storagePath);
  if (storagePath) {
    return `photo_${variantPrefix}_${hashCacheKey(`${storagePath}:v${version}`)}`;
  }

  const stableId = normalizeCacheKeyPart(photo.id)
    || normalizeCacheKeyPart(photo.idempotencyKey)
    || normalizeCacheKeyPart(resolveViewerDisplayUri(photo))
    || normalizeCacheKeyPart(resolveThumbnailDisplayUri(photo));

  return stableId ? `photo_${variantPrefix}_${hashCacheKey(`${stableId}:v${version}`)}` : null;
};

const buildNeighborPrefetchUris = ({ photos = [], currentIndex = 0, neighborDistance = 2, thumbnailsOnly = false }) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];

  const candidates = [];
  for (let offset = 1; offset <= neighborDistance; offset += 1) {
    const indexes = [currentIndex - offset, currentIndex + offset];
    indexes.forEach((idx) => {
      const photo = photos[idx];
      if (!photo) return;

      if (thumbnailsOnly) {
        const thumbnailUri = normalizePhotoUri(photo.thumbnailUrl);
        if (isLoadablePhotoUri(thumbnailUri)) {
          candidates.push(thumbnailUri);
        }
        return;
      }

      const primary = isProcessingVariantRecord(photo) ? null : resolveViewerDisplayUri(photo);
      if (primary) {
        candidates.push(primary);
      }
      const thumbnailUri = normalizePhotoUri(photo.thumbnailUrl);
      if (isLoadablePhotoUri(thumbnailUri)) {
        candidates.push(thumbnailUri);
      }
    });
  }

  return [...new Set(candidates.filter((uri) => typeof uri === 'string' && uri.length > 0))];
};

module.exports = {
  normalizePhotoUri,
  isLoadablePhotoUri,
  hashCacheKey,
  resolveViewerDisplayUri,
  resolveThumbnailDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildPhotoCacheKey,
  buildNeighborPrefetchUris,
  isProcessingVariantRecord,
};
