// screens/GroupPhotobookScreen.js
// Enhanced group photobook with contributor info, date grouping, and premium viewing experience
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
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
import { uploadPhoto, subscribeToTourPhotos, updatePhotoCaption } from '../services/photoService';
import { optimizeImageForUpload, formatBytes } from '../services/imageOptimizationService';
import { deleteGroupPhoto } from '../services/photoService';
import ImageViewer from '../components/ImageViewer';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../theme';

const { width: windowWidth } = Dimensions.get('window');
const THUMBNAIL_SIZE = (windowWidth - SPACING.lg * 2 - SPACING.sm * 2) / 3;

export default function GroupPhotobookScreen({ onBack, userId, tourId, userName }) {
  const MIN_REFRESH_SPINNER_MS = 120;
  const [photos, setPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [sortMode, setSortMode] = useState('newest');
  const [mineOnly, setMineOnly] = useState(false);

  // Image viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);
  const [caption, setCaption] = useState('');

  // Image loading states for skeleton
  const [loadedImages, setLoadedImages] = useState({});

  useEffect(() => {
    if (!tourId) return undefined;

    setLoadingPhotos(true);
    const unsubscribe = subscribeToTourPhotos(tourId, (photoList) => {
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

  const visiblePhotos = useMemo(() => {
    const scoped = mineOnly ? photos.filter((photo) => photo.userId === userId) : photos;
    return [...scoped].sort((a, b) => {
      const aTs = a.timestamp || 0;
      const bTs = b.timestamp || 0;
      return sortMode === 'oldest' ? aTs - bTs : bTs - aTs;
    });
  }, [photos, mineOnly, sortMode, userId]);

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups = {};
    visiblePhotos.forEach(photo => {
      const date = photo.timestamp
        ? new Date(photo.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })
        : 'Unknown Date';

      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(photo);
    });
    return groups;
  }, [visiblePhotos]);

  const dateKeys = Object.keys(groupedPhotos);

  // Stats
  const totalPhotos = visiblePhotos.length;
  const uniqueContributors = useMemo(() => {
    const contributors = new Set(visiblePhotos.map(p => p.userId).filter(Boolean));
    return contributors.size;
  }, [visiblePhotos]);
  const myPhotos = visiblePhotos.filter(p => p.userId === userId).length;

  useEffect(() => {
    visiblePhotos.slice(0, 24).forEach((photo) => {
      const previewUrl = photo?.thumbnailUrl || photo?.url;
      if (previewUrl) Image.prefetch(previewUrl).catch(() => {});
    });
  }, [visiblePhotos]);

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
      allowsEditing: true,
      aspect: [4, 3],
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
      allowsEditing: true,
      aspect: [4, 3],
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

  const getUploadErrorMessage = (error) => {
    switch (error?.code) {
      case 'file-too-large':
        return 'Please choose a photo smaller than 5MB to upload.';
      case 'permission-denied':
        return 'Please check your connection or permissions and try again.';
      case 'network-error':
        return 'Network error occurred while uploading. Please try again.';
      case 'invalid-params':
        return 'Something went wrong preparing your photo. Please try again.';
      default:
        return 'Could not upload your photo. Please try again.';
    }
  };

  const uploadPendingItem = async (pending) => {
    setPendingUploads((prev) => prev.map((item) => item.id === pending.id ? { ...item, status: 'uploading', error: null, progress: 0 } : item));
    try {
      await uploadPhoto(pending.uri, tourId, userId, pending.caption.trim(), {
        visibility: 'group',
        uploaderName: userName || 'Tour Member',
        thumbnailUri: pending.thumbnailUri || null,
        optimizationMetrics: pending.metrics || null,
        onProgress: (ratio) => {
          const percent = Math.round((ratio || 0) * 100);
          setUploadProgress(percent);
          setPendingUploads((prev) => prev.map((item) => item.id === pending.id ? { ...item, progress: percent } : item));
        },
      });
      setPendingUploads((prev) => prev.filter((item) => item.id !== pending.id));
    } catch (error) {
      setPendingUploads((prev) => prev.map((item) => item.id === pending.id ? { ...item, status: 'failed', error: getUploadErrorMessage(error), progress: 0 } : item));
    }
  };

  const handleUpload = async () => {
    if (!pendingImage?.uri) return;

    setUploading(true);
    setUploadProgress(0);

    try {
      const optimized = await optimizeImageForUpload(pendingImage);
      const pending = {
        id: `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        uri: optimized.uploadUri,
        thumbnailUri: optimized.thumbnailUri,
        previewUri: pendingImage.uri,
        caption,
        progress: 0,
        status: 'queued',
        error: null,
        metrics: optimized.metrics,
      };

      setShowUploadModal(false);
      setPendingUploads((prev) => [pending, ...prev]);
      setPendingImage(null);
      setCaption('');

      await uploadPendingItem(pending);

      if (optimized.metrics?.originalSizeBytes && optimized.metrics?.optimizedSizeBytes) {
        Alert.alert(
          'Photo optimized',
          `Saved ${formatBytes(optimized.metrics.originalSizeBytes - optimized.metrics.optimizedSizeBytes)} before upload.`
        );
      }
    } catch (error) {
      Alert.alert('Image preparation failed', 'Could not optimize this image. Please try a different photo.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const retryUpload = async (pending) => {
    await uploadPendingItem(pending);
  };

  const cancelUpload = () => {
    setShowUploadModal(false);
    setPendingImage(null);
    setCaption('');
  };

  const openViewer = (groupIndex, photoIndexInGroup) => {
    // Calculate the flat index across all photos
    let flatIndex = 0;
    for (let i = 0; i < groupIndex; i++) {
      flatIndex += groupedPhotos[dateKeys[i]].length;
    }
    flatIndex += photoIndexInGroup;

    setViewerIndex(flatIndex);
    setViewerVisible(true);
  };

  const handleDeletePhoto = async (photo) => {
    try {
      if (typeof deleteGroupPhoto === 'function') {
        await deleteGroupPhoto(tourId, photo.id, userId);
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

        unsubscribe = subscribeToTourPhotos(tourId, handleSnapshot);
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
          disabled={uploading}
        >
          <MaterialCommunityIcons name="camera-plus" size={26} color={COLORS.white} />
        </TouchableOpacity>
      </LinearGradient>

      {/* Upload Progress Bar */}
      {uploading && (
        <View style={styles.progressContainer}>
          <View style={styles.progressContent}>
            <ActivityIndicator size="small" color={COLORS.success} />
            <Text style={styles.progressText}>
              Sharing with group... {Math.round(uploadProgress)}%
            </Text>
          </View>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
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
        <ScrollView
          contentContainerStyle={styles.scrollContainer}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.success}
            />
          }
        >
          {pendingUploads.length > 0 && (
            <View style={styles.pendingSection}>
              <Text style={styles.pendingTitle}>Uploads</Text>
              <View style={styles.grid}>
                {pendingUploads.map((item) => (
                  <View key={item.id} style={styles.imageTouchable}>
                    <Image source={{ uri: item.previewUri || item.uri }} style={styles.imageThumbnail} />
                    <View style={styles.pendingOverlay}>
                      {item.status === 'failed' ? (
                        <>
                          <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.white} />
                          <TouchableOpacity onPress={() => retryUpload(item)} style={styles.retryButton}>
                            <Text style={styles.retryButtonText}>Retry</Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <Text style={styles.pendingProgressText}>{item.progress}%</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          {visiblePhotos.length === 0 && pendingUploads.length === 0 ? (
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
          ) : (
            dateKeys.map((dateKey, groupIndex) => (
              <View key={dateKey} style={styles.dateGroup}>
                <View style={styles.dateHeader}>
                  <MaterialCommunityIcons name="calendar" size={16} color={COLORS.textSecondary} />
                  <Text style={styles.dateHeaderText}>{dateKey}</Text>
                  <Text style={styles.datePhotoCount}>
                    {groupedPhotos[dateKey].length} {groupedPhotos[dateKey].length === 1 ? 'photo' : 'photos'}
                  </Text>
                </View>

                <View style={styles.grid}>
                  {groupedPhotos[dateKey].map((photo, photoIndex) => (
                    <TouchableOpacity
                      key={photo.id}
                      style={styles.imageTouchable}
                      onPress={() => openViewer(groupIndex, photoIndex)}
                      activeOpacity={0.85}
                    >
                      {!loadedImages[photo.id] && renderSkeleton()}
                      <Image
                        source={{ uri: photo.thumbnailUrl || photo.url }}
                        style={[
                          styles.imageThumbnail,
                          !loadedImages[photo.id] && styles.imageHidden,
                        ]}
                        onLoad={() => handleImageLoad(photo.id)}
                      />

                      {/* Contributor badge */}
                      {photo.userId === userId && (
                        <View style={styles.myPhotoBadge}>
                          <MaterialCommunityIcons name="account" size={10} color={COLORS.white} />
                        </View>
                      )}

                      {/* Caption indicator */}
                      {photo.caption && (
                        <View style={styles.captionIndicator}>
                          <MaterialCommunityIcons name="text" size={12} color={COLORS.white} />
                        </View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))
          )}

          {/* Bottom padding */}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* Floating Action Button */}
      {!loadingPhotos && visiblePhotos.length > 0 && (
        <TouchableOpacity
          style={styles.fab}
          onPress={showUploadOptions}
          activeOpacity={0.9}
          disabled={uploading}
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
        currentUserId={userId}
        showUploaderInfo={true}
        onEditCaption={async (photo, nextCaption) => updatePhotoCaption({ tourId, photoId: photo.id, userId, caption: nextCaption, visibility: 'group' })}
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
