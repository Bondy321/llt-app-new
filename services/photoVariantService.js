const resolveViewerDisplayUri = (photo) => (
  photo?.viewerUrl
  || photo?.url
  || photo?.fullUrl
  || photo?.thumbnailUrl
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

      const primary = resolveViewerDisplayUri(photo);
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
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
};
