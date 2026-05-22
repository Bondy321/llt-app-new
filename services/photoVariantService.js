const EMPTY_URI_STRINGS = new Set(['null', 'undefined', '[object object]']);

const normalizePhotoUri = (value) => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized) return null;

  if (EMPTY_URI_STRINGS.has(normalized.toLowerCase())) {
    return null;
  }

  return normalized;
};

const firstPhotoUri = (...values) => {
  for (const value of values) {
    const uri = normalizePhotoUri(value);
    if (uri) return uri;
  }

  return null;
};

const resolveViewerDisplayUri = (photo) => firstPhotoUri(
  photo?.viewerUrl,
  photo?.thumbnailUrl,
  photo?.sourceUrl,
  photo?.url,
  photo?.fullUrl,
);

const resolveSaveUri = (photo) => firstPhotoUri(
  photo?.fullUrl,
  photo?.url,
  photo?.viewerUrl,
  photo?.thumbnailUrl,
);

const resolveFullQualityUri = (photo) => firstPhotoUri(
  photo?.fullUrl,
  photo?.url,
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
      photo?.url,
      photo?.fullUrl,
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

const buildPhotoCacheKey = (photo, variant = 'viewer') => {
  if (!photo || typeof photo !== 'object') return null;

  const variantPrefix = normalizeCacheKeyPart(variant) || 'viewer';
  const version = normalizeCacheKeyPart(photo.variantVersion)
    || normalizeCacheKeyPart(photo.variantUpdatedAt)
    || 'legacy';

  const storagePathByVariant = {
    thumbnail: photo.thumbnailStoragePath,
    viewer: photo.viewerStoragePath,
    full: photo.storagePath,
    source: photo.storagePath,
  };
  const storagePath = normalizeCacheKeyPart(storagePathByVariant[variantPrefix])
    || normalizeCacheKeyPart(photo.storagePath);
  if (storagePath) {
    return `${variantPrefix}:${storagePath}:v${version}`;
  }

  const stableId = normalizeCacheKeyPart(photo.id)
    || normalizeCacheKeyPart(photo.idempotencyKey)
    || normalizeCacheKeyPart(resolveViewerDisplayUri(photo))
    || normalizeCacheKeyPart(resolveThumbnailDisplayUri(photo));

  return stableId ? `${variantPrefix}:${stableId}:v${version}` : null;
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
        if (thumbnailUri) {
          candidates.push(thumbnailUri);
        }
        return;
      }

      const primary = isProcessingVariantRecord(photo) ? null : resolveViewerDisplayUri(photo);
      if (primary) {
        candidates.push(primary);
      }
      const thumbnailUri = normalizePhotoUri(photo.thumbnailUrl);
      if (thumbnailUri) {
        candidates.push(thumbnailUri);
      }
    });
  }

  return [...new Set(candidates.filter((uri) => typeof uri === 'string' && uri.length > 0))];
};

module.exports = {
  normalizePhotoUri,
  resolveViewerDisplayUri,
  resolveThumbnailDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildPhotoCacheKey,
  buildNeighborPrefetchUris,
  isProcessingVariantRecord,
};
