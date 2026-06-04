const normalizeTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const photoSortKey = (photo) => ({
  timestamp: normalizeTimestamp(photo?.timestamp),
  id: typeof photo?.id === 'string' ? photo.id : '',
});

const sortPhotosDescending = (photos) => (
  [...photos].sort((a, b) => {
    const aKey = photoSortKey(a);
    const bKey = photoSortKey(b);
    if (bKey.timestamp !== aKey.timestamp) return bKey.timestamp - aKey.timestamp;
    return bKey.id.localeCompare(aKey.id);
  })
);

const mergePhotoLists = (...photoLists) => {
  const byId = new Map();
  photoLists.flat().forEach((photo, index) => {
    if (!photo || typeof photo !== 'object') return;
    const id = typeof photo.id === 'string' && photo.id.length > 0
      ? photo.id
      : `${photo.timestamp || 0}:${photo.sourceUrl || photo.viewerUrl || photo.thumbnailUrl || index}`;
    byId.set(id, {
      ...(byId.get(id) || {}),
      ...photo,
      id,
    });
  });
  return sortPhotosDescending([...byId.values()]);
};

const mergeLivePhotoWindow = (existingPhotos = [], livePhotos = []) => {
  if (!Array.isArray(livePhotos) || livePhotos.length === 0) {
    return [];
  }

  const liveIds = new Set(livePhotos.map((photo) => photo?.id).filter(Boolean));
  const liveTimestamps = livePhotos.map((photo) => normalizeTimestamp(photo?.timestamp));
  const oldestLiveTimestamp = Math.min(...liveTimestamps);

  const olderExistingPhotos = (Array.isArray(existingPhotos) ? existingPhotos : []).filter((photo) => {
    if (!photo?.id) return false;
    if (liveIds.has(photo.id)) return false;
    return normalizeTimestamp(photo.timestamp) < oldestLiveTimestamp;
  });

  return mergePhotoLists(olderExistingPhotos, livePhotos);
};

module.exports = {
  mergePhotoLists,
  mergeLivePhotoWindow,
  normalizeTimestamp,
  sortPhotosDescending,
};
