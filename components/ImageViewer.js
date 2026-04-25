// components/ImageViewer.js
// Enhanced full-screen image viewer with swipe navigation, zoom, and actions
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Modal,
  TouchableOpacity,
  Dimensions,
  Platform,
  Animated,
  PanResponder,
  StatusBar,
  Share,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
import loggerService from '../services/loggerService';
import { getCachedPhotoUri, prefetchPhotoUris } from '../services/photoViewerCacheService';
import {
  resolveViewerDisplayUri,
  resolveSaveUri,
  resolveFullQualityUri,
  buildNeighborPrefetchUris,
} from '../services/photoVariantService';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SWIPE_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 0.3;
const PANEL_MAX_HEIGHT = SCREEN_HEIGHT * 0.44;
const SWIPE_ZONE_HEIGHT_RATIO = 0.6;
const SWIPE_ZONE_TOP = SCREEN_HEIGHT * ((1 - SWIPE_ZONE_HEIGHT_RATIO) / 2);
const SWIPE_ZONE_BOTTOM = SCREEN_HEIGHT * (1 - ((1 - SWIPE_ZONE_HEIGHT_RATIO) / 2));

export default function ImageViewer({
  visible,
  photos,
  initialIndex = 0,
  onClose,
  onDelete,
  showUploaderInfo = false,
  canDelete = false,
  currentUserId = null,
  onEditCaption = null,
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingCaption, setEditingCaption] = useState(false);
  const [draftCaption, setDraftCaption] = useState('');
  const [captionSaving, setCaptionSaving] = useState(false);
  const [resolvedPhotoUri, setResolvedPhotoUri] = useState(null);
  const [activeResolveRequestId, setActiveResolveRequestId] = useState(0);
  const [fullQualityRequestedByPhotoKey, setFullQualityRequestedByPhotoKey] = useState({});
  const [prefetchPolicy, setPrefetchPolicy] = useState({
    neighborDistance: 2,
    thumbnailsOnly: false,
    delayMs: 300,
  });

  const translateX = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const infoSlideAnim = useRef(new Animated.Value(0)).current;
  const fullImageOpacity = useRef(new Animated.Value(0)).current;
  const resolveRequestIdRef = useRef(0);

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, visible]);

  useEffect(() => {
    if (visible) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible]);

  useEffect(() => {
    Animated.spring(infoSlideAnim, {
      toValue: showInfo ? 1 : 0,
      friction: 8,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [showInfo]);

  const currentPhoto = photos[currentIndex] || {};
  const hasThumbnail = Boolean(currentPhoto.thumbnailUrl);
  const currentPhotoKey = currentPhoto?.id || currentPhoto?.url || `${currentIndex}`;
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
        ? { neighborDistance: 1, thumbnailsOnly: true, delayMs: 450 }
        : { neighborDistance: 2, thumbnailsOnly: false, delayMs: 300 });
    }).catch(() => {});

    return () => {
      mounted = false;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !photos.length) return undefined;

    const prefetchCandidates = buildNeighborPrefetchUris({
      photos,
      currentIndex,
      neighborDistance: prefetchPolicy.neighborDistance,
      thumbnailsOnly: prefetchPolicy.thumbnailsOnly,
    });

    const timer = setTimeout(() => {
      prefetchPhotoUris(prefetchCandidates).catch(() => {});
    }, prefetchPolicy.delayMs);

    return () => clearTimeout(timer);
  }, [visible, currentIndex, photos, prefetchPolicy]);

  useEffect(() => {
    if (!visible) return;
    const currentRequestId = resolveRequestIdRef.current + 1;
    resolveRequestIdRef.current = currentRequestId;
    setActiveResolveRequestId(currentRequestId);
    const sourceUri = fullQualityRequested
      ? (currentFullQualityUri || currentViewerUri || null)
      : (currentViewerUri || null);
    fullImageOpacity.setValue(0);
    setResolvedPhotoUri(sourceUri);
    setImageLoading(Boolean(sourceUri));

    if (!sourceUri) return;
    getCachedPhotoUri(sourceUri).then((cachedUri) => {
      if (!cachedUri) return;
      if (resolveRequestIdRef.current !== currentRequestId) return;
      setResolvedPhotoUri(cachedUri);
    }).catch(() => {});
  }, [visible, currentIndex, currentViewerUri, currentFullQualityUri, fullQualityRequested, fullImageOpacity]);

  useEffect(() => {
    if (visible) return;
    resolveRequestIdRef.current += 1;
    setActiveResolveRequestId(resolveRequestIdRef.current);
    setFullQualityRequestedByPhotoKey({});
  }, [visible]);

  const requestFullQuality = useCallback(() => {
    if (!canRequestFullQuality || !currentPhotoKey) return;
    setFullQualityRequestedByPhotoKey((prev) => ({
      ...prev,
      [currentPhotoKey]: true,
    }));
    setImageLoading(true);
  }, [canRequestFullQuality, currentPhotoKey]);

  const handleFullImageLoaded = useCallback((requestId) => {
    if (!requestId || requestId !== resolveRequestIdRef.current) return;

    Animated.timing(fullImageOpacity, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      if (requestId === resolveRequestIdRef.current) {
        setImageLoading(false);
      }
    });
  }, [fullImageOpacity, resolveRequestIdRef]);

  const handleFullImageError = useCallback((requestId) => {
    if (!requestId || requestId !== resolveRequestIdRef.current) return;
    setImageLoading(false);
    fullImageOpacity.setValue(1);
  }, [fullImageOpacity, resolveRequestIdRef]);

  const goToNext = useCallback(() => {
    if (currentIndex < photos.length - 1) {
      setImageLoading(true);
      Animated.spring(translateX, {
        toValue: -SCREEN_WIDTH,
        friction: 10,
        tension: 40,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex(prev => prev + 1);
        requestAnimationFrame(() => {
          translateX.setValue(0);
        });
      });
      return true;
    }
    return false;
  }, [currentIndex, photos.length]);

  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setImageLoading(true);
      Animated.spring(translateX, {
        toValue: SCREEN_WIDTH,
        friction: 10,
        tension: 40,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex(prev => prev - 1);
        requestAnimationFrame(() => {
          translateX.setValue(0);
        });
      });
      return true;
    }
    return false;
  }, [currentIndex, translateX]);

  const resetSwipePosition = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      friction: 10,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  const isWithinVerticalSwipeZone = useCallback(
    (yPosition) => yPosition >= SWIPE_ZONE_TOP && yPosition <= SWIPE_ZONE_BOTTOM,
    []
  );

  const canStartHorizontalSwipe = useCallback((gestureState) => {
    const startY = typeof gestureState?.y0 === 'number' ? gestureState.y0 : null;
    const currentY = typeof gestureState?.moveY === 'number' ? gestureState.moveY : null;
    return isWithinVerticalSwipeZone(startY) || isWithinVerticalSwipeZone(currentY);
  }, [isWithinVerticalSwipeZone]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => (
      Math.abs(gestureState.dx) > 10
      && canStartHorizontalSwipe(gestureState)
    ),
    onMoveShouldSetPanResponderCapture: (_, gestureState) => (
      Math.abs(gestureState.dx) > 10
      && canStartHorizontalSwipe(gestureState)
    ),
    onPanResponderMove: (_, gestureState) => {
      // Only allow horizontal movement within bounds
      const newX = gestureState.dx;
      if ((currentIndex === 0 && newX > 0) ||
          (currentIndex === photos.length - 1 && newX < 0)) {
        translateX.setValue(newX * 0.3); // Resistance at edges
      } else {
        translateX.setValue(newX);
      }
    },
    onPanResponderRelease: (_, gestureState) => {
      const { dx, vx } = gestureState;
      const isSwipeLeft = dx < -SWIPE_THRESHOLD || vx < -VELOCITY_THRESHOLD;
      const isSwipeRight = dx > SWIPE_THRESHOLD || vx > VELOCITY_THRESHOLD;

      if (isSwipeLeft) {
        const moved = goToNext();
        if (!moved) resetSwipePosition();
        return;
      }

      if (isSwipeRight) {
        const moved = goToPrevious();
        if (!moved) resetSwipePosition();
        return;
      }

      resetSwipePosition();
    },
    onPanResponderTerminationRequest: () => false,
  }), [canStartHorizontalSwipe, currentIndex, goToNext, goToPrevious, photos.length, resetSwipePosition, translateX]);

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Unknown date';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: currentPhoto.caption
          ? `${currentPhoto.caption}\n\nShared from Loch Lomond Travel`
          : 'Check out this photo from my Loch Lomond tour!',
        url: currentPhoto.url,
      });
    } catch (error) {
      loggerService.warn('ImageViewer', 'Share action failed', { message: error?.message });
      Alert.alert('Share unavailable', 'Unable to open share options right now. Please try again.');
    }
  };

  const resolveCurrentPhotoUri = useCallback(() => resolveSaveUri(currentPhoto), [currentPhoto]);

  const handleSaveToDevice = async () => {
    try {
      setSaving(true);

      const photoUri = resolveCurrentPhotoUri();
      if (!photoUri || typeof photoUri !== 'string') {
        Alert.alert('Photo unavailable', 'This photo cannot be saved right now. Please refresh and try again.');
        return;
      }

      // Request permission
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
            if (onDelete) {
              onDelete(currentPhoto);
              if (photos.length <= 1) {
                onClose();
              } else if (currentIndex >= photos.length - 1) {
                setCurrentIndex(prev => prev - 1);
              }
            }
          },
        },
      ]
    );
  };

  const canDeleteThis = canDelete && currentPhoto.userId === currentUserId;
  const canEditCaption = typeof onEditCaption === 'function' && currentPhoto.userId === currentUserId;

  const startEditCaption = () => {
    setDraftCaption(currentPhoto.caption || '');
    setEditingCaption(true);
  };

  const saveCaption = async () => {
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

  const infoTranslateY = infoSlideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [200, 0],
  });
  if (!visible) return null;

  if (!photos.length) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
        <View style={styles.emptyContainer}>
          <View style={styles.emptyCard}>
            <MaterialCommunityIcons name="image-off-outline" size={30} color={COLORS.textSecondary} />
            <Text style={styles.emptyTitle}>Photo unavailable</Text>
            <Text style={styles.emptyBody}>This photo can’t be loaded right now. Try refreshing the gallery.</Text>
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
      <StatusBar barStyle="light-content" backgroundColor="rgba(0,0,0,0.9)" />
      <Animated.View
        style={[styles.container, { opacity: fadeAnim }]}
        {...panResponder.panHandlers}
      >
        {/* Header */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(2, 6, 23, 0.9)', 'rgba(2, 6, 23, 0)']}
          style={styles.headerGradient}
        />
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerButton}>
            <MaterialCommunityIcons name="close" size={28} color={COLORS.white} />
          </TouchableOpacity>

          <Text style={styles.counter}>
            {currentIndex + 1} / {photos.length}
          </Text>

          <TouchableOpacity
            onPress={() => setShowInfo(!showInfo)}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel={showInfo ? 'Hide photo details' : 'Show photo details'}
          >
            <MaterialCommunityIcons
              name={showInfo ? "information" : "information-outline"}
              size={26}
              color={COLORS.white}
            />
          </TouchableOpacity>
        </View>

        {/* Main Image Area */}
        <Animated.View style={[styles.imageContainer, { transform: [{ translateX }] }]}>
          {imageLoading && !hasThumbnail && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={COLORS.white} />
            </View>
          )}
          <View style={styles.imageLayerContainer}>
            {hasThumbnail && (
              <Image
                key={`thumb-${currentPhotoKey}`}
                source={{ uri: currentPhoto.thumbnailUrl }}
                style={styles.image}
                resizeMode="contain"
              />
            )}
            <Animated.Image
              key={`full-${currentPhotoKey}`}
              source={resolvedPhotoUri ? { uri: resolvedPhotoUri, cache: 'force-cache' } : undefined}
              style={[styles.image, styles.fullImageLayer, { opacity: fullImageOpacity }]}
              resizeMode="contain"
              onLoadStart={() => {
                if (activeResolveRequestId === resolveRequestIdRef.current) {
                  setImageLoading(true);
                }
              }}
              onLoad={() => handleFullImageLoaded(activeResolveRequestId)}
              onError={() => handleFullImageError(activeResolveRequestId)}
            />
          </View>

          {/* Navigation arrows for larger screens */}
          {currentIndex > 0 && (
            <TouchableOpacity
              style={[styles.navArrow, styles.navArrowLeft]}
              onPress={goToPrevious}
              accessibilityRole="button"
              accessibilityLabel="Previous photo"
            >
              <MaterialCommunityIcons name="chevron-left" size={40} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
          {currentIndex < photos.length - 1 && (
            <TouchableOpacity
              style={[styles.navArrow, styles.navArrowRight]}
              onPress={goToNext}
              accessibilityRole="button"
              accessibilityLabel="Next photo"
            >
              <MaterialCommunityIcons name="chevron-right" size={40} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* Bottom Actions */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(2, 6, 23, 0)', 'rgba(2, 6, 23, 0.92)']}
          style={styles.bottomGradient}
        />
        <View style={styles.bottomActions}>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.actionButton}
            accessibilityRole="button"
            accessibilityLabel="Share photo"
          >
            <MaterialCommunityIcons name="share-variant" size={24} color={COLORS.white} />
            <Text style={styles.actionText}>Share</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSaveToDevice}
            style={styles.actionButton}
            disabled={saving || !resolveCurrentPhotoUri()}
            accessibilityRole="button"
            accessibilityLabel="Save photo to device"
          >
            {saving ? (
              <ActivityIndicator size="small" color={COLORS.white} />
            ) : (
              <MaterialCommunityIcons name="download" size={24} color={COLORS.white} />
            )}
            <Text style={styles.actionText}>{saving ? 'Saving...' : 'Save'}</Text>
          </TouchableOpacity>

          {canRequestFullQuality && !fullQualityRequested && (
            <TouchableOpacity
              onPress={requestFullQuality}
              style={styles.actionButton}
              accessibilityRole="button"
              accessibilityLabel="Load full quality photo"
            >
              <MaterialCommunityIcons name="image-filter-hdr" size={24} color={COLORS.white} />
              <Text style={styles.actionText}>Full quality</Text>
            </TouchableOpacity>
          )}

          {canDeleteThis && (
            <TouchableOpacity
              onPress={handleDelete}
              style={[styles.actionButton, styles.deleteButton]}
              accessibilityRole="button"
              accessibilityLabel="Delete photo"
            >
              <MaterialCommunityIcons name="delete-outline" size={24} color={COLORS.error} />
              <Text style={[styles.actionText, { color: COLORS.error }]}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Info Panel */}
        <Animated.View
          style={[
            styles.infoPanel,
            { transform: [{ translateY: infoTranslateY }] }
          ]}
        >
          <View style={styles.infoPanelHandle} />

          <Text style={styles.infoTitle}>Photo Details</Text>

          <View style={styles.infoRow}>
            <MaterialCommunityIcons name="calendar" size={20} color={COLORS.textSecondary} />
            <Text style={styles.infoLabel}>Taken</Text>
            <Text style={styles.infoValue}>{formatDate(currentPhoto.timestamp)}</Text>
          </View>

          {showUploaderInfo && currentPhoto.uploaderName && (
            <View style={styles.infoRow}>
              <MaterialCommunityIcons name="account" size={20} color={COLORS.textSecondary} />
              <Text style={styles.infoLabel}>By</Text>
              <Text style={styles.infoValue}>{currentPhoto.uploaderName}</Text>
            </View>
          )}

          {(currentPhoto.caption || canEditCaption) && (
            <View style={styles.captionContainer}>
              <MaterialCommunityIcons name="text" size={20} color={COLORS.textSecondary} />
              <Text style={styles.captionText}>{currentPhoto.caption || 'No caption yet'}</Text>
              {canEditCaption && (
                <TouchableOpacity onPress={startEditCaption} style={styles.captionEditBtn}>
                  <MaterialCommunityIcons name="pencil" size={16} color={COLORS.primary} />
                </TouchableOpacity>
              )}
            </View>
          )}
        </Animated.View>

        {/* Dot indicators */}
        {photos.length > 1 && photos.length <= 10 && (
          <View style={styles.dotsContainer}>
            {photos.map((_, index) => (
              <View
                key={index}
                style={[
                  styles.dot,
                  index === currentIndex && styles.dotActive,
                ]}
              />
            ))}
          </View>
        )}
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
    backgroundColor: '#020617',
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
  headerGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT * 0.18,
    zIndex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop: Platform.OS === 'ios' ? 50 : 40,
    paddingBottom: SPACING.md,
    zIndex: 10,
  },
  headerButton: {
    padding: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  counter: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: FONT_WEIGHT.semibold,
    letterSpacing: 0.4,
  },
  imageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageLayerContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.65,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.65,
  },
  fullImageLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  navArrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -25,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  navArrowLeft: {
    left: 10,
  },
  navArrowRight: {
    right: 10,
  },
  bottomGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCREEN_HEIGHT * 0.26,
  },
  bottomActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.xl,
    gap: SPACING.xxl,
  },
  actionButton: {
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    minWidth: 92,
  },
  actionText: {
    color: COLORS.white,
    fontSize: 12,
    marginTop: 4,
    fontWeight: FONT_WEIGHT.medium,
  },
  deleteButton: {
    opacity: 0.9,
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: Platform.OS === 'ios' ? 30 : 20,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  dotActive: {
    backgroundColor: COLORS.white,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  infoPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    maxHeight: PANEL_MAX_HEIGHT,
    ...SHADOWS.xl,
  },
  infoPanelHandle: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: SPACING.lg,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.textPrimary,
    marginBottom: SPACING.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  infoLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
    width: 50,
  },
  infoValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: FONT_WEIGHT.medium,
    flex: 1,
  },
  captionContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: SPACING.sm,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  captionText: {
    fontSize: 15,
    color: COLORS.textPrimary,
    lineHeight: 22,
    flex: 1,
  },
  captionEditBtn: {
    padding: SPACING.xs,
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
