// Enhanced personal photobook with date grouping, camera capture, captions, and premium viewing experience
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Alert,
  useWindowDimensions,
} from 'react-native';
import * as offlineSyncService from '../../services/offlineSyncService';
import * as photoService from '../../services/photoService';
import { usePhotoGalleryData } from '../../hooks/usePhotoGalleryData';
import { usePhotoThumbnailPrefetch } from '../../hooks/usePhotoThumbnailPrefetch';
import {
  isLoadablePhotoUri,
  resolveThumbnailDisplayUri,
  resolveViewerDisplayUri,
} from '../../services/photoVariantService';
import { getCurrentAuthUser, updateCurrentAuthUserProfile } from '../../services/authStateService';
import logger, { maskIdentifier } from '../../services/loggerService';
import { getCanonicalIdentity, toRealtimeKeySegment } from '../../services/identityService';
import {
  recordBreadcrumb as recordCrashBreadcrumb,
  setDiagnosticsContext,
  summarizePhotoRecord,
  summarizeQueueAction,
} from '../../services/crashDiagnosticsService';
import { SPACING } from '../../theme';

import PhotobookView from './PhotobookView';
import { createPrivatePhotoUploadActions } from './privatePhotoUploadActions';
import {
  formatPhotoDate, getPhotoTimestampMs, summarizePhotos, summarizeQueue, summarizeRealtimeKey,
  verifyQueuedUploadSource,
} from './privatePhotoModel';
export default function PhotobookScreen({
  onBack,
  tourId,
  privatePhotoOwnerId,
  stablePassengerId,
  canonicalIdentity: canonicalIdentityProp = null,
  onViewerVisibilityChange = null,
}) {
  const [photoQueueItems, setPhotoQueueItems] = useState([]);
  const [sortMode, setSortMode] = useState('newest');

  // Image viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  useEffect(() => {
    if (typeof onViewerVisibilityChange === 'function') {
      onViewerVisibilityChange(viewerVisible);
    }
  }, [onViewerVisibilityChange, viewerVisible]);

  useEffect(() => {
    return () => {
      if (typeof onViewerVisibilityChange === 'function') {
        onViewerVisibilityChange(false);
      }
    };
  }, [onViewerVisibilityChange]);

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const renderStateSeqRef = useRef(0);
  const imageEventCountsRef = useRef({});
  const { width: windowWidth } = useWindowDimensions();
  const thumbnailSize = useMemo(
    () => Math.max(1, Math.floor(((windowWidth || 360) - SPACING.lg * 2 - SPACING.sm * 2) / 3)),
    [windowWidth]
  );
  const thumbnailTileStyle = useMemo(
    () => [styles.imageTouchable, { width: thumbnailSize, height: thumbnailSize }],
    [thumbnailSize]
  );

  const currentUser = getCurrentAuthUser();
  const canonicalIdentity = useMemo(
    () => canonicalIdentityProp || getCanonicalIdentity({ authUser: currentUser, bookingData: { id: stablePassengerId || privatePhotoOwnerId, stablePassengerId: stablePassengerId || null } }),
    [canonicalIdentityProp, currentUser, privatePhotoOwnerId, stablePassengerId]
  );
  const principalId = canonicalIdentity?.principalId || stablePassengerId || privatePhotoOwnerId;
  const authUid = currentUser?.uid || null;
  const stablePrivateOwnerId = stablePassengerId || canonicalIdentity?.stablePassengerId || null;
  const privatePhotoOwnerKey = principalId ? toRealtimeKeySegment(principalId) : null;
  const stablePrivateOwnerKey = stablePrivateOwnerId ? toRealtimeKeySegment(stablePrivateOwnerId) : null;

  const tracePrivatePhotos = useCallback((event, data = {}, options = {}) => {
    recordCrashBreadcrumb('PrivatePhotobook', event, {
      tourId,
      principalId: maskIdentifier(principalId),
      authUid,
      stablePrivateOwnerId: maskIdentifier(stablePrivateOwnerId),
      ownerKeySummary: summarizeRealtimeKey(privatePhotoOwnerKey),
      stableOwnerKeySummary: summarizeRealtimeKey(stablePrivateOwnerKey),
      ...data,
    }, {
      remote: true,
      ...options,
    });
  }, [authUid, principalId, privatePhotoOwnerKey, stablePrivateOwnerId, stablePrivateOwnerKey, tourId]);

  useEffect(() => {
    tracePrivatePhotos('screen_mounted', {
      hasTourId: Boolean(tourId),
      hasPrivatePhotoOwnerId: Boolean(privatePhotoOwnerId),
      hasStablePassengerId: Boolean(stablePassengerId),
      hasCanonicalIdentityProp: Boolean(canonicalIdentityProp),
    }, { flush: true });

    return () => {
      tracePrivatePhotos('screen_unmounted', {
        lastRenderSeq: renderStateSeqRef.current,
      }, { remote: true });
    };
  }, [canonicalIdentityProp, privatePhotoOwnerId, stablePassengerId, tourId, tracePrivatePhotos]);

  useEffect(() => {
    setDiagnosticsContext('privatePhotobookIdentity', {
      tourId,
      principalId: maskIdentifier(principalId),
      authUid,
      stablePrivateOwnerId: maskIdentifier(stablePrivateOwnerId),
      privatePhotoOwnerId: maskIdentifier(privatePhotoOwnerId),
      stablePassengerId: maskIdentifier(stablePassengerId),
      canonicalIdentity: canonicalIdentity
        ? {
            principalId: maskIdentifier(canonicalIdentity.principalId),
            principalType: canonicalIdentity.principalType || null,
            hasAuthUid: Boolean(canonicalIdentity.authUid),
            stablePassengerId: maskIdentifier(canonicalIdentity.stablePassengerId),
          }
        : null,
      privatePhotoOwnerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
      stablePrivateOwnerKey: summarizeRealtimeKey(stablePrivateOwnerKey),
    }, { flush: true });

    tracePrivatePhotos('identity_resolved', {
      hasPrincipalId: Boolean(principalId),
      principalMatchesStable: Boolean(principalId && stablePrivateOwnerId && principalId === stablePrivateOwnerId),
      principalKeyMatchesStableKey: Boolean(privatePhotoOwnerKey && stablePrivateOwnerKey && privatePhotoOwnerKey === stablePrivateOwnerKey),
      ownerInputs: {
        privatePhotoOwnerId: maskIdentifier(privatePhotoOwnerId),
        stablePassengerId: maskIdentifier(stablePassengerId),
      },
      canonicalIdentity: canonicalIdentity
        ? {
            principalId: maskIdentifier(canonicalIdentity.principalId),
            principalType: canonicalIdentity.principalType || null,
            hasAuthUid: Boolean(canonicalIdentity.authUid),
            stablePassengerId: maskIdentifier(canonicalIdentity.stablePassengerId),
          }
        : null,
    });
  }, [authUid, canonicalIdentity, principalId, privatePhotoOwnerId, privatePhotoOwnerKey, stablePassengerId, stablePrivateOwnerId, stablePrivateOwnerKey, tourId, tracePrivatePhotos]);

  const ensurePrivatePhotoOwnerAccess = useCallback(async () => {
    const currentAuthUid = getCurrentAuthUser()?.uid;
    if (!currentAuthUid || !principalId || !stablePrivateOwnerId) {
      tracePrivatePhotos('ensure_owner_access_skipped', {
        hasCurrentAuthUid: Boolean(currentAuthUid),
        hasPrincipalId: Boolean(principalId),
        hasStablePrivateOwnerId: Boolean(stablePrivateOwnerId),
        hasRealtimeDb: true,
      });
      return;
    }

    try {
      tracePrivatePhotos('ensure_owner_access_start', {
        currentAuthUid,
        privatePhotoOwnerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
        stablePrivateOwnerKey: summarizeRealtimeKey(stablePrivateOwnerKey),
      });
      const updates = {
        privatePhotoOwnerId: principalId,
        privatePhotoOwnerKey,
        privatePhotoOwnerType: 'stable_passenger',
        lastUpdated: Date.now(),
        stablePassengerId: stablePrivateOwnerId,
        stablePassengerKey: stablePrivateOwnerKey,
      };

      await updateCurrentAuthUserProfile(updates);
      tracePrivatePhotos('ensure_owner_access_success', {
        currentAuthUid,
        updateKeys: Object.keys(updates),
        privatePhotoOwnerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
      });
    } catch (error) {
      tracePrivatePhotos('ensure_owner_access_error', {
        error: error?.message,
        code: error?.code || null,
        stack: error?.stack,
      }, { flush: true });
      logger.error('Photobook', 'Failed to refresh private photo owner identity before private photo access', {
        error: error.message,
        code: error?.code || null,
        authUid: currentAuthUid,
        privatePhotoOwnerId: maskIdentifier(principalId),
        privatePhotoOwnerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
        tourId,
      });
    }
  }, [principalId, privatePhotoOwnerKey, stablePrivateOwnerId, stablePrivateOwnerKey, tourId, tracePrivatePhotos]);

  const mapPrivatePhoto = useCallback((photo) => {
    const sourcePhoto = photo || {};
    const hasDisplayVariant = isLoadablePhotoUri(sourcePhoto.viewerUrl)
      || isLoadablePhotoUri(sourcePhoto.thumbnailUrl);
    const nextPhoto = {
      ...sourcePhoto,
      originalUserId: typeof sourcePhoto?.userId === 'string' ? sourcePhoto.userId : null,
      userId: principalId || sourcePhoto?.userId || authUid || null,
      privateOwnerId: principalId || null,
    };

    if (!hasDisplayVariant) {
      delete nextPhoto.sourceUrl;
      nextPhoto.variantStatus = sourcePhoto.variantStatus || 'processing';
      nextPhoto.displayVariantUnavailable = true;
    }

    tracePrivatePhotos('map_private_photo', {
      hasDisplayVariant,
      source: summarizePhotoRecord(sourcePhoto),
      mapped: summarizePhotoRecord(nextPhoto),
    });

    return nextPhoto;
  }, [authUid, principalId, tracePrivatePhotos]);

  const {
    photos,
    loading: loadingPhotos,
    refreshing,
    loadingMore,
    error: photoLoadError,
    refresh: refreshPhotos,
    loadMore,
  } = usePhotoGalleryData({
    visibility: 'private',
    tourId,
    ownerId: principalId,
    beforeLoad: ensurePrivatePhotoOwnerAccess,
    mapPhoto: mapPrivatePhoto,
    pageSize: 30,
    liveLimit: 30,
    trace: tracePrivatePhotos,
  });

  const prefetchVisibleThumbnails = usePhotoThumbnailPrefetch({ enabled: false });

  const isScopedPrivatePhotoUpload = useCallback((action) => (
    action?.type === 'PHOTO_UPLOAD'
    && action.tourId === tourId
    && action?.payload?.visibility === 'private'
    && (action?.payload?.ownerId === principalId || action?.payload?.userId === principalId)
    && action.status !== 'completed'
  ), [principalId, tourId]);

  const reconcilePhotoQueueItems = useCallback(async (actions = []) => {
    const scopedActions = actions.filter(isScopedPrivatePhotoUpload);
    const usableActions = [];
    tracePrivatePhotos('queue_reconcile_start', {
      incomingCount: Array.isArray(actions) ? actions.length : 0,
      scopedCount: scopedActions.length,
      scopedActions: summarizeQueue(scopedActions),
    });

    for (const action of scopedActions) {
      const sourceStatus = await verifyQueuedUploadSource(action);
      tracePrivatePhotos('queue_item_verified', {
        sourceStatus,
        action: summarizeQueueAction(action),
      });
      if (!sourceStatus.recoverable) {
        logger.warn('Photobook', 'Removing unrecoverable private photo upload from offline queue', {
          actionId: action?.id || null,
          reason: sourceStatus.reason,
          status: action?.status || null,
          tourId,
        });
        if (action?.id) {
          await offlineSyncService.removeAction(action.id);
        }
        continue;
      }

      usableActions.push(action);
    }

    tracePrivatePhotos('queue_reconcile_done', {
      usableCount: usableActions.length,
      usableActions: summarizeQueue(usableActions),
    }, { remote: true });

    return usableActions;
  }, [isScopedPrivatePhotoUpload, tourId, tracePrivatePhotos]);

  useEffect(() => {
    if (!tourId || !principalId) return undefined;
    let cancelled = false;

    const applyQueueItems = async (actions) => {
      try {
        const nextItems = await reconcilePhotoQueueItems(actions);
        if (!cancelled) {
          tracePrivatePhotos('queue_items_applied', {
            count: nextItems.length,
            items: summarizeQueue(nextItems),
          });
          setPhotoQueueItems(nextItems);
        }
      } catch (error) {
        tracePrivatePhotos('queue_reconcile_error', {
          error: error?.message,
          stack: error?.stack,
        }, { flush: true });
        logger.warn('Photobook', 'Failed to reconcile private photo upload queue', { error: error?.message });
      }
    };

    const refreshPhotoQueue = async () => {
      const queued = await offlineSyncService.getPhotoUploadActions({ tourId, visibility: 'private', ownerId: principalId });
      if (queued.success) {
        await applyQueueItems(queued.data);
      }
    };

    refreshPhotoQueue();
    const unsubscribe = offlineSyncService.subscribeQueuedActions((actions) => {
      applyQueueItems(actions);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [principalId, reconcilePhotoQueueItems, tourId, tracePrivatePhotos]);

  const visiblePhotos = useMemo(() => {
    const sorted = [...photos].sort((a, b) => {
      const aTs = getPhotoTimestampMs(a);
      const bTs = getPhotoTimestampMs(b);
      return sortMode === 'oldest' ? aTs - bTs : bTs - aTs;
    });
    return sorted;
  }, [photos, sortMode]);

  const hasDisplayablePhoto = useCallback((photo) => Boolean(
    resolveThumbnailDisplayUri(photo) || resolveViewerDisplayUri(photo)
  ), []);

  const albumSectionsData = useMemo(() => {
    const grouped = {};
    const photoIndexById = {};

    visiblePhotos.forEach((photo, index) => {
      if (photo?.id) {
        photoIndexById[photo.id] = index;
      }

      const dateKey = formatPhotoDate(photo.timestamp, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
        || 'Unknown Date';

      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }

      grouped[dateKey].push(photo);
    });

    const dateKeys = Object.keys(grouped);
    const sections = dateKeys.map((dateKey) => {
      const photosForDate = grouped[dateKey];
      const rows = [];

      for (let i = 0; i < photosForDate.length; i += 3) {
        rows.push(photosForDate.slice(i, i + 3));
      }

      return {
        title: dateKey,
        photoCount: photosForDate.length,
        data: rows,
      };
    });

    return {
      sections,
      dateKeys,
      photoIndexById,
      totalPhotos: visiblePhotos.length,
      latestPhotoDate: formatPhotoDate(visiblePhotos[0]?.timestamp, { month: 'short', day: 'numeric' }),
    };
  }, [visiblePhotos]);

  const {
    sections: photoSections,
    dateKeys,
    photoIndexById,
    totalPhotos,
    latestPhotoDate,
  } = albumSectionsData;

  useEffect(() => {
    renderStateSeqRef.current += 1;
    const renderState = {
      seq: renderStateSeqRef.current,
      loadingPhotos,
      refreshing,
      loadingMore,
      hasPhotoLoadError: Boolean(photoLoadError),
      photoLoadError: photoLoadError?.message || null,
      totalPhotos,
      visiblePhotoCount: visiblePhotos.length,
      rawPhotoCount: photos.length,
      queueCount: photoQueueItems.length,
      sortMode,
      dateKeys,
      sectionCount: photoSections.length,
      sectionRows: photoSections.map((section) => ({
        title: section.title,
        photoCount: section.photoCount,
        rowCount: section.data.length,
      })),
      photos: summarizePhotos(visiblePhotos),
      queue: summarizeQueue(photoQueueItems),
    };

    setDiagnosticsContext('privatePhotobookRenderState', renderState);
    tracePrivatePhotos('render_state', renderState, { remote: true });
  }, [
    dateKeys,
    loadingMore,
    loadingPhotos,
    photoLoadError,
    photoQueueItems,
    photoSections,
    photos,
    refreshing,
    sortMode,
    totalPhotos,
    tracePrivatePhotos,
    visiblePhotos,
  ]);

  const { cancelUpload, discardUpload, handlePickFromGallery, handleTakePhoto, handleUpload, retryUpload, showUploadOptions } = createPrivatePhotoUploadActions({
    canonicalIdentity,
    caption,
    pendingImage,
    principalId,
    privatePhotoOwnerKey,
    setCaption,
    setPendingImage,
    setPhotoQueueItems,
    setShowUploadModal,
    setUploading,
    tourId,
    tracePrivatePhotos,
    uploading,
  });

  const openViewer = useCallback((photoId) => {
    const flatIndex = photoIndexById[photoId];
    tracePrivatePhotos('open_viewer_requested', {
      photoId,
      flatIndex,
      photo: summarizePhotoRecord(visiblePhotos[flatIndex] || {}),
    }, { remote: true });
    if (typeof flatIndex !== 'number') return;

    setViewerIndex(flatIndex);
    setViewerVisible(true);
  }, [photoIndexById, tracePrivatePhotos, visiblePhotos]);

  const handleDeletePhoto = async (photo) => {
    try {
      tracePrivatePhotos('delete_photo_requested', {
        photo: summarizePhotoRecord(photo),
      }, { flush: true });
      if (typeof photoService.deletePrivatePhoto === 'function') {
        await photoService.deletePrivatePhoto(tourId, principalId, photo.id);
      }
      tracePrivatePhotos('delete_photo_completed', {
        photoId: maskIdentifier(photo?.id),
      }, { flush: true });
    } catch (error) {
      tracePrivatePhotos('delete_photo_failed', {
        photo: summarizePhotoRecord(photo),
        error: error?.message,
        code: error?.code || null,
        stack: error?.stack,
      }, { flush: true });
      logger.error('Photobook', 'Private photo delete failed', {
        tourId,
        principalId: maskIdentifier(principalId),
        photoId: maskIdentifier(photo?.id),
        error: error?.message,
        code: error?.code || null,
      });
      Alert.alert('Error', 'Could not delete the photo. Please try again.');
    }
  };

  const onRefresh = useCallback(() => {
    tracePrivatePhotos('gallery_refresh_requested', {
      currentPhotoCount: visiblePhotos.length,
      queueCount: photoQueueItems.length,
    });
    return refreshPhotos();
  }, [photoQueueItems.length, refreshPhotos, tracePrivatePhotos, visiblePhotos.length]);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    const viewablePhotos = [];
    viewableItems.forEach(({ item }) => {
      if (Array.isArray(item)) {
        viewablePhotos.push(...item);
      }
    });
    tracePrivatePhotos('viewable_items_changed', {
      viewableCount: viewablePhotos.length,
      photos: summarizePhotos(viewablePhotos),
    });
    prefetchVisibleThumbnails(viewablePhotos);
  }, [prefetchVisibleThumbnails, tracePrivatePhotos]);

  const recordTileImageEvent = useCallback((eventName, photo, event = null) => {
    const id = photo?.id || 'unknown';
    const counts = imageEventCountsRef.current;
    const countKey = `${eventName}:${id}`;
    counts[countKey] = (counts[countKey] || 0) + 1;

    if (counts[countKey] > 3 && eventName !== 'error') {
      return;
    }

    tracePrivatePhotos(`tile_image_${eventName}`, {
      count: counts[countKey],
      photo: summarizePhotoRecord(photo),
      nativeEvent: event?.nativeEvent
        ? {
            error: event.nativeEvent.error || null,
            source: event.nativeEvent.source || null,
          }
        : null,
    }, { remote: eventName === 'error' });
  }, [tracePrivatePhotos]);

  return (
    <PhotobookView
      cancelUpload={cancelUpload}
      caption={caption}
      dateKeys={dateKeys}
      discardUpload={discardUpload}
      handleDeletePhoto={handleDeletePhoto}
      handlePickFromGallery={handlePickFromGallery}
      handleTakePhoto={handleTakePhoto}
      handleUpload={handleUpload}
      hasDisplayablePhoto={hasDisplayablePhoto}
      latestPhotoDate={latestPhotoDate}
      loadMore={loadMore}
      loadingMore={loadingMore}
      loadingPhotos={loadingPhotos}
      onBack={onBack}
      onRefresh={onRefresh}
      onViewableItemsChanged={onViewableItemsChanged}
      openViewer={openViewer}
      pendingImage={pendingImage}
      photoLoadError={photoLoadError}
      photoQueueItems={photoQueueItems}
      photoSections={photoSections}
      principalId={principalId}
      recordTileImageEvent={recordTileImageEvent}
      refreshing={refreshing}
      retryUpload={retryUpload}
      setCaption={setCaption}
      setSortMode={setSortMode}
      setViewerVisible={setViewerVisible}
      showUploadModal={showUploadModal}
      showUploadOptions={showUploadOptions}
      sortMode={sortMode}
      thumbnailTileStyle={thumbnailTileStyle}
      totalPhotos={totalPhotos}
      tourId={tourId}
      tracePrivatePhotos={tracePrivatePhotos}
      uploading={uploading}
      viewerIndex={viewerIndex}
      viewerVisible={viewerVisible}
      visiblePhotos={visiblePhotos}
    />
  );
}
