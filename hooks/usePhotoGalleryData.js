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
  trace = null,
} = {}) => {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const requestSeqRef = useRef(0);
  const loadMoreSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const canLoad = Boolean(enabled && tourId && (visibility !== 'private' || ownerId));
  const emitTrace = useCallback((event, data = {}, options = {}) => {
    if (typeof trace !== 'function') return;
    try {
      trace(event, {
        visibility,
        hasTourId: Boolean(tourId),
        hasOwnerId: Boolean(ownerId),
        canLoad,
        ...data,
      }, options);
    } catch {
      // Tracing must never affect gallery behavior.
    }
  }, [canLoad, ownerId, tourId, trace, visibility]);

  useEffect(() => () => {
    mountedRef.current = false;
    requestSeqRef.current += 1;
    loadMoreSeqRef.current += 1;
  }, []);

  const fetchPage = useCallback(async ({ cursor = null } = {}) => {
    emitTrace('fetch_page_start', {
      hasCursor: Boolean(cursor),
      cursor,
      pageSize,
    });

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
  }, [emitTrace, ownerId, pageSize, tourId, visibility]);

  const loadInitial = useCallback(async ({ refresh = false } = {}) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    if (!mountedRef.current) return;

    if (!canLoad) {
      if (!mountedRef.current) return;
      emitTrace('load_initial_skipped', { refresh }, { remote: true });
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
        emitTrace('before_load_start', { refresh });
        await beforeLoad();
        emitTrace('before_load_success', { refresh });
      }
      const result = await fetchPage();
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;

      const mappedItems = mapPhotos(result?.items, mapPhoto);
      emitTrace('load_initial_success', {
        refresh,
        itemCount: result?.items?.length || 0,
        mappedCount: mappedItems.length,
        hasMore: Boolean(result?.hasMore),
        nextCursor: result?.nextCursor || null,
      }, { remote: true });
      setPhotos((currentPhotos) => (refresh ? mappedItems : mergePhotoLists(mappedItems, currentPhotos)));
      setNextCursor(result?.nextCursor || null);
      setHasMore(Boolean(result?.hasMore));
      setError(null);
    } catch (loadError) {
      if (mountedRef.current && requestSeqRef.current === requestSeq) {
        emitTrace('load_initial_error', {
          refresh,
          error: loadError?.message,
          stack: loadError?.stack,
        }, { remote: true });
        setError(loadError);
      }
    } finally {
      if (mountedRef.current && requestSeqRef.current === requestSeq) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beforeLoad, canLoad, emitTrace, fetchPage, mapPhoto]);

  const loadMore = useCallback(async () => {
    if (!canLoad || loadingMore || !hasMore || !nextCursor) return;
    if (!mountedRef.current) return;

    const loadMoreSeq = loadMoreSeqRef.current + 1;
    loadMoreSeqRef.current = loadMoreSeq;
    setLoadingMore(true);

    try {
      const result = await fetchPage({ cursor: nextCursor });
      if (!mountedRef.current || loadMoreSeqRef.current !== loadMoreSeq) return;

      const mappedItems = mapPhotos(result?.items, mapPhoto);
      emitTrace('load_more_success', {
        itemCount: result?.items?.length || 0,
        mappedCount: mappedItems.length,
        hasMore: Boolean(result?.hasMore),
        nextCursor: result?.nextCursor || null,
      });
      setPhotos((currentPhotos) => mergePhotoLists(currentPhotos, mappedItems));
      setNextCursor(result?.nextCursor || null);
      setHasMore(Boolean(result?.hasMore));
      setError(null);
    } catch (loadError) {
      if (!mountedRef.current || loadMoreSeqRef.current !== loadMoreSeq) return;

      emitTrace('load_more_error', {
        error: loadError?.message,
        stack: loadError?.stack,
      }, { remote: true });
      setError(loadError);
    } finally {
      if (mountedRef.current && loadMoreSeqRef.current === loadMoreSeq) {
        setLoadingMore(false);
      }
    }
  }, [canLoad, emitTrace, fetchPage, hasMore, loadingMore, mapPhoto, nextCursor]);

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
          emitTrace('subscribe_before_load_start');
          await beforeLoad();
          emitTrace('subscribe_before_load_success');
        }
        if (cancelled) return;

        const onLivePhotos = (livePhotos) => {
          if (cancelled || !mountedRef.current) return;

          const mappedPhotos = mapPhotos(livePhotos, mapPhoto);
          emitTrace('live_photos_received', {
            liveCount: Array.isArray(livePhotos) ? livePhotos.length : 0,
            mappedCount: mappedPhotos.length,
          }, { remote: true });
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
          emitTrace('subscribe_error', {
            error: subscribeError?.message,
            stack: subscribeError?.stack,
          }, { remote: true });
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
        emitTrace('unsubscribe');
        unsubscribe();
      }
    };
  }, [beforeLoad, canLoad, emitTrace, liveLimit, mapPhoto, ownerId, tourId, visibility]);

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
