import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Alert,
  useWindowDimensions,
} from 'react-native';
import * as offlineSyncService from '../../services/offlineSyncService';
import * as photoService from '../../services/photoService';
import {
  createContentReport,
} from '../../services/contentModerationService';
import { createPersistenceProvider } from '../../services/persistenceProvider';
import { usePhotoGalleryData } from '../../hooks/usePhotoGalleryData';
import { usePhotoThumbnailPrefetch } from '../../hooks/usePhotoThumbnailPrefetch';
import { getCurrentAuthUser } from '../../services/authStateService';
import { getCanonicalIdentity } from '../../services/identityService';
import logger, { maskIdentifier } from '../../services/loggerService';
import { SPACING } from '../../theme';

import GroupPhotobookView from './GroupPhotobookView';
import { createGroupPhotoUploadActions } from './groupPhotoUploadActions';
import { formatPhotoDate, getPhotoTimestampMs, parseModerationMap } from './groupPhotoModel';

export default function GroupPhotobookScreen({
  onBack,
  userId,
  tourId,
  userName,
  canonicalIdentity: canonicalIdentityProp = null,
  onViewerVisibilityChange = null,
}) {
  const [photoQueueItems, setPhotoQueueItems] = useState([]);
  const [sortMode, setSortMode] = useState('newest');
  const [mineOnly, setMineOnly] = useState(false);
  const [hiddenPhotoIds, setHiddenPhotoIds] = useState({});

  // Image viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const { width: windowWidth } = useWindowDimensions();
  const thumbnailSize = useMemo(
    () => Math.max(1, Math.floor(((windowWidth || 360) - SPACING.lg * 2 - SPACING.sm * 2) / 3)),
    [windowWidth]
  );
  const thumbnailTileStyle = useMemo(
    () => [styles.imageTouchable, { width: thumbnailSize, height: thumbnailSize }],
    [thumbnailSize]
  );

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

  const currentUser = getCurrentAuthUser();
  const canonicalIdentity = useMemo(
    () => canonicalIdentityProp || getCanonicalIdentity({ authUser: currentUser, bookingData: { id: userId } }),
    [canonicalIdentityProp, currentUser, userId]
  );
  const principalId = canonicalIdentity?.principalId || userId;
  const moderationStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CONTENT_MODERATION' }), []);
  const hiddenPhotosStorageKey = useMemo(
    () => (tourId && principalId ? `hidden_group_photos_${tourId}_${principalId}` : null),
    [principalId, tourId],
  );

  useEffect(() => {
    logger.trackScreen('GroupPhotobook', {
      tourId,
      userId: maskIdentifier(principalId),
      hasCanonicalIdentity: Boolean(canonicalIdentity?.principalId),
      stableIdentityAvailable: Boolean(canonicalIdentity?.stablePassengerId),
    });
  }, [canonicalIdentity?.principalId, canonicalIdentity?.stablePassengerId, principalId, tourId]);

  useEffect(() => {
    let active = true;
    if (!hiddenPhotosStorageKey) {
      setHiddenPhotoIds({});
      return () => {
        active = false;
      };
    }

    moderationStorage.getItemAsync(hiddenPhotosStorageKey)
      .then((storedValue) => {
        if (active) setHiddenPhotoIds(parseModerationMap(storedValue));
      })
      .catch((error) => {
        logger.warn('GroupPhotobook', 'Hidden photo state restore failed', {
          tourId,
          error: error?.message || String(error),
        });
        if (active) setHiddenPhotoIds({});
      });

    return () => {
      active = false;
    };
  }, [hiddenPhotosStorageKey, moderationStorage, tourId]);

  const persistHiddenPhotoIds = useCallback((nextHiddenPhotoIds) => {
    if (!hiddenPhotosStorageKey) return;
    moderationStorage.setItemAsync(hiddenPhotosStorageKey, JSON.stringify(nextHiddenPhotoIds)).catch((error) => {
      logger.warn('GroupPhotobook', 'Hidden photo state persist failed', {
        tourId,
        error: error?.message || String(error),
      });
    });
  }, [hiddenPhotosStorageKey, moderationStorage, tourId]);

  const hidePhotoLocally = useCallback((photoId) => {
    if (!photoId) return;
    setHiddenPhotoIds((prev) => {
      const next = { ...prev, [photoId]: true };
      persistHiddenPhotoIds(next);
      return next;
    });
  }, [persistHiddenPhotoIds]);

  const addUploaderName = useCallback((photo) => ({
    ...photo,
    uploaderName: photo.uploaderName || 'Tour Member',
  }), []);

  const {
    photos,
    loading: loadingPhotos,
    refreshing,
    loadingMore,
    refresh: refreshPhotos,
    loadMore,
  } = usePhotoGalleryData({
    visibility: 'group',
    tourId,
    pageSize: 30,
    liveLimit: 30,
    mapPhoto: addUploaderName,
  });

  const prefetchVisibleThumbnails = usePhotoThumbnailPrefetch();

  useEffect(() => {
    if (!tourId) return undefined;

    const refreshPhotoQueue = async () => {
      logger.debug('GroupPhotobook', 'Group photo queue refresh started', { tourId });
      const queued = await offlineSyncService.getPhotoUploadActions({ tourId, visibility: 'group' });
      if (queued.success) {
        setPhotoQueueItems(queued.data.filter((item) => item.status !== 'completed'));
        logger.info('GroupPhotobook', 'Group photo queue refreshed', {
          tourId,
          queuedCount: queued.data.filter((item) => item.status !== 'completed').length,
          totalCount: queued.data.length,
        });
      } else {
        logger.warn('GroupPhotobook', 'Group photo queue refresh failed', {
          tourId,
          error: queued.error || 'unknown',
        });
      }
    };

    refreshPhotoQueue();
    const unsubscribe = offlineSyncService.subscribeQueuedActions((actions) => {
      const filtered = actions.filter((action) => (
        action.type === 'PHOTO_UPLOAD'
        && action.tourId === tourId
        && action?.payload?.visibility === 'group'
        && action.status !== 'completed'
      ));
      setPhotoQueueItems(filtered);
      logger.debug('GroupPhotobook', 'Group photo queue subscription update', {
        tourId,
        visibleQueuedCount: filtered.length,
        totalActionCount: actions.length,
      });
    });
    return unsubscribe;
  }, [tourId]);

  const visiblePhotos = useMemo(() => {
    const unhidden = photos.filter((photo) => !photo?.id || hiddenPhotoIds[photo.id] !== true);
    const scoped = mineOnly ? unhidden.filter((photo) => photo.userId === principalId) : unhidden;
    return [...scoped].sort((a, b) => {
      const aTs = getPhotoTimestampMs(a);
      const bTs = getPhotoTimestampMs(b);
      return sortMode === 'oldest' ? aTs - bTs : bTs - aTs;
    });
  }, [photos, hiddenPhotoIds, mineOnly, sortMode, principalId]);

  const gallerySections = useMemo(() => {
    const grouped = new Map();

    visiblePhotos.forEach((photo) => {
      const date = formatPhotoDate(photo.timestamp, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
        || 'Unknown Date';

      if (!grouped.has(date)) {
        grouped.set(date, []);
      }
      grouped.get(date).push(photo);
    });

    return Array.from(grouped.entries()).map(([title, sectionPhotos], sectionIndex) => {
      const rows = [];
      for (let i = 0; i < sectionPhotos.length; i += 3) {
        rows.push(
          sectionPhotos.slice(i, i + 3).map((photo, offset) => ({
            photo,
            photoIndexInSection: i + offset,
          }))
        );
      }

      return {
        title,
        sectionIndex,
        photos: sectionPhotos,
        data: rows,
      };
    });
  }, [visiblePhotos]);

  const viewerFlatIndexMap = useMemo(() => {
    const indexMap = {};
    let flatIndex = 0;

    gallerySections.forEach((section, groupIndex) => {
      section.photos.forEach((_, photoIndexInGroup) => {
        indexMap[`${groupIndex}:${photoIndexInGroup}`] = flatIndex;
        flatIndex += 1;
      });
    });

    return indexMap;
  }, [gallerySections]);

  // Stats
  const totalPhotos = visiblePhotos.length;
  const uniqueContributors = useMemo(() => {
    const contributors = new Set(visiblePhotos.map(p => p.userId).filter(Boolean));
    return contributors.size;
  }, [visiblePhotos]);
  const myPhotos = visiblePhotos.filter(p => p.userId === principalId).length;

  const {
    cancelUpload,
    discardUpload,
    handlePickFromGallery,
    handleTakePhoto,
    handleUpload,
    retryUpload,
    showUploadOptions,
  } = createGroupPhotoUploadActions({
    canonicalIdentity,
    caption,
    pendingImage,
    photoQueueItems,
    principalId,
    setCaption,
    setPendingImage,
    setPhotoQueueItems,
    setShowUploadModal,
    setUploading,
    tourId,
    uploading,
    userName,
  });

  const openViewer = useCallback((groupIndex, photoIndexInGroup) => {
    const flatIndex = viewerFlatIndexMap[`${groupIndex}:${photoIndexInGroup}`] ?? 0;

    logger.info('GroupPhotobook', 'Viewer opened', {
      tourId,
      groupIndex,
      photoIndexInGroup,
      flatIndex,
      visiblePhotoCount: visiblePhotos.length,
    });
    setViewerIndex(flatIndex);
    setViewerVisible(true);
  }, [tourId, viewerFlatIndexMap, visiblePhotos.length]);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    const viewablePhotos = [];
    viewableItems.forEach(({ item }) => {
      if (!Array.isArray(item)) return;
      item.forEach(({ photo }) => {
        if (photo) viewablePhotos.push(photo);
      });
    });
    prefetchVisibleThumbnails(viewablePhotos);
  }, [prefetchVisibleThumbnails]);

  const handleDeletePhoto = async (photo) => {
    try {
      logger.info('GroupPhotobook', 'Group photo delete requested', {
        tourId,
        photoId: maskIdentifier(photo?.id),
        ownedByCurrentUser: photo?.userId === principalId,
      });
      if (typeof photoService.deleteGroupPhoto === 'function') {
        await photoService.deleteGroupPhoto(tourId, photo.id, principalId);
      }
      logger.info('GroupPhotobook', 'Group photo delete completed', {
        tourId,
        photoId: maskIdentifier(photo?.id),
      });
    } catch (error) {
      logger.error('GroupPhotobook', 'Group photo delete failed', {
        tourId,
        photoId: maskIdentifier(photo?.id),
        error: error?.message || String(error),
      });
      const msg = error.message === 'You can only delete your own photos'
        ? 'You can only delete photos you uploaded.'
        : 'Could not delete the photo. Please try again.';
      Alert.alert('Error', msg);
    }
  };

  const handleReportPhoto = useCallback(async (photo, reason) => {
    if (!photo?.id) {
      return { success: false, error: 'Photo unavailable' };
    }

    const reportResult = await createContentReport({
      tourId,
      contentType: 'group_photo',
      contentId: photo.id,
      reason,
      reporterId: principalId,
      reporterAuthUid: auth?.currentUser?.uid || principalId,
      reporterName: userName || 'Tour member',
      contentOwnerId: photo.userId || '',
      contentOwnerName: photo.uploaderName || 'Tour member',
      contentPreview: photo.caption || 'Group photo',
      sourcePath: `group_tour_photos/${tourId}/${photo.id}`,
    });

    if (reportResult.success) {
      hidePhotoLocally(photo.id);
      logger.info('GroupPhotobook', 'Group photo report submitted', {
        tourId,
        photoId: maskIdentifier(photo.id),
        reportId: reportResult.reportId,
      });
    } else {
      logger.warn('GroupPhotobook', 'Group photo report failed', {
        tourId,
        photoId: maskIdentifier(photo.id),
        error: reportResult.error || 'unknown',
      });
    }

    return reportResult;
  }, [hidePhotoLocally, principalId, tourId, userName]);

  const onRefresh = useCallback(() => {
    logger.info('GroupPhotobook', 'Gallery refresh requested', { tourId });
    return refreshPhotos();
  }, [refreshPhotos, tourId]);

  return (
    <GroupPhotobookView
      caption={caption}
      cancelUpload={cancelUpload}
      discardUpload={discardUpload}
      gallerySections={gallerySections}
      handleDeletePhoto={handleDeletePhoto}
      handlePickFromGallery={handlePickFromGallery}
      handleReportPhoto={handleReportPhoto}
      handleTakePhoto={handleTakePhoto}
      handleUpload={handleUpload}
      loadMore={loadMore}
      loadingMore={loadingMore}
      loadingPhotos={loadingPhotos}
      mineOnly={mineOnly}
      myPhotos={myPhotos}
      onBack={onBack}
      onRefresh={onRefresh}
      onViewableItemsChanged={onViewableItemsChanged}
      openViewer={openViewer}
      pendingImage={pendingImage}
      photoQueueItems={photoQueueItems}
      principalId={principalId}
      refreshing={refreshing}
      retryUpload={retryUpload}
      setCaption={setCaption}
      setMineOnly={setMineOnly}
      setSortMode={setSortMode}
      setViewerVisible={setViewerVisible}
      showUploadModal={showUploadModal}
      showUploadOptions={showUploadOptions}
      sortMode={sortMode}
      thumbnailTileStyle={thumbnailTileStyle}
      totalPhotos={totalPhotos}
      tourId={tourId}
      uniqueContributors={uniqueContributors}
      uploading={uploading}
      viewerIndex={viewerIndex}
      viewerVisible={viewerVisible}
      visiblePhotos={visiblePhotos}
    />
  );
}
