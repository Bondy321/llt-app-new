// screens/GroupPhotobookScreen.js
// Enhanced group photobook with contributor info, date grouping, and premium viewing experience
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SectionList,
  Image,
  Dimensions,
  Platform,
  ActivityIndicator,
  Alert,
  RefreshControl,
  TextInput,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as offlineSyncService from '../services/offlineSyncService';
import * as photoService from '../services/photoService';
import { optimizeImageForUpload, formatBytes } from '../services/imageOptimizationService';
import ImageViewer from '../components/ImageViewer';
import { getCachedPhotoUri } from '../services/photoViewerCacheService';
import { resolveViewerDisplayUri } from '../services/photoVariantService';
import { auth } from '../firebase';
import { getCanonicalIdentity } from '../services/identityService';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../theme';

const { width: windowWidth } = Dimensions.get('window');
const THUMBNAIL_SIZE = (windowWidth - SPACING.lg * 2 - SPACING.sm * 2) / 3;

export default function GroupPhotobookScreen({
  onBack,
  userId,
  tourId,
  userName,
  canonicalIdentity: canonicalIdentityProp = null,
  onViewerVisibilityChange = null,
}) {
  const MIN_REFRESH_SPINNER_MS = 120;
  const [photos, setPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [photoQueueItems, setPhotoQueueItems] = useState([]);
  const [sortMode, setSortMode] = useState('newest');
  const [mineOnly, setMineOnly] = useState(false);

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

  // Image loading states for skeleton
  const [loadedImages, setLoadedImages] = useState({});
  const prefetchedUrisRef = useRef(new Set());
  const currentUser = auth.currentUser;
  const canonicalIdentity = useMemo(
    () => canonicalIdentityProp || getCanonicalIdentity({ authUser: currentUser, bookingData: { id: userId } }),
    [canonicalIdentityProp, currentUser, userId]
  );
  const principalId = canonicalIdentity?.principalId || userId;

  useEffect(() => {
    if (!tourId) return undefined;

    setLoadingPhotos(true);
    const unsubscribe = photoService.subscribeToTourPhotos(tourId, (photoList) => {
      // Add uploader name to photos for display
      const photosWithNames = photoList.map(photo => ({
        ...photo,
        uploaderName: photo.uploaderName || 'Tour Member',
      }));
      setPhotos(photosWithNames);
      setLoadingPhotos(false);
      setRefreshing(false);
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [tourId]);

  useEffect(() => {
    if (!tourId) return undefined;

    const refreshPhotoQueue = async () => {
      const queued = await offlineSyncService.getPhotoUploadActions({ tourId, visibility: 'group' });
      if (queued.success) {
        setPhotoQueueItems(queued.data.filter((item) => item.status !== 'completed'));
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
    });
    return unsubscribe;
  }, [tourId]);

  const visiblePhotos = useMemo(() => {
    const scoped = mineOnly ? photos.filter((photo) => photo.userId === principalId) : photos;
    return [...scoped].sort((a, b) => {
      const aTs = a.timestamp || 0;
      const bTs = b.timestamp || 0;
      return sortMode === 'oldest' ? aTs - bTs : bTs - aTs;
    });
  }, [photos, mineOnly, sortMode, principalId]);

  const gallerySections = useMemo(() => {
    const grouped = new Map();

    visiblePhotos.forEach((photo) => {
      const date = photo.timestamp
        ? new Date(photo.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })
        : 'Unknown Date';

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

  const requestCameraPermission = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Needed', 'Camera permission is required to take photos.');
      return false;
    }
    return true;
  };

  const requestGalleryPermission = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Needed', 'Gallery access is required to select photos.');
      return false;
    }
    return true;
  };

  const handleTakePhoto = async () => {
    const hasPermission = await requestCameraPermission();
    if (!hasPermission) return;

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.[0]) {
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
    }
  };

  const handlePickFromGallery = async () => {
    const hasPermission = await requestGalleryPermission();
    if (!hasPermission) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.[0]) {
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
    }
  };

  const showUploadOptions = () => {
    Alert.alert(
      'Share Photo',
      'Add a photo for everyone to enjoy',
      [
        { text: 'Take Photo', onPress: handleTakePhoto },
        { text: 'Choose from Gallery', onPress: handlePickFromGallery },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const makePhotoIdempotencyKey = ({ principal, tour, sourceUri, timestamp }) => (
    `photo_v1:${tour}:${principal}:${timestamp}:${sourceUri}`.replace(/\s+/g, '')
  );

  const handleUpload = async () => {
    if (!pendingImage?.uri) return;

    try {
      const optimized = await optimizeImageForUpload(pendingImage);
      const createdAt = new Date().toISOString();
      const jobId = `photo_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const idempotencyKey = makePhotoIdempotencyKey({
        principal: principalId,
        tour: tourId,
        sourceUri: pendingImage.uri,
        timestamp: createdAt,
      });
      const enqueueResult = await offlineSyncService.enqueueAction({
        id: jobId,
        type: 'PHOTO_UPLOAD',
        tourId,
        createdAt,
        payload: {
          payloadVersion: 2,
          jobId,
          idempotencyKey,
          createdAt,
          tourId,
          visibility: 'group',
          ownerId: principalId,
          userId: principalId,
          uploaderName: userName || 'Tour Member',
          localAssets: {
            sourceUri: optimized.uploadUri,
            previewUri: pendingImage.uri,
            optimizationMetrics: optimized.metrics || null,
          },
          metadata: {
            caption: caption.trim(),
          },
          attemptCount: 0,
          lastError: null,
        },
      };
      if (!enqueueResult.success) {
        Alert.alert('Upload queued failed', enqueueResult.error || 'Could not queue upload. Please try again.');
        return;
      }

      setShowUploadModal(false);
      setPendingImage(null);
      setCaption('');
      offlineSyncService.replayQueue({ services: { photoService } }).catch(() => {});

      if (optimized.metrics?.originalSizeBytes && optimized.metrics?.optimizedSizeBytes) {
        Alert.alert(
          'Photo optimized',
          `Saved ${formatBytes(optimized.metrics.originalSizeBytes - optimized.metrics.optimizedSizeBytes)} before upload.`
        );
      }
    } catch (error) {
      Alert.alert('Image preparation failed', 'Could not optimize this image. Please try a different photo.');
    }
  };

  const retryUpload = async (pending) => {
    await offlineSyncService.updateAction(pending.id, {
      status: 'retrying',
      nextAttemptAt: null,
      lastError: null,
    });
    await offlineSyncService.replayQueue({ services: { photoService } });
  };

  const cancelUpload = () => {
    setShowUploadModal(false);
    setPendingImage(null);
    setCaption('');
  };

  const openViewer = (groupIndex, photoIndexInGroup) => {
    const selectedPhoto = gallerySections[groupIndex]?.photos?.[photoIndexInGroup] || null;
    const selectedUri = resolveViewerDisplayUri(selectedPhoto);
    if (selectedUri) {
      getCachedPhotoUri(selectedUri).catch(() => {});
    }

    const flatIndex = viewerFlatIndexMap[`${groupIndex}:${photoIndexInGroup}`] ?? 0;

    setViewerIndex(flatIndex);
    setViewerVisible(true);
  };

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    viewableItems.forEach(({ item }) => {
      if (!Array.isArray(item)) return;

      item.forEach(({ photo }) => {
        const previewUrl = photo?.thumbnailUrl;
        if (!previewUrl || prefetchedUrisRef.current.has(previewUrl)) return;

        prefetchedUrisRef.current.add(previewUrl);
        Image.prefetch(previewUrl).catch(() => {});
      });
    });
  });

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 40,
  });

  const renderPendingUploads = () => {
    if (photoQueueItems.length === 0) return null;

    return (
      <View style={styles.pendingSection}>
        <Text style={styles.pendingTitle}>Uploads</Text>
        <View style={styles.grid}>
          {photoQueueItems.map((item) => (
            <View key={item.id} style={styles.imageTouchable}>
              <Image source={{ uri: item?.payload?.localAssets?.previewUri || item?.payload?.localAssets?.sourceUri }} style={styles.imageThumbnail} />
              <View style={styles.pendingOverlay}>
                {item.status === 'failed' ? (
                  <>
                    <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.white} />
                    <TouchableOpacity onPress={() => retryUpload(item)} style={styles.retryButton}>
                      <Text style={styles.retryButtonText}>Retry</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={styles.pendingProgressText}>{item.status}</Text>
                )}
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  };

  const renderEmptyState = () => {
    if (photoQueueItems.length > 0) return null;

    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconWrapper}>
          <MaterialCommunityIcons name="image-multiple-outline" size={60} color={COLORS.success} />
        </View>
        <Text style={styles.emptyTitle}>Group Album</Text>
        <Text style={styles.emptySubtext}>
          Share the best moments from your tour with everyone! Photos added here are visible to all passengers.
        </Text>

        <View style={styles.emptyActions}>
          <TouchableOpacity
            style={styles.emptyCtaButton}
            onPress={handleTakePhoto}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="camera" size={22} color={COLORS.white} />
            <Text style={styles.emptyCtaText}>Take Photo</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.emptySecondaryButton}
            onPress={handlePickFromGallery}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="image-plus" size={22} color={COLORS.success} />
            <Text style={styles.emptySecondaryText}>Choose from Gallery</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tipContainer}>
          <MaterialCommunityIcons name="lightbulb-outline" size={18} color={COLORS.warning} />
          <Text style={styles.tipText}>
            Tip: Upload scenic views, group shots, and memorable moments!
          </Text>
        </View>
      </View>
    );
  };

  const handleDeletePhoto = async (photo) => {
    try {
      if (typeof photoService.deleteGroupPhoto === 'function') {
        await photoService.deleteGroupPhoto(tourId, photo.id, principalId);
      }
    } catch (error) {
      console.error('Delete error:', error);
      const msg = error.message === 'You can only delete your own photos'
        ? 'You can only delete photos you uploaded.'
        : 'Could not delete the photo. Please try again.';
      Alert.alert('Error', msg);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const refreshStartedAt = Date.now();

    try {
      if (!tourId) {
        setPhotos([]);
        return;
      }

      await new Promise((resolve) => {
        let didResolve = false;
        let unsubscribe = null;

        const completeRefresh = (photoList = []) => {
          if (didResolve) return;
          didResolve = true;

          const photosWithNames = photoList.map(photo => ({
            ...photo,
            uploaderName: photo.uploaderName || 'Tour Member',
          }));

          setPhotos(photosWithNames);
          if (typeof unsubscribe === 'function') {
            unsubscribe();
          }
          resolve();
        };

        const handleSnapshot = (photoList) => {
          completeRefresh(photoList);
        };

        unsubscribe = photoService.subscribeToTourPhotos(tourId, handleSnapshot);
      });
    } catch (error) {
      Alert.alert('Refresh Failed', 'Unable to refresh photos right now.');
    } finally {
      const elapsed = Date.now() - refreshStartedAt;
      if (elapsed < MIN_REFRESH_SPINNER_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REFRESH_SPINNER_MS - elapsed));
      }
      setRefreshing(false);
    }
  }, [tourId]);

  const handleImageLoad = (photoId) => {
    setLoadedImages(prev => ({ ...prev, [photoId]: true }));
  };

  // Render skeleton placeholder
  const renderSkeleton = () => (
    <View style={styles.skeleton}>
      <View style={styles.skeletonShimmer} />
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <LinearGradient
        colors={[COLORS.success, '#22C55E']}
        style={styles.header}
      >
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Group Album</Text>
          <View style={styles.headerBadge}>
            <MaterialCommunityIcons name="account-group" size={12} color={COLORS.white} />
            <Text style={styles.headerBadgeText}>Shared</Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={showUploadOptions}
          style={styles.headerButton}
          activeOpacity={0.7}
          disabled={false}
        >
          <MaterialCommunityIcons name="camera-plus" size={26} color={COLORS.white} />
        </TouchableOpacity>
      </LinearGradient>

      {/* Upload Progress Bar */}
      {photoQueueItems.length > 0 && (
        <View style={styles.progressContainer}>
          <View style={styles.progressContent}>
            <ActivityIndicator size="small" color={COLORS.success} />
            <Text style={styles.progressText}>Uploads in queue: {photoQueueItems.length}</Text>
          </View>
        </View>
      )}

      {/* Stats Hero Section */}
      {!loadingPhotos && visiblePhotos.length > 0 && (
        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <MaterialCommunityIcons name="image-multiple" size={22} color={COLORS.success} />
            <Text style={styles.statNumber}>{totalPhotos}</Text>
            <Text style={styles.statLabel}>Photos</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <MaterialCommunityIcons name="account-group" size={22} color={COLORS.primary} />
            <Text style={styles.statNumber}>{uniqueContributors}</Text>
            <Text style={styles.statLabel}>{uniqueContributors === 1 ? 'Contributor' : 'Contributors'}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <MaterialCommunityIcons name="camera" size={22} color={COLORS.accent} />
            <Text style={styles.statNumber}>{myPhotos}</Text>
            <Text style={styles.statLabel}>My Photos</Text>
          </View>
        </View>
      )}

      <View style={styles.filterRow}>
        <TouchableOpacity style={[styles.filterChip, sortMode === 'newest' && styles.filterChipActive]} onPress={() => setSortMode('newest')}>
          <Text style={[styles.filterChipText, sortMode === 'newest' && styles.filterChipTextActive]}>Newest</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, sortMode === 'oldest' && styles.filterChipActive]} onPress={() => setSortMode('oldest')}>
          <Text style={[styles.filterChipText, sortMode === 'oldest' && styles.filterChipTextActive]}>Oldest</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, mineOnly && styles.filterChipActive]} onPress={() => setMineOnly((v) => !v)}>
          <Text style={[styles.filterChipText, mineOnly && styles.filterChipTextActive]}>Mine only</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {loadingPhotos ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.success} />
          <Text style={styles.loadingText}>Loading group memories...</Text>
        </View>
      ) : (
        <SectionList
          sections={gallerySections}
          contentContainerStyle={styles.scrollContainer}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.success}
            />
          }
          keyExtractor={(row, rowIndex) => {
            const firstPhotoId = row?.[0]?.photo?.id || `row_${rowIndex}`;
            return `${firstPhotoId}_${rowIndex}`;
          }}
          ListHeaderComponent={renderPendingUploads}
          ListEmptyComponent={renderEmptyState}
          ListFooterComponent={<View style={{ height: 40 }} />}
          renderSectionHeader={({ section }) => (
            <View style={styles.dateGroup}>
              <View style={styles.dateHeader}>
                <MaterialCommunityIcons name="calendar" size={16} color={COLORS.textSecondary} />
                <Text style={styles.dateHeaderText}>{section.title}</Text>
                <Text style={styles.datePhotoCount}>
                  {section.photos.length} {section.photos.length === 1 ? 'photo' : 'photos'}
                </Text>
              </View>
            </View>
          )}
          renderItem={({ item: row, section }) => (
            <View style={styles.gridRow}>
              {row.map(({ photo, photoIndexInSection }) => (
                <TouchableOpacity
                  key={photo.id}
                  style={styles.imageTouchable}
                  onPress={() => openViewer(section.sectionIndex, photoIndexInSection)}
                  activeOpacity={0.85}
                >
                  {!loadedImages[photo.id] && renderSkeleton()}
                  <Image
                    source={{ uri: photo.thumbnailUrl || photo.url }}
                    style={[
                      styles.imageThumbnail,
                      !loadedImages[photo.id] && styles.imageHidden,
                    ]}
                    resizeMode="contain"
                    onLoad={() => handleImageLoad(photo.id)}
                  />

                  {photo.userId === principalId && (
                    <View style={styles.myPhotoBadge}>
                      <MaterialCommunityIcons name="account" size={10} color={COLORS.white} />
                    </View>
                  )}

                  {photo.caption && (
                    <View style={styles.captionIndicator}>
                      <MaterialCommunityIcons name="text" size={12} color={COLORS.white} />
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
          onViewableItemsChanged={onViewableItemsChanged.current}
          viewabilityConfig={viewabilityConfig.current}
          initialNumToRender={9}
          maxToRenderPerBatch={6}
          windowSize={7}
          removeClippedSubviews
          stickySectionHeadersEnabled={false}
        />
      )}

      {/* Floating Action Button */}
      {!loadingPhotos && visiblePhotos.length > 0 && (
        <TouchableOpacity
          style={styles.fab}
          onPress={showUploadOptions}
          activeOpacity={0.9}
          disabled={false}
        >
          <LinearGradient
            colors={[COLORS.success, '#22C55E']}
            style={styles.fabGradient}
          >
            <MaterialCommunityIcons name="camera-plus" size={28} color={COLORS.white} />
          </LinearGradient>
        </TouchableOpacity>
      )}

      {/* Image Viewer */}
      <ImageViewer
        visible={viewerVisible}
        photos={visiblePhotos}
        initialIndex={viewerIndex}
        onClose={() => setViewerVisible(false)}
        onDelete={handleDeletePhoto}
        canDelete={true}
        currentUserId={principalId}
        showUploaderInfo={true}
        onEditCaption={async (photo, nextCaption) => photoService.updatePhotoCaption({ tourId, photoId: photo.id, userId: principalId, caption: nextCaption, visibility: 'group' })}
      />

      {/* Upload Modal with Caption */}
      <Modal
        visible={showUploadModal}
        transparent
        animationType="slide"
        onRequestClose={cancelUpload}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.uploadModal}>
            <View style={styles.uploadModalHandle} />

            <Text style={styles.uploadModalTitle}>Share with Group</Text>
            <Text style={styles.uploadModalSubtitle}>Everyone on the tour will see this photo</Text>

            {pendingImage?.uri && (
              <Image
                source={{ uri: pendingImage.uri }}
                style={styles.uploadPreview}
                resizeMode="cover"
              />
            )}

            <TextInput
              style={styles.captionInput}
              placeholder="Add a caption to share the story..."
              placeholderTextColor={COLORS.textMuted}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={200}
            />

            <Text style={styles.charCount}>{caption.length}/200</Text>

            <View style={styles.uploadModalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={cancelUpload}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.uploadButton}
                onPress={handleUpload}
              >
                <MaterialCommunityIcons name="share" size={20} color={COLORS.white} />
                <Text style={styles.uploadButtonText}>Share</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: Platform.OS === 'ios' ? 12 : 16,
    ...SHADOWS.md,
  },
  headerButton: {
    padding: SPACING.sm,
    minWidth: 44,
    alignItems: 'center',
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: RADIUS.full,
    marginTop: 4,
    gap: 4,
  },
  headerBadgeText: {
    fontSize: 11,
    color: COLORS.white,
    fontWeight: '600',
  },
  filterRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  filterChip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    backgroundColor: COLORS.white,
  },
  filterChipActive: {
    borderColor: COLORS.success,
    backgroundColor: COLORS.successLight,
  },
  filterChipText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  filterChipTextActive: { color: COLORS.success },
  pendingSection: { marginBottom: SPACING.lg },
  pendingTitle: { marginHorizontal: SPACING.lg, marginBottom: SPACING.sm, fontSize: 14, fontWeight: '700', color: COLORS.textPrimary },
  pendingOverlay: { position: 'absolute', left: 0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.55)', alignItems:'center', paddingVertical: 6 },
  pendingProgressText: { color: COLORS.white, fontWeight:'700', fontSize: 12 },
  retryButton: { marginTop: 4, backgroundColor: COLORS.error, borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 2 },
  retryButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '700' },
  progressContainer: {
    backgroundColor: COLORS.successLight,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  progressContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  progressText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.success,
  },
  progressBar: {
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.success,
    borderRadius: 2,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.lg,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
    ...SHADOWS.md,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginTop: 4,
  },
  statLabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 40,
    backgroundColor: COLORS.border,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: SPACING.md,
    fontSize: 16,
    color: COLORS.textSecondary,
  },
  scrollContainer: {
    padding: SPACING.lg,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: SPACING.xl,
  },
  emptyIconWrapper: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.successLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 16,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: SPACING.md,
    lineHeight: 24,
  },
  emptyActions: {
    marginTop: SPACING.xxl,
    gap: SPACING.md,
    width: '100%',
    alignItems: 'center',
  },
  emptyCtaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.lg,
    backgroundColor: COLORS.success,
    borderRadius: RADIUS.lg,
    width: '80%',
    ...SHADOWS.md,
  },
  emptyCtaText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 16,
  },
  emptySecondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.lg,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    borderWidth: 2,
    borderColor: COLORS.success,
    width: '80%',
  },
  emptySecondaryText: {
    color: COLORS.success,
    fontWeight: '700',
    fontSize: 16,
  },
  tipContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.warningLight,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    marginTop: SPACING.xxl,
    gap: SPACING.sm,
    width: '100%',
  },
  tipText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 1,
    lineHeight: 18,
  },
  dateGroup: {
    marginBottom: SPACING.xl,
  },
  dateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  dateHeaderText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flex: 1,
  },
  datePhotoCount: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  gridRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  imageTouchable: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: COLORS.border,
  },
  imageThumbnail: {
    width: '100%',
    height: '100%',
  },
  imageHidden: {
    opacity: 0,
    position: 'absolute',
  },
  skeleton: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.border,
    overflow: 'hidden',
  },
  skeletonShimmer: {
    width: '100%',
    height: '100%',
    backgroundColor: '#E2E8F0',
  },
  myPhotoBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: COLORS.success,
    borderRadius: RADIUS.full,
    padding: 4,
  },
  captionIndicator: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: RADIUS.full,
    padding: 4,
  },
  fab: {
    position: 'absolute',
    right: SPACING.xl,
    bottom: Platform.OS === 'ios' ? 30 : 20,
    ...SHADOWS.xl,
  },
  fabGradient: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'flex-end',
  },
  uploadModal: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
  },
  uploadModalHandle: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: SPACING.lg,
  },
  uploadModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  uploadModalSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: SPACING.lg,
  },
  uploadPreview: {
    width: '100%',
    height: 200,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.lg,
  },
  captionInput: {
    backgroundColor: COLORS.background,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    fontSize: 16,
    color: COLORS.textPrimary,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  charCount: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'right',
    marginTop: SPACING.sm,
  },
  uploadModalActions: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.lg,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.background,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  uploadButton: {
    flex: 2,
    flexDirection: 'row',
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.success,
  },
  uploadButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.white,
  },
});
