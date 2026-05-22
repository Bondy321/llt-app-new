import { useCallback, useRef } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { selectThumbnailPrefetchBatch } from '../services/photoThumbnailPrefetchPlanner';

export const usePhotoThumbnailPrefetch = ({ maxBatchSize = 12 } = {}) => {
  const prefetchedUrisRef = useRef(new Set());

  return useCallback((photos = []) => {
    const uris = selectThumbnailPrefetchBatch({
      photos,
      prefetchedUris: prefetchedUrisRef.current,
      maxBatchSize,
    });

    if (uris.length === 0) return;

    uris.forEach((uri) => {
      prefetchedUrisRef.current.add(uri);
    });

    ExpoImage.prefetch(uris, 'memory-disk').catch(() => {
      uris.forEach((uri) => {
        prefetchedUrisRef.current.delete(uri);
      });
    });
  }, [maxBatchSize]);
};
