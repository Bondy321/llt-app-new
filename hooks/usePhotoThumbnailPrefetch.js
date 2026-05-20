import { useCallback, useRef } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { resolveThumbnailDisplayUri } from '../services/photoVariantService';

export const usePhotoThumbnailPrefetch = ({ maxBatchSize = 12 } = {}) => {
  const prefetchedUrisRef = useRef(new Set());

  return useCallback((photos = []) => {
    const uris = [];
    (Array.isArray(photos) ? photos : []).forEach((photo) => {
      const uri = resolveThumbnailDisplayUri(photo);
      if (!uri || prefetchedUrisRef.current.has(uri)) return;
      prefetchedUrisRef.current.add(uri);
      uris.push(uri);
    });

    if (uris.length === 0) return;
    ExpoImage.prefetch(uris.slice(0, maxBatchSize), 'memory-disk').catch(() => {});
  }, [maxBatchSize]);
};
