const { resolveThumbnailDisplayUri } = require('./photoVariantService');

const selectThumbnailPrefetchBatch = ({
  photos = [],
  prefetchedUris = new Set(),
  maxBatchSize = 12,
} = {}) => {
  if (!Array.isArray(photos) || maxBatchSize <= 0) return [];

  const selected = [];
  const seenInBatch = new Set();

  for (const photo of photos) {
    if (selected.length >= maxBatchSize) break;

    const uri = resolveThumbnailDisplayUri(photo);
    if (
      typeof uri !== 'string'
      || uri.length === 0
      || prefetchedUris.has(uri)
      || seenInBatch.has(uri)
    ) {
      continue;
    }

    selected.push(uri);
    seenInBatch.add(uri);
  }

  return selected;
};

module.exports = {
  selectThumbnailPrefetchBatch,
};
