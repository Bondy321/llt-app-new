import { useCallback, useRef } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { selectThumbnailPrefetchBatch } from '../services/photoThumbnailPrefetchPlanner';

export const usePhotoThumbnailPrefetch = ({ maxBatchSize = 12, enabled = true } = {}) => {
  const prefetchedUrisRef = useRef(new Set());

  return useCallback((photos = []) => {
    if (!enabled) return;

    const uris = selectThumbnailPrefetchBatch({
      photos,
      prefetchedUris: prefetchedUrisRef.current,
      maxBatchSize,
    });

    if (uris.length === 0) return;

    uris.forEach((uri) => {
      prefetchedUrisRef.current.add(uri);
    });

    try {
      ExpoImage.prefetch(uris, 'memory-disk').catch(() => {
        uris.forEach((uri) => {
          prefetchedUrisRef.current.delete(uri);
        });
      });
    } catch (error) {
      uris.forEach((uri) => {
        prefetchedUrisRef.current.delete(uri);
      });
    }
  }, [enabled, maxBatchSize]);
};
