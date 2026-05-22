const resolveViewerDisplayUri = (photo) => (
  photo?.viewerUrl
  || photo?.thumbnailUrl
  || photo?.sourceUrl
  || photo?.url
  || photo?.fullUrl
  || null
);

const resolveSaveUri = (photo) => (
  photo?.fullUrl
  || photo?.url
  || photo?.viewerUrl
  || photo?.thumbnailUrl
  || null
);

const resolveFullQualityUri = (photo) => (
  photo?.fullUrl
  || photo?.url
  || null
);

const isProcessingVariantRecord = (photo) => (
  photo?.variantStatus === 'processing'
  && !photo?.thumbnailUrl
  && !photo?.viewerUrl
);

const resolveThumbnailDisplayUri = (photo) => {
  if (isProcessingVariantRecord(photo)) return null;

  return (
    photo?.thumbnailUrl
    || photo?.viewerUrl
    || photo?.sourceUrl
    || photo?.url
    || photo?.fullUrl
    || null
  );
};

const normalizeCacheKeyPart = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
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
        if (photo.thumbnailUrl) {
          candidates.push(photo.thumbnailUrl);
        }
        return;
      }

      const primary = isProcessingVariantRecord(photo) ? null : resolveViewerDisplayUri(photo);
      if (primary) {
        candidates.push(primary);
      }
      if (photo.thumbnailUrl) {
        candidates.push(photo.thumbnailUrl);
      }
    });
  }

  return [...new Set(candidates.filter((uri) => typeof uri === 'string' && uri.length > 0))];
};

module.exports = {
  resolveViewerDisplayUri,
  resolveThumbnailDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildPhotoCacheKey,
  buildNeighborPrefetchUris,
  isProcessingVariantRecord,
};
