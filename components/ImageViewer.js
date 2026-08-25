// components/ImageViewer.js
// Fullscreen pager-style photo viewer with compact chrome and preserved photo actions.
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  useWindowDimensions,
  Animated,
  Share,
  Alert,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import loggerService from '../services/loggerService';
import {
  resolveViewerDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
} from '../services/photoVariantService';
import {
  clampPagerIndex,
  resolvePagerIndexFromOffset,
} from '../services/imageViewerPagerState';
import { parseTimestampMs } from '../services/timeUtils';
import { REPORT_REASON_OPTIONS } from '../services/contentModerationService';

const DEFAULT_VIEWER_WIDTH = 360;
const DEFAULT_VIEWER_HEIGHT = 640;

import ImageViewerView, { ImageViewerPage } from './image-viewer/ImageViewerView';
import { getPhotoKey, resolveText } from './image-viewer/imageViewerModel';
export default function ImageViewer({
  visible,
  photos = [],
  initialIndex = 0,
  onClose,
  onDelete,
  onReport = null,
  showUploaderInfo = false,
  canDelete = false,
  currentUserId = null,
  onEditCaption = null,
  enablePrefetch = true,
  useExpoImage = true,
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const runtimeWidth = windowWidth || DEFAULT_VIEWER_WIDTH;
  const runtimeHeight = windowHeight || DEFAULT_VIEWER_HEIGHT;
  const detailsPanelMaxHeight = Math.max(220, runtimeHeight * 0.48);
  const pagerRef = useRef(null);
  const visibleRef = useRef(false);
  const lastInitialIndexRef = useRef(initialIndex);
  const scrollRetryTimeoutRef = useRef(null);

  const safeInitialIndex = useMemo(
    () => clampPagerIndex(initialIndex, photos.length),
    [initialIndex, photos.length]
  );

  const [currentIndex, setCurrentIndex] = useState(safeInitialIndex);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [editingCaption, setEditingCaption] = useState(false);
  const [draftCaption, setDraftCaption] = useState('');
  const [captionSaving, setCaptionSaving] = useState(false);
  const [fullQualityRequestedByPhotoKey, setFullQualityRequestedByPhotoKey] = useState({});
  const [prefetchPolicy, setPrefetchPolicy] = useState({
    neighborDistance: 2,
    thumbnailsOnly: false,
  });

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const chromeAnim = useRef(new Animated.Value(1)).current;
  const detailsAnim = useRef(new Animated.Value(0)).current;

  const scrollToIndex = useCallback((index, animated = true) => {
    if (!photos.length) return;

    const targetIndex = clampPagerIndex(index, photos.length);
    setCurrentIndex(targetIndex);

    requestAnimationFrame(() => {
      pagerRef.current?.scrollToIndex({
        index: targetIndex,
        animated,
      });
    });
  }, [photos.length]);

  useEffect(() => {
    if (visible) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [fadeAnim, visible]);

  useEffect(() => {
    Animated.timing(chromeAnim, {
      toValue: chromeVisible ? 1 : 0,
      duration: 140,
      useNativeDriver: true,
    }).start();
  }, [chromeAnim, chromeVisible]);

  useEffect(() => {
    Animated.spring(detailsAnim, {
      toValue: detailsVisible ? 1 : 0,
      friction: 9,
      tension: 70,
      useNativeDriver: true,
    }).start();
  }, [detailsAnim, detailsVisible]);

  useEffect(() => {
    const wasVisible = visibleRef.current;
    const initialIndexChanged = lastInitialIndexRef.current !== initialIndex;

    if (visible && (!wasVisible || initialIndexChanged)) {
      setChromeVisible(true);
      setDetailsVisible(false);
      scrollToIndex(safeInitialIndex, false);
    }

    if (!visible) {
      setDetailsVisible(false);
      setEditingCaption(false);
      setFullQualityRequestedByPhotoKey({});
    }

    visibleRef.current = visible;
    lastInitialIndexRef.current = initialIndex;
  }, [initialIndex, safeInitialIndex, scrollToIndex, visible]);

  useEffect(() => () => {
    if (scrollRetryTimeoutRef.current) {
      clearTimeout(scrollRetryTimeoutRef.current);
      scrollRetryTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!visible || !photos.length) return;

    const clampedIndex = clampPagerIndex(currentIndex, photos.length);
    if (clampedIndex !== currentIndex) {
      scrollToIndex(clampedIndex, false);
    }
  }, [currentIndex, photos.length, scrollToIndex, visible]);

  const currentPhoto = useMemo(() => photos[currentIndex] || {}, [currentIndex, photos]);
  const currentPhotoKey = getPhotoKey(currentPhoto, currentIndex);
  const currentCaption = resolveText(currentPhoto.caption);
  const currentUploaderName = resolveText(currentPhoto.uploaderName);
  const currentViewerUri = useMemo(
    () => resolveViewerDisplayUri(currentPhoto),
    [currentPhoto]
  );
  const currentFullQualityUri = useMemo(
    () => resolveFullQualityUri(currentPhoto),
    [currentPhoto]
  );
  const fullQualityRequested = Boolean(fullQualityRequestedByPhotoKey[currentPhotoKey]);
  const canRequestFullQuality = Boolean(
    currentFullQualityUri
    && currentViewerUri
    && currentFullQualityUri !== currentViewerUri
    && !fullQualityRequested
  );

  useEffect(() => {
    let mounted = true;
    if (!visible) return () => {
      mounted = false;
    };

    NetInfo.fetch().then((state) => {
      if (!mounted) return;
      const cellularGeneration = state?.details?.cellularGeneration;
      const isWeakCellular = cellularGeneration === '2g' || cellularGeneration === '3g';
      const isConstrained = state?.type === 'cellular' || Boolean(state?.details?.isConnectionExpensive) || isWeakCellular;

      setPrefetchPolicy(isConstrained
        ? { neighborDistance: 1, thumbnailsOnly: true }
        : { neighborDistance: 2, thumbnailsOnly: false });
    }).catch(() => {});

    return () => {
      mounted = false;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !photos.length || !enablePrefetch) return undefined;

    const prefetchCandidates = buildNeighborPrefetchUris({
      photos,
      currentIndex,
      neighborDistance: prefetchPolicy.neighborDistance,
      thumbnailsOnly: prefetchPolicy.thumbnailsOnly,
    });

    if (prefetchCandidates.length > 0) {
      try {
        ExpoImage.prefetch(prefetchCandidates, 'memory-disk').catch(() => {});
      } catch (error) {
        loggerService.warn('ImageViewer', 'Photo prefetch rejected invalid candidates', { message: error?.message });
      }
    }

    return undefined;
  }, [enablePrefetch, visible, currentIndex, photos, prefetchPolicy]);

  const syncIndexFromOffset = useCallback((offsetX) => {
    const nextIndex = resolvePagerIndexFromOffset({
      offsetX,
      pageWidth: runtimeWidth,
      photoCount: photos.length,
    });

    setCurrentIndex((previousIndex) => {
      if (previousIndex !== nextIndex) {
        setDetailsVisible(false);
        setChromeVisible(true);
      }
      return nextIndex;
    });
  }, [photos.length, runtimeWidth]);

  const handleMomentumScrollEnd = useCallback((event) => {
    syncIndexFromOffset(event?.nativeEvent?.contentOffset?.x || 0);
  }, [syncIndexFromOffset]);

  const handleScrollToIndexFailed = useCallback((info) => {
    const targetIndex = clampPagerIndex(info?.index, photos.length);
    if (scrollRetryTimeoutRef.current) {
      clearTimeout(scrollRetryTimeoutRef.current);
    }

    scrollRetryTimeoutRef.current = setTimeout(() => {
      scrollRetryTimeoutRef.current = null;
      if (!visibleRef.current) return;

      pagerRef.current?.scrollToOffset({
        offset: targetIndex * runtimeWidth,
        animated: false,
      });
    }, 50);
  }, [photos.length, runtimeWidth]);

  const toggleChrome = useCallback(() => {
    if (detailsVisible) {
      setDetailsVisible(false);
      return;
    }
    setChromeVisible((value) => !value);
  }, [detailsVisible]);

  const requestFullQuality = useCallback(() => {
    if (!canRequestFullQuality || !currentPhotoKey) return;
    setFullQualityRequestedByPhotoKey((prev) => ({
      ...prev,
      [currentPhotoKey]: true,
    }));
    setChromeVisible(true);
  }, [canRequestFullQuality, currentPhotoKey]);

  const formatDate = (timestamp) => {
    const parsedMs = parseTimestampMs(timestamp);
    if (!Number.isFinite(parsedMs)) return 'Unknown date';
    const date = new Date(parsedMs);
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const resolveCurrentPhotoUri = useCallback(() => resolveSaveUri(currentPhoto), [currentPhoto]);

  const handleShare = async () => {
    try {
      await Share.share({
        message: currentCaption
          ? `${currentCaption}\n\nShared from Loch Lomond Travel`
          : 'Check out this photo from my Loch Lomond tour!',
        url: resolveCurrentPhotoUri() || undefined,
      });
    } catch (error) {
      loggerService.warn('ImageViewer', 'Share action failed', { message: error?.message });
      Alert.alert('Share unavailable', 'Unable to open share options right now. Please try again.');
    }
  };

  const handleSaveToDevice = async () => {
    try {
      setSaving(true);

      const photoUri = resolveCurrentPhotoUri();
      if (!photoUri || typeof photoUri !== 'string') {
        Alert.alert('Photo unavailable', 'This photo cannot be saved right now. Please refresh and try again.');
        return;
      }

      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to save photos to your device.');
        return;
      }

      const isLocalFile = photoUri.startsWith('file://');
      const extensionMatch = photoUri.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
      const normalizedExtension = (extensionMatch?.[1] || 'jpg').toLowerCase();
      const extension = ['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(normalizedExtension)
        ? normalizedExtension
        : 'jpg';
      const filename = `llt_photo_${Date.now()}.${extension}`;
      const fileUri = `${FileSystem.cacheDirectory || FileSystem.documentDirectory}${filename}`;

      const assetSourceUri = isLocalFile
        ? photoUri
        : (await FileSystem.downloadAsync(photoUri, fileUri)).uri;

      await MediaLibrary.saveToLibraryAsync(assetSourceUri);
      Alert.alert('Saved!', 'Photo has been saved to your device.');
    } catch (error) {
      loggerService.error('ImageViewer', 'Failed to save photo to device', { message: error?.message });
      Alert.alert('Error', 'Could not save the photo. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Photo',
      'Are you sure you want to delete this photo? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (!onDelete) return;

            onDelete(currentPhoto);
            setDetailsVisible(false);
            if (photos.length <= 1) {
              onClose();
            } else if (currentIndex >= photos.length - 1) {
              scrollToIndex(currentIndex - 1, false);
            }
          },
        },
      ]
    );
  };

  const canDeleteThis = canDelete && currentPhoto.userId === currentUserId;
  const canReportThis = typeof onReport === 'function'
    && currentPhoto?.id
    && currentPhoto.userId !== currentUserId;
  const canEditCaption = typeof onEditCaption === 'function' && currentPhoto.userId === currentUserId;

  const submitReport = async (reason) => {
    if (typeof onReport !== 'function' || !currentPhoto?.id) return;

    try {
      setReporting(true);
      const result = await onReport(currentPhoto, reason);
      if (!result?.success) {
        throw new Error(result?.error || 'Report failed');
      }
      setDetailsVisible(false);
      Alert.alert('Report sent', 'Loch Lomond Travel operations will review this photo.');
    } catch (error) {
      loggerService.warn('ImageViewer', 'Photo report failed', { message: error?.message });
      Alert.alert('Report failed', 'Please try again or contact support.');
    } finally {
      setReporting(false);
    }
  };

  const handleReport = () => {
    Alert.alert(
      'Report photo',
      'Send this photo to Loch Lomond Travel operations for review.',
      [
        ...REPORT_REASON_OPTIONS.map((option) => ({
          text: option.label,
          onPress: () => submitReport(option.key),
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const startEditCaption = () => {
    setDraftCaption(currentCaption);
    setEditingCaption(true);
  };

  const saveCaption = async () => {
    if (typeof onEditCaption !== 'function') return;

    try {
      setCaptionSaving(true);
      await onEditCaption(currentPhoto, draftCaption);
      setEditingCaption(false);
    } catch (error) {
      loggerService.warn('ImageViewer', 'Caption update failed', { message: error?.message });
      Alert.alert('Caption update failed', 'Please try again.');
    } finally {
      setCaptionSaving(false);
    }
  };

  const renderPhotoPage = useCallback(({ item, index }) => (
    <ImageViewerPage
      photo={item}
      index={index}
      pageWidth={runtimeWidth}
      pageHeight={runtimeHeight}
      fullQualityRequested={Boolean(fullQualityRequestedByPhotoKey[getPhotoKey(item, index)])}
      onToggleChrome={toggleChrome}
      useExpoImage={useExpoImage}
    />
  ), [fullQualityRequestedByPhotoKey, runtimeHeight, runtimeWidth, toggleChrome, useExpoImage]);

  const keyExtractor = useCallback((item, index) => `${getPhotoKey(item, index)}:${index}`, []);

  const getItemLayout = useCallback((_, index) => ({
    length: runtimeWidth,
    offset: runtimeWidth * index,
    index,
  }), [runtimeWidth]);

  const detailsTranslateY = detailsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [detailsPanelMaxHeight + 40, 0],
  });

  if (!visible) return null;
  return (
    <ImageViewerView
      visible={visible}
      onClose={onClose}
      photos={photos}
      pagerRef={pagerRef}
      renderPhotoPage={renderPhotoPage}
      keyExtractor={keyExtractor}
      safeInitialIndex={safeInitialIndex}
      getItemLayout={getItemLayout}
      handleMomentumScrollEnd={handleMomentumScrollEnd}
      handleScrollToIndexFailed={handleScrollToIndexFailed}
      runtimeWidth={runtimeWidth}
      runtimeHeight={runtimeHeight}
      fullQualityRequestedByPhotoKey={fullQualityRequestedByPhotoKey}
      fadeAnim={fadeAnim}
      chromeVisible={chromeVisible}
      chromeAnim={chromeAnim}
      currentIndex={currentIndex}
      setChromeVisible={setChromeVisible}
      setDetailsVisible={setDetailsVisible}
      handleShare={handleShare}
      handleSaveToDevice={handleSaveToDevice}
      saving={saving}
      resolveCurrentPhotoUri={resolveCurrentPhotoUri}
      canRequestFullQuality={canRequestFullQuality}
      requestFullQuality={requestFullQuality}
      canReportThis={canReportThis}
      handleReport={handleReport}
      reporting={reporting}
      canDeleteThis={canDeleteThis}
      handleDelete={handleDelete}
      detailsVisible={detailsVisible}
      detailsAnim={detailsAnim}
      detailsPanelMaxHeight={detailsPanelMaxHeight}
      detailsTranslateY={detailsTranslateY}
      currentPhoto={currentPhoto}
      formatDate={formatDate}
      showUploaderInfo={showUploaderInfo}
      currentUploaderName={currentUploaderName}
      currentCaption={currentCaption}
      canEditCaption={canEditCaption}
      startEditCaption={startEditCaption}
      editingCaption={editingCaption}
      setEditingCaption={setEditingCaption}
      draftCaption={draftCaption}
      setDraftCaption={setDraftCaption}
      saveCaption={saveCaption}
      captionSaving={captionSaving}
    />
  );
}
