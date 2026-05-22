import { useCallback, useEffect, useRef, useState } from 'react';
import * as photoService from '../services/photoService';
import {
  mergeLivePhotoWindow,
  mergePhotoLists,
} from '../services/photoGalleryMergeService';

const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_LIVE_LIMIT = 30;

const mapPhotos = (photos, mapper) => {
  const safePhotos = Array.isArray(photos) ? photos : [];
  return typeof mapper === 'function' ? safePhotos.map(mapper) : safePhotos;
};

export const usePhotoGalleryData = ({
  visibility,
  tourId,
  ownerId = null,
  pageSize = DEFAULT_PAGE_SIZE,
  liveLimit = DEFAULT_LIVE_LIMIT,
  beforeLoad = null,
  mapPhoto = null,
  enabled = true,
} = {}) => {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const requestSeqRef = useRef(0);

  const canLoad = Boolean(enabled && tourId && (visibility !== 'private' || ownerId));

  const fetchPage = useCallback(async ({ cursor = null } = {}) => {
    if (visibility === 'private') {
      return photoService.fetchPrivatePhotosPage({
        tourId,
        ownerId,
        limit: pageSize,
        endBefore: cursor,
      });
    }

    return photoService.fetchTourPhotosPage({
      tourId,
      limit: pageSize,
      endBefore: cursor,
    });
  }, [ownerId, pageSize, tourId, visibility]);

  const loadInitial = useCallback(async ({ refresh = false } = {}) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    if (!canLoad) {
      setPhotos([]);
      setNextCursor(null);
      setHasMore(false);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      if (typeof beforeLoad === 'function') {
        await beforeLoad();
      }
      const result = await fetchPage();
      if (requestSeqRef.current !== requestSeq) return;

      const mappedItems = mapPhotos(result?.items, mapPhoto);
      setPhotos((currentPhotos) => (refresh ? mappedItems : mergePhotoLists(mappedItems, currentPhotos)));
      setNextCursor(result?.nextCursor || null);
      setHasMore(Boolean(result?.hasMore));
      setError(null);
    } catch (loadError) {
      if (requestSeqRef.current === requestSeq) {
        setError(loadError);
      }
    } finally {
      if (requestSeqRef.current === requestSeq) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beforeLoad, canLoad, fetchPage, mapPhoto]);

  const loadMore = useCallback(async () => {
    if (!canLoad || loadingMore || !hasMore || !nextCursor) return;
    setLoadingMore(true);

    try {
      const result = await fetchPage({ cursor: nextCursor });
      const mappedItems = mapPhotos(result?.items, mapPhoto);
      setPhotos((currentPhotos) => mergePhotoLists(currentPhotos, mappedItems));
      setNextCursor(result?.nextCursor || null);
      setHasMore(Boolean(result?.hasMore));
      setError(null);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoadingMore(false);
    }
  }, [canLoad, fetchPage, hasMore, loadingMore, mapPhoto, nextCursor]);

  const refresh = useCallback(() => loadInitial({ refresh: true }), [loadInitial]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!canLoad) return undefined;

    let unsubscribe = null;
    let cancelled = false;

    const subscribe = async () => {
      try {
        if (typeof beforeLoad === 'function') {
          await beforeLoad();
        }
        if (cancelled) return;

        const onLivePhotos = (livePhotos) => {
          const mappedPhotos = mapPhotos(livePhotos, mapPhoto);
          setPhotos((currentPhotos) => mergeLivePhotoWindow(currentPhotos, mappedPhotos));
          setLoading(false);
          setRefreshing(false);
          setError(null);
        };

        unsubscribe = visibility === 'private'
          ? photoService.subscribeToPrivatePhotos(tourId, ownerId, onLivePhotos, { limit: liveLimit })
          : photoService.subscribeToTourPhotos(tourId, onLivePhotos, { limit: liveLimit });
      } catch (subscribeError) {
        if (!cancelled) {
          setError(subscribeError);
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    subscribe();

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [beforeLoad, canLoad, liveLimit, mapPhoto, ownerId, tourId, visibility]);

  return {
    photos,
    loading,
    refreshing,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
  };
};
