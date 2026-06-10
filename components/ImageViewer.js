// components/ImageViewer.js
// Fullscreen pager-style photo viewer with compact chrome and preserved photo actions.
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TouchableOpacity,
  useWindowDimensions,
  Platform,
  Animated,
  StatusBar,
  Share,
  Alert,
  ActivityIndicator,
  TextInput,
  FlatList,
  Pressable,
  ScrollView,
  Image as RNImage,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
import loggerService from '../services/loggerService';
import {
  normalizePhotoUri,
  resolveViewerDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
  buildPhotoCacheKey,
} from '../services/photoVariantService';
import {
  clampPagerIndex,
  resolvePagerIndexFromOffset,
} from '../services/imageViewerPagerState';
import { parseTimestampMs } from '../services/timeUtils';
import { REPORT_REASON_OPTIONS } from '../services/contentModerationService';

const DEFAULT_VIEWER_WIDTH = 360;
const DEFAULT_VIEWER_HEIGHT = 640;
const DARK_BACKGROUND = '#020617';

const normalizeKeyPart = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return null;

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const getPhotoKey = (photo, index) => {
  const candidates = [
    photo?.id,
    photo?.idempotencyKey,
    photo?.viewerStoragePath,
    photo?.thumbnailStoragePath,
    photo?.storagePath,
    photo?.viewerUrl,
    photo?.url,
  ];

  for (const candidate of candidates) {
    const key = normalizeKeyPart(candidate);
    if (key) return key;
  }

  return `${index}`;
};

const buildImageSource = (uri, cacheKey) => {
  const normalizedUri = normalizePhotoUri(uri);
  return normalizedUri ? (cacheKey ? { uri: normalizedUri, cacheKey } : { uri: normalizedUri }) : undefined;
};

const buildNativeImageSource = (uri) => {
  const normalizedUri = normalizePhotoUri(uri);
  return normalizedUri ? { uri: normalizedUri } : undefined;
};

const resolveText = (value, fallback = '') => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
);

const ImageViewerPage = React.memo(function ImageViewerPage({
  photo,
  index,
  pageWidth,
  pageHeight,
  fullQualityRequested,
  onToggleChrome,
  useExpoImage = true,
}) {
  const photoKey = getPhotoKey(photo, index);
  const thumbnailUri = photo?.thumbnailUrl || null;
  const viewerUri = fullQualityRequested
    ? (resolveFullQualityUri(photo) || resolveViewerDisplayUri(photo))
    : resolveViewerDisplayUri(photo);
  const effectiveViewerUri = viewerUri || thumbnailUri;
  const thumbnailCacheKey = buildPhotoCacheKey(photo, 'thumbnail');
  const viewerCacheKey = buildPhotoCacheKey(photo, fullQualityRequested ? 'full' : 'viewer');
  const thumbnailSource = buildImageSource(thumbnailUri, thumbnailCacheKey);
  const viewerSource = buildImageSource(effectiveViewerUri, viewerCacheKey);
  const thumbnailNativeSource = buildNativeImageSource(thumbnailUri);
  const viewerNativeSource = buildNativeImageSource(effectiveViewerUri);
  const [viewerLoaded, setViewerLoaded] = useState(false);
  const [viewerFailed, setViewerFailed] = useState(false);

  useEffect(() => {
    setViewerLoaded(false);
    setViewerFailed(false);
  }, [effectiveViewerUri, photoKey]);

  const shouldRenderThumbnailLayer = Boolean(
    thumbnailSource
    && thumbnailUri
    && thumbnailUri !== effectiveViewerUri
  );
  const showSpinner = Boolean(viewerSource && !viewerLoaded && !viewerFailed && !thumbnailSource);
  const showPlaceholder = (!viewerSource && !thumbnailSource) || (viewerFailed && !thumbnailSource);

  return (
    <Pressable
      style={[styles.page, { width: pageWidth, height: pageHeight }]}
      onPress={onToggleChrome}
      accessibilityRole="imagebutton"
      accessibilityLabel="Toggle photo controls"
    >
      <View style={styles.imageStage}>
        {shouldRenderThumbnailLayer && useExpoImage && (
          <ExpoImage
            source={thumbnailSource}
            style={styles.imageLayer}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={`thumb:${photoKey}`}
          />
        )}

        {shouldRenderThumbnailLayer && !useExpoImage && thumbnailNativeSource && (
          <RNImage
            source={thumbnailNativeSource}
            style={styles.imageLayer}
            resizeMode="contain"
          />
        )}

        {viewerSource && useExpoImage && (
          <ExpoImage
            source={viewerSource}
            style={styles.imageLayer}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={`viewer:${photoKey}:${fullQualityRequested ? 'full' : 'viewer'}`}
            transition={shouldRenderThumbnailLayer ? 120 : 80}
            onLoadStart={() => {
              setViewerLoaded(false);
              setViewerFailed(false);
            }}
            onLoad={() => setViewerLoaded(true)}
            onError={() => {
              setViewerLoaded(true);
              setViewerFailed(true);
            }}
          />
        )}

        {viewerSource && !useExpoImage && viewerNativeSource && (
          <RNImage
            source={viewerNativeSource}
            style={styles.imageLayer}
            resizeMode="contain"
            onLoadStart={() => {
              setViewerLoaded(false);
              setViewerFailed(false);
            }}
            onLoad={() => setViewerLoaded(true)}
            onError={() => {
              setViewerLoaded(true);
              setViewerFailed(true);
            }}
          />
        )}

        {showPlaceholder && (
          <View style={styles.viewerPlaceholder}>
            <MaterialCommunityIcons name="image-off-outline" size={34} color="rgba(255,255,255,0.5)" />
          </View>
        )}

        {showSpinner && (
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={COLORS.white} />
          </View>
        )}
      </View>
    </Pressable>
  );
});

function ViewerIconButton({
  icon,
  onPress,
  accessibilityLabel,
  disabled = false,
  danger = false,
  children = null,
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.iconButton,
        danger && styles.iconButtonDanger,
        disabled && styles.iconButtonDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      activeOpacity={0.82}
    >
      {children || (
        <MaterialCommunityIcons
          name={icon}
          size={24}
          color={danger ? COLORS.error : COLORS.white}
        />
      )}
    </TouchableOpacity>
  );
}

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

  const currentPhoto = photos[currentIndex] || {};
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

  if (!photos.length) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
        <View style={styles.emptyContainer}>
          <View style={styles.emptyCard}>
            <MaterialCommunityIcons name="image-off-outline" size={30} color={COLORS.textSecondary} />
            <Text style={styles.emptyTitle}>Photo unavailable</Text>
            <Text style={styles.emptyBody}>This photo can't be loaded right now. Try refreshing the gallery.</Text>
            <TouchableOpacity onPress={onClose} style={styles.emptyCloseButton}>
              <Text style={styles.emptyCloseText}>Close viewer</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar barStyle="light-content" backgroundColor={DARK_BACKGROUND} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <FlatList
          ref={pagerRef}
          data={photos}
          renderItem={renderPhotoPage}
          keyExtractor={keyExtractor}
          horizontal
          pagingEnabled
          initialScrollIndex={safeInitialIndex}
          getItemLayout={getItemLayout}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          showsHorizontalScrollIndicator={false}
          bounces={false}
          decelerationRate="fast"
          snapToInterval={runtimeWidth}
          snapToAlignment="center"
          disableIntervalMomentum
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          windowSize={5}
          removeClippedSubviews={false}
          extraData={fullQualityRequestedByPhotoKey}
          style={styles.pager}
        />

        <Animated.View
          pointerEvents={chromeVisible ? 'auto' : 'none'}
          style={[styles.topChrome, { opacity: chromeAnim }]}
        >
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(2, 6, 23, 0.88)', 'rgba(2, 6, 23, 0)']}
            style={[styles.headerGradient, { height: Math.max(118, runtimeHeight * 0.18) }]}
          />
          <View style={styles.header}>
            <ViewerIconButton
              icon="close"
              onPress={onClose}
              accessibilityLabel="Close photo viewer"
            />

            <View style={styles.counterPill}>
              <Text style={styles.counterText}>{currentIndex + 1} / {photos.length}</Text>
            </View>

            <ViewerIconButton
              icon="dots-horizontal"
              onPress={() => {
                setChromeVisible(true);
                setDetailsVisible(true);
              }}
              accessibilityLabel="Show photo details and actions"
            />
          </View>
        </Animated.View>

        <Animated.View
          pointerEvents={chromeVisible ? 'auto' : 'none'}
          style={[styles.bottomChrome, { opacity: chromeAnim }]}
        >
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(2, 6, 23, 0)', 'rgba(2, 6, 23, 0.78)']}
            style={[styles.bottomGradient, { height: Math.max(130, runtimeHeight * 0.22) }]}
          />
          <View style={styles.compactToolbar}>
            <ViewerIconButton
              icon="share-variant"
              onPress={handleShare}
              accessibilityLabel="Share photo"
            />

            <ViewerIconButton
              icon="download"
              onPress={handleSaveToDevice}
              disabled={saving || !resolveCurrentPhotoUri()}
              accessibilityLabel="Save photo to device"
            >
              {saving ? <ActivityIndicator size="small" color={COLORS.white} /> : null}
            </ViewerIconButton>

            {canRequestFullQuality && (
              <ViewerIconButton
                icon="image-filter-hdr"
                onPress={requestFullQuality}
                accessibilityLabel="Load full quality photo"
              />
            )}

            <ViewerIconButton
              icon="information-outline"
              onPress={() => setDetailsVisible(true)}
              accessibilityLabel="Show photo details"
            />

            {canReportThis && (
              <ViewerIconButton
                icon="flag-outline"
                onPress={handleReport}
                disabled={reporting}
                accessibilityLabel="Report photo"
              >
                {reporting ? <ActivityIndicator size="small" color={COLORS.white} /> : null}
              </ViewerIconButton>
            )}

            {canDeleteThis && (
              <ViewerIconButton
                icon="delete-outline"
                onPress={handleDelete}
                accessibilityLabel="Delete photo"
                danger
              />
            )}
          </View>
        </Animated.View>

        <Animated.View
          pointerEvents={detailsVisible ? 'auto' : 'none'}
          style={[styles.detailsBackdrop, { opacity: detailsAnim }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDetailsVisible(false)} />
        </Animated.View>

        <Animated.View
          pointerEvents={detailsVisible ? 'auto' : 'none'}
          style={[
            styles.detailsPanel,
            {
              maxHeight: detailsPanelMaxHeight,
              transform: [{ translateY: detailsTranslateY }],
            },
          ]}
        >
          <View style={styles.detailsHandle} />
          <View style={styles.detailsHeader}>
            <Text style={styles.detailsTitle}>Photo Details</Text>
            <TouchableOpacity
              onPress={() => setDetailsVisible(false)}
              style={styles.detailsCloseButton}
              accessibilityRole="button"
              accessibilityLabel="Close photo details"
            >
              <MaterialCommunityIcons name="close" size={20} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={[styles.detailsScroll, { maxHeight: Math.max(124, detailsPanelMaxHeight - 96) }]}
            contentContainerStyle={styles.detailsContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.detailRow}>
              <MaterialCommunityIcons name="calendar" size={20} color={COLORS.textSecondary} />
              <View style={styles.detailTextGroup}>
                <Text style={styles.detailLabel}>Taken</Text>
                <Text style={styles.detailValue}>{formatDate(currentPhoto.timestamp)}</Text>
              </View>
            </View>

            {showUploaderInfo && currentUploaderName && (
              <View style={styles.detailRow}>
                <MaterialCommunityIcons name="account" size={20} color={COLORS.textSecondary} />
                <View style={styles.detailTextGroup}>
                  <Text style={styles.detailLabel}>By</Text>
                  <Text style={styles.detailValue}>{currentUploaderName}</Text>
                </View>
              </View>
            )}

            {(currentCaption || canEditCaption) && (
              <View style={styles.captionBlock}>
                <View style={styles.captionHeader}>
                  <MaterialCommunityIcons name="text" size={20} color={COLORS.textSecondary} />
                  <Text style={styles.detailLabel}>Caption</Text>
                  {canEditCaption && (
                    <TouchableOpacity onPress={startEditCaption} style={styles.captionEditButton}>
                      <MaterialCommunityIcons name="pencil" size={17} color={COLORS.primary} />
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={styles.captionText}>{currentCaption || 'No caption yet'}</Text>
              </View>
            )}

            <View style={styles.detailsActionRow}>
              {canRequestFullQuality && (
                <TouchableOpacity onPress={requestFullQuality} style={styles.detailsActionButton}>
                  <MaterialCommunityIcons name="image-filter-hdr" size={20} color={COLORS.primary} />
                  <Text style={styles.detailsActionText}>Full quality</Text>
                </TouchableOpacity>
              )}

              {canEditCaption && (
                <TouchableOpacity onPress={startEditCaption} style={styles.detailsActionButton}>
                  <MaterialCommunityIcons name="pencil" size={20} color={COLORS.primary} />
                  <Text style={styles.detailsActionText}>Edit caption</Text>
                </TouchableOpacity>
              )}

              {canReportThis && (
                <TouchableOpacity
                  onPress={handleReport}
                  style={styles.detailsActionButton}
                  disabled={reporting}
                >
                  {reporting ? (
                    <ActivityIndicator size="small" color={COLORS.primary} />
                  ) : (
                    <MaterialCommunityIcons name="flag-outline" size={20} color={COLORS.primary} />
                  )}
                  <Text style={styles.detailsActionText}>Report</Text>
                </TouchableOpacity>
              )}

              {canDeleteThis && (
                <TouchableOpacity onPress={handleDelete} style={[styles.detailsActionButton, styles.detailsDangerAction]}>
                  <MaterialCommunityIcons name="delete-outline" size={20} color={COLORS.error} />
                  <Text style={[styles.detailsActionText, styles.detailsDangerText]}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        </Animated.View>
      </Animated.View>

      <Modal
        visible={editingCaption}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingCaption(false)}
      >
        <View style={styles.editModalOverlay}>
          <View style={styles.editModalCard}>
            <Text style={styles.editModalTitle}>Edit caption</Text>
            <TextInput
              value={draftCaption}
              onChangeText={setDraftCaption}
              placeholder="Write a caption..."
              style={styles.editModalInput}
              multiline
              maxLength={200}
            />
            <View style={styles.editModalActions}>
              <TouchableOpacity onPress={() => setEditingCaption(false)} style={styles.editModalCancel}>
                <Text style={styles.editModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveCaption}
                style={[styles.editModalSave, captionSaving && styles.editModalSaveDisabled]}
                disabled={captionSaving}
              >
                {captionSaving ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.editModalSaveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DARK_BACKGROUND,
  },
  pager: {
    flex: 1,
  },
  page: {
    backgroundColor: DARK_BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageStage: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageLayer: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.92)',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  emptyCard: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
    alignItems: 'center',
    ...SHADOWS.xl,
  },
  emptyTitle: {
    marginTop: SPACING.md,
    fontSize: 18,
    color: COLORS.textPrimary,
    fontWeight: FONT_WEIGHT.bold,
  },
  emptyBody: {
    marginTop: SPACING.sm,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyCloseButton: {
    marginTop: SPACING.lg,
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.md,
  },
  emptyCloseText: {
    color: COLORS.white,
    fontWeight: FONT_WEIGHT.bold,
  },
  topChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 8,
  },
  headerGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop: Platform.OS === 'ios' ? 50 : 34,
    paddingBottom: SPACING.md,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.52)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
  },
  iconButtonDanger: {
    backgroundColor: 'rgba(127, 29, 29, 0.38)',
    borderColor: 'rgba(248, 113, 113, 0.32)',
  },
  iconButtonDisabled: {
    opacity: 0.55,
  },
  counterPill: {
    minWidth: 72,
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(15, 23, 42, 0.48)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  counterText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: FONT_WEIGHT.semibold,
  },
  bottomChrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 8,
  },
  bottomGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  compactToolbar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingBottom: Platform.OS === 'ios' ? 34 : 22,
    paddingTop: SPACING.xl,
  },
  detailsBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 12,
    backgroundColor: 'rgba(2, 6, 23, 0.34)',
  },
  detailsPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 13,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.md,
    paddingHorizontal: SPACING.xl,
    paddingBottom: Platform.OS === 'ios' ? 34 : SPACING.xl,
    ...SHADOWS.xl,
  },
  detailsHandle: {
    width: 38,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: SPACING.md,
  },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  detailsTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.textPrimary,
  },
  detailsCloseButton: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
  },
  detailsScroll: {},
  detailsContent: {
    paddingBottom: SPACING.sm,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  detailTextGroup: {
    flex: 1,
  },
  detailLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: FONT_WEIGHT.semibold,
    textTransform: 'uppercase',
  },
  detailValue: {
    marginTop: 3,
    fontSize: 15,
    lineHeight: 21,
    color: COLORS.textPrimary,
    fontWeight: FONT_WEIGHT.medium,
  },
  captionBlock: {
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginBottom: SPACING.lg,
  },
  captionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  captionEditButton: {
    marginLeft: 'auto',
    width: 34,
    height: 34,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryMuted,
  },
  captionText: {
    marginTop: SPACING.sm,
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.textPrimary,
  },
  detailsActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  detailsActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  detailsActionText: {
    color: COLORS.primary,
    fontWeight: FONT_WEIGHT.semibold,
    fontSize: 13,
  },
  detailsDangerAction: {
    backgroundColor: COLORS.errorLight,
    borderColor: 'rgba(220, 38, 38, 0.22)',
  },
  detailsDangerText: {
    color: COLORS.error,
  },
  editModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  editModalCard: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    ...SHADOWS.xl,
  },
  editModalTitle: {
    fontSize: 18,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.textPrimary,
    marginBottom: SPACING.md,
  },
  editModalInput: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    color: COLORS.textPrimary,
    textAlignVertical: 'top',
  },
  editModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
  editModalCancel: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  editModalCancelText: {
    color: COLORS.textSecondary,
    fontWeight: FONT_WEIGHT.semibold,
  },
  editModalSave: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  editModalSaveText: {
    color: COLORS.white,
    fontWeight: FONT_WEIGHT.bold,
  },
  editModalSaveDisabled: {
    opacity: 0.75,
  },
});
