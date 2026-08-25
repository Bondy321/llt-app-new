import createPhotobookScreenStyles from '../../screens/styles/PhotobookScreen.styles';
import {
  ActivityIndicator, Image as RNImage, KeyboardAvoidingView, Modal, Platform,
  RefreshControl, SectionList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import GalleryPhotoTile from '../GalleryPhotoTile';
import ImageViewer from '../ImageViewer';
import * as photoService from '../../services/photoService';
import { summarizeQueueAction, summarizeUri } from '../../services/crashDiagnosticsService';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { getPhotoRowItems, resolveQueuedUploadPreviewUri, resolveQueuedUploadSourceUri } from './privatePhotoModel';

const styles = createPhotobookScreenStyles({ StyleSheet, COLORS, Platform, RADIUS, SHADOWS, SPACING });

export default function PhotobookView({
  cancelUpload,
  caption,
  dateKeys,
  discardUpload,
  handleDeletePhoto,
  handlePickFromGallery,
  handleTakePhoto,
  handleUpload,
  hasDisplayablePhoto,
  latestPhotoDate,
  loadMore,
  loadingMore,
  loadingPhotos,
  onBack,
  onRefresh,
  onViewableItemsChanged,
  openViewer,
  pendingImage,
  photoLoadError,
  photoQueueItems,
  photoSections,
  principalId,
  recordTileImageEvent,
  refreshing,
  retryUpload,
  setCaption,
  setSortMode,
  setViewerVisible,
  showUploadModal,
  showUploadOptions,
  sortMode,
  thumbnailTileStyle,
  totalPhotos,
  tourId,
  tracePrivatePhotos,
  uploading,
  viewerIndex,
  viewerVisible,
  visiblePhotos,
}) {
  const renderGalleryFooter = () => {
    const showMemoryPrompt = visiblePhotos.length > 0 && visiblePhotos.length <= 6;

    return (
      <View style={styles.listFooter}>
        {loadingMore && (
          <ActivityIndicator size="small" color={COLORS.primary} />
        )}

        {showMemoryPrompt && (
          <View style={styles.memoryPromptCard}>
            <View style={styles.memoryPromptIcon}>
              <MaterialCommunityIcons name="image-plus" size={24} color={COLORS.primary} />
            </View>
            <View style={styles.memoryPromptCopy}>
              <Text style={styles.memoryPromptTitle}>Add another memory</Text>
              <Text style={styles.memoryPromptText}>Keep this tour close with a few more private photos.</Text>
            </View>
            <View style={styles.memoryPromptActions}>
              <TouchableOpacity
                style={styles.memoryPromptButton}
                onPress={handleTakePhoto}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Take photo"
              >
                <MaterialCommunityIcons name="camera" size={18} color={COLORS.primary} />
                <Text style={styles.memoryPromptButtonText}>Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.memoryPromptButton}
                onPress={handlePickFromGallery}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Choose from gallery"
              >
                <MaterialCommunityIcons name="image-multiple" size={18} color={COLORS.primary} />
                <Text style={styles.memoryPromptButtonText}>Gallery</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <LinearGradient
        colors={[COLORS.primary, COLORS.primaryLight]}
        style={styles.header}
      >
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit>
            My Photos
          </Text>
          <View style={styles.headerBadge}>
            <MaterialCommunityIcons name="lock" size={12} color={COLORS.white} />
            <Text style={styles.headerBadgeText}>Private</Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={showUploadOptions}
          style={styles.headerButton}
          activeOpacity={0.7}
          disabled={false}
          accessibilityRole="button"
          accessibilityLabel="Add photo"
        >
          <MaterialCommunityIcons name="camera-plus" size={26} color={COLORS.white} />
        </TouchableOpacity>
      </LinearGradient>

      {/* Upload Progress Bar */}
      {photoQueueItems.length > 0 && (
        <View style={styles.progressContainer}>
          <View style={styles.progressContent}>
            <ActivityIndicator size="small" color={COLORS.primary} />
            <Text style={styles.progressText}>Uploads in queue: {photoQueueItems.length}</Text>
          </View>
        </View>
      )}

      {photoLoadError && (
        <View style={styles.errorBanner}>
          <MaterialCommunityIcons name="cloud-alert-outline" size={20} color={COLORS.sync.warning.foreground} />
          <View style={styles.errorBannerCopy}>
            <Text style={styles.errorBannerTitle}>Private photos did not fully refresh</Text>
            <Text style={styles.errorBannerText}>Your saved photos are still available where possible.</Text>
          </View>
          <TouchableOpacity onPress={onRefresh} style={styles.errorRetryButton} activeOpacity={0.85}>
            <Text style={styles.errorRetryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Stats Hero Section */}
      {!loadingPhotos && visiblePhotos.length > 0 && (
        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <MaterialCommunityIcons name="image-multiple" size={22} color={COLORS.primary} />
            <Text style={styles.statNumber}>{totalPhotos}</Text>
            <Text style={styles.statLabel}>Photos</Text>
          </View>
          {latestPhotoDate && (
            <View style={styles.statDivider} />
          )}
          {latestPhotoDate && (
            <View style={styles.statItem}>
              <MaterialCommunityIcons name="clock-outline" size={22} color={COLORS.accent} />
              <Text style={styles.statNumber}>{latestPhotoDate}</Text>
              <Text style={styles.statLabel}>Latest</Text>
            </View>
          )}
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <MaterialCommunityIcons name="calendar-range" size={22} color={COLORS.success} />
            <Text style={styles.statNumber}>{dateKeys.length}</Text>
            <Text style={styles.statLabel}>{dateKeys.length === 1 ? 'Day' : 'Days'}</Text>
          </View>
        </View>
      )}

      <View style={styles.filterRow}>
        <TouchableOpacity
          style={[styles.filterChip, sortMode === 'newest' && styles.filterChipActive]}
          onPress={() => setSortMode('newest')}
          accessibilityRole="button"
          accessibilityState={{ selected: sortMode === 'newest' }}
        >
          <Text style={[styles.filterChipText, sortMode === 'newest' && styles.filterChipTextActive]}>Newest</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterChip, sortMode === 'oldest' && styles.filterChipActive]}
          onPress={() => setSortMode('oldest')}
          accessibilityRole="button"
          accessibilityState={{ selected: sortMode === 'oldest' }}
        >
          <Text style={[styles.filterChipText, sortMode === 'oldest' && styles.filterChipTextActive]}>Oldest</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {loadingPhotos ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>Loading your memories...</Text>
        </View>
      ) : (
        visiblePhotos.length === 0 && photoQueueItems.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrapper}>
              <MaterialCommunityIcons name="lock-outline" size={60} color={COLORS.primary} />
            </View>
            <Text style={styles.emptyTitle}>Your Private Album</Text>
            <Text style={styles.emptySubtext}>
              Capture special moments from your tour. Only you can see these photos - they're your personal keepsakes.
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
                <MaterialCommunityIcons name="image-plus" size={22} color={COLORS.primary} />
                <Text style={styles.emptySecondaryText}>Choose from Gallery</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <SectionList
            sections={photoSections}
            keyExtractor={(item, index) => {
              const rowPhotos = getPhotoRowItems(item);
              if (rowPhotos.length === 0) {
                tracePrivatePhotos('section_key_unexpected_item', {
                  index,
                  itemType: item === null ? 'null' : typeof item,
                  isArray: Array.isArray(item),
                }, { remote: true });
                return `row-${index}`;
              }
              return rowPhotos.map((photo) => photo.id || photo.viewerUrl || photo.thumbnailUrl || photo.sourceUrl).filter(Boolean).join('|') || `row-${index}`;
            }}
            renderSectionHeader={({ section }) => (
              <View style={styles.dateHeader}>
                <MaterialCommunityIcons name="calendar" size={16} color={COLORS.textSecondary} />
                <Text style={styles.dateHeaderText}>{section.title}</Text>
                <Text style={styles.datePhotoCount}>
                  {section.photoCount} {section.photoCount === 1 ? 'photo' : 'photos'}
                </Text>
              </View>
            )}
            renderItem={({ item, index }) => {
              const rowPhotos = getPhotoRowItems(item);
              if (rowPhotos.length === 0) {
                tracePrivatePhotos('section_render_unexpected_item', {
                  index,
                  itemType: item === null ? 'null' : typeof item,
                  isArray: Array.isArray(item),
                }, { remote: true });
                return null;
              }

              return (
                <View style={styles.gridRow}>
                  {rowPhotos.map((photo) => (
                    <GalleryPhotoTile
                      key={photo.id || photo.viewerUrl || photo.thumbnailUrl}
                      photo={photo}
                      style={thumbnailTileStyle}
                      onPress={() => openViewer(photo.id)}
                      accessibilityLabel={`Open photo${photo.caption ? `: ${photo.caption}` : ''}`}
                      accessibilityHint="Opens this photo full screen"
                      useExpoImage={false}
                      onImageLoadStart={(itemPhoto) => recordTileImageEvent('load_start', itemPhoto)}
                      onImageLoad={(itemPhoto) => recordTileImageEvent('load', itemPhoto)}
                      onImageError={(itemPhoto, event) => recordTileImageEvent('error', itemPhoto, event)}
                    >
                      {!hasDisplayablePhoto(photo) && (
                        <View style={styles.unavailableBadge}>
                          <MaterialCommunityIcons name="image-off-outline" size={14} color={COLORS.white} />
                        </View>
                      )}

                      {photo.caption && (
                        <View style={styles.captionIndicator}>
                          <MaterialCommunityIcons name="text" size={12} color={COLORS.white} />
                        </View>
                      )}
                    </GalleryPhotoTile>
                  ))}
                </View>
              );
            }}
            renderSectionFooter={() => <View style={styles.sectionSpacer} />}
            ListHeaderComponent={photoQueueItems.length > 0 ? (
              <View style={styles.pendingSection}>
                <Text style={styles.pendingTitle}>Uploads</Text>
                <View style={styles.grid}>
                  {photoQueueItems.map((item) => {
                    const previewUri = resolveQueuedUploadPreviewUri(item);
                    const canRetry = Boolean(resolveQueuedUploadSourceUri(item));

                    return (
                      <View key={item.id} style={thumbnailTileStyle}>
                        {previewUri ? (
                          <RNImage
                            source={{ uri: previewUri }}
                            style={styles.imageThumbnail}
                            resizeMode="cover"
                            onLoadStart={() => tracePrivatePhotos('queue_preview_load_start', {
                              action: summarizeQueueAction(item),
                              previewUri: summarizeUri(previewUri),
                            })}
                            onLoad={() => tracePrivatePhotos('queue_preview_load', {
                              action: summarizeQueueAction(item),
                              previewUri: summarizeUri(previewUri),
                            })}
                            onError={(event) => tracePrivatePhotos('queue_preview_error', {
                              action: summarizeQueueAction(item),
                              previewUri: summarizeUri(previewUri),
                              nativeEvent: event?.nativeEvent || null,
                            }, { remote: true })}
                          />
                        ) : (
                          <View style={[styles.imageThumbnail, styles.pendingPlaceholder]}>
                            <MaterialCommunityIcons name="image-off-outline" size={26} color={COLORS.textMuted} />
                          </View>
                        )}
                        <View style={styles.pendingOverlay}>
                          {item.status === 'failed' ? (
                            <>
                              <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.white} />
                              <View style={styles.pendingActionRow}>
                                {canRetry && (
                                  <TouchableOpacity onPress={() => retryUpload(item)} style={styles.retryButton}>
                                    <Text style={styles.retryButtonText}>Retry</Text>
                                  </TouchableOpacity>
                                )}
                                <TouchableOpacity onPress={() => discardUpload(item)} style={[styles.retryButton, styles.discardButton]}>
                                  <Text style={styles.retryButtonText}>Discard</Text>
                                </TouchableOpacity>
                              </View>
                            </>
                          ) : (
                            <Text style={styles.pendingProgressText}>{item.status}</Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}
            ListFooterComponent={renderGalleryFooter}
            contentContainerStyle={styles.scrollContainer}
            showsVerticalScrollIndicator={false}
            stickySectionHeadersEnabled={false}
            onViewableItemsChanged={onViewableItemsChanged}
            onEndReached={loadMore}
            onEndReachedThreshold={0.45}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={COLORS.primary}
              />
            }
            removeClippedSubviews={Platform.OS === 'android'}
            initialNumToRender={12}
            maxToRenderPerBatch={9}
            updateCellsBatchingPeriod={60}
            windowSize={7}
          />
        )
      )}

      {/* Floating Action Button */}
      {!loadingPhotos && visiblePhotos.length > 0 && (
        <TouchableOpacity
          style={styles.fab}
          onPress={showUploadOptions}
          activeOpacity={0.9}
          disabled={false}
          accessibilityRole="button"
          accessibilityLabel="Add photo"
        >
          <LinearGradient
            colors={[COLORS.accent, '#FB923C']}
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
        showUploaderInfo={false}
        enablePrefetch={false}
        useExpoImage={false}
        onEditCaption={async (photo, nextCaption) => photoService.updatePhotoCaption({ tourId, photoId: photo.id, userId: principalId, caption: nextCaption, visibility: 'private' })}
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

            <Text style={styles.uploadModalTitle}>Add Caption</Text>
            <Text style={styles.uploadModalSubtitle}>Optional: describe this memory</Text>

            {pendingImage?.uri && (
              <RNImage
                source={{ uri: pendingImage.uri }}
                style={styles.uploadPreview}
                resizeMode="cover"
              />
            )}

            <TextInput
              style={styles.captionInput}
              placeholder="What's special about this moment?"
              placeholderTextColor={COLORS.textMuted}
              value={caption}
              onChangeText={setCaption}
              editable={!uploading}
              multiline
              maxLength={200}
            />

            <Text style={styles.charCount}>{caption.length}/200</Text>

            <View style={styles.uploadModalActions}>
              <TouchableOpacity
                style={[styles.cancelButton, uploading && styles.uploadButtonDisabled]}
                onPress={cancelUpload}
                disabled={uploading}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.uploadButton, uploading && styles.uploadButtonDisabled]}
                onPress={handleUpload}
                disabled={uploading}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <MaterialCommunityIcons name="upload" size={20} color={COLORS.white} />
                )}
                <Text style={styles.uploadButtonText}>{uploading ? 'Preparing...' : 'Upload'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
