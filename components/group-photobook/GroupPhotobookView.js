import createGroupPhotobookScreenStyles from '../../screens/styles/GroupPhotobookScreen.styles';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, RefreshControl, SectionList,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { Image as ExpoImage } from 'expo-image';
import ImageViewer from '../ImageViewer';
import GalleryPhotoTile from '../GalleryPhotoTile';
import * as photoService from '../../services/photoService';
import logger from '../../services/loggerService';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';

const styles = createGroupPhotobookScreenStyles({ StyleSheet, COLORS, Platform, RADIUS, SHADOWS, SPACING });

export default function GroupPhotobookView({
  caption,
  cancelUpload,
  discardUpload,
  gallerySections,
  handleDeletePhoto,
  handlePickFromGallery,
  handleReportPhoto,
  handleTakePhoto,
  handleUpload,
  loadMore,
  loadingMore,
  loadingPhotos,
  mineOnly,
  myPhotos,
  onBack,
  onRefresh,
  onViewableItemsChanged,
  openViewer,
  pendingImage,
  photoQueueItems,
  principalId,
  refreshing,
  retryUpload,
  setCaption,
  setMineOnly,
  setSortMode,
  setViewerVisible,
  showUploadModal,
  showUploadOptions,
  sortMode,
  thumbnailTileStyle,
  totalPhotos,
  tourId,
  uniqueContributors,
  uploading,
  viewerIndex,
  viewerVisible,
  visiblePhotos,
}) {
  const renderPendingUploads = () => {
    if (photoQueueItems.length === 0) return null;

    return (
      <View style={styles.pendingSection}>
        <Text style={styles.pendingTitle}>Uploads</Text>
        <View style={styles.grid}>
          {photoQueueItems.map((item) => (
            <View key={item.id} style={styles.imageTouchable}>
              <ExpoImage
                source={{ uri: item?.payload?.localAssets?.previewUri || item?.payload?.localAssets?.sourceUri }}
                style={styles.imageThumbnail}
                contentFit="cover"
                cachePolicy="memory-disk"
              />
              <View style={styles.pendingOverlay}>
                {item.status === 'failed' ? (
                  <>
                    <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.white} />
                    <View style={styles.pendingActionRow}>
                      <TouchableOpacity
                        onPress={() => retryUpload(item)}
                        style={styles.retryButton}
                        accessibilityRole="button"
                        accessibilityLabel="Retry group photo upload"
                      >
                        <Text style={styles.retryButtonText}>Retry</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => discardUpload(item)}
                        style={[styles.retryButton, styles.discardButton]}
                        accessibilityRole="button"
                        accessibilityLabel="Discard group photo upload"
                      >
                        <Text style={styles.retryButtonText}>Discard</Text>
                      </TouchableOpacity>
                    </View>
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
        <TouchableOpacity style={[styles.filterChip, sortMode === 'newest' && styles.filterChipActive]} onPress={() => {
          logger.debug('GroupPhotobook', 'Sort mode selected', { tourId, sortMode: 'newest' });
          setSortMode('newest');
        }}>
          <Text style={[styles.filterChipText, sortMode === 'newest' && styles.filterChipTextActive]}>Newest</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, sortMode === 'oldest' && styles.filterChipActive]} onPress={() => {
          logger.debug('GroupPhotobook', 'Sort mode selected', { tourId, sortMode: 'oldest' });
          setSortMode('oldest');
        }}>
          <Text style={[styles.filterChipText, sortMode === 'oldest' && styles.filterChipTextActive]}>Oldest</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, mineOnly && styles.filterChipActive]} onPress={() => setMineOnly((v) => {
          logger.debug('GroupPhotobook', 'Mine-only filter toggled', { tourId, enabled: !v });
          return !v;
        })}>
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
          ListFooterComponent={(
            <View style={styles.listFooter}>
              {loadingMore && <ActivityIndicator size="small" color={COLORS.success} />}
            </View>
          )}
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
                <GalleryPhotoTile
                  key={photo.id}
                  photo={photo}
                  style={thumbnailTileStyle}
                  onPress={() => openViewer(section.sectionIndex, photoIndexInSection)}
                  accessibilityLabel={`Open group photo${photo.caption ? `: ${photo.caption}` : ''}`}
                  accessibilityHint="Opens this photo full screen"
                >
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
                </GalleryPhotoTile>
              ))}
            </View>
          )}
          onViewableItemsChanged={onViewableItemsChanged}
          onEndReached={loadMore}
          onEndReachedThreshold={0.45}
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
          accessibilityRole="button"
          accessibilityLabel="Add a group photo"
          accessibilityHint="Choose a photo or take a new one"
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
        onReport={handleReportPhoto}
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
              <ExpoImage
                source={{ uri: pendingImage.uri }}
                style={styles.uploadPreview}
                contentFit="cover"
                cachePolicy="memory-disk"
              />
            )}

            <TextInput
              style={styles.captionInput}
              placeholder="Add a caption to share the story..."
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
                  <MaterialCommunityIcons name="share" size={20} color={COLORS.white} />
                )}
                <Text style={styles.uploadButtonText}>{uploading ? 'Preparing...' : 'Share'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
