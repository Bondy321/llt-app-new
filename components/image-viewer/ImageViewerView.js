import React from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image as RNImage,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS, FONT_WEIGHT, RADIUS, SHADOWS, SPACING } from '../../theme';
import { buildPhotoCacheKey } from '../../services/photoVariantService';
import createImageViewerStyles from '../styles/ImageViewer.styles';
import { buildImageSource, buildNativeImageSource, getPhotoKey } from './imageViewerModel';

const DARK_BACKGROUND = '#020617';
const styles = createImageViewerStyles({ StyleSheet, COLORS, DARK_BACKGROUND, FONT_WEIGHT, Platform, RADIUS, SHADOWS, SPACING });

export const ImageViewerPage = React.memo(function ImageViewerPage({
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


export default function ImageViewerView({
  visible,
  onClose,
  photos,
  pagerRef,
  renderPhotoPage,
  keyExtractor,
  safeInitialIndex,
  getItemLayout,
  handleMomentumScrollEnd,
  handleScrollToIndexFailed,
  runtimeWidth,
  runtimeHeight,
  fullQualityRequestedByPhotoKey,
  fadeAnim,
  chromeVisible,
  chromeAnim,
  currentIndex,
  setChromeVisible,
  setDetailsVisible,
  handleShare,
  handleSaveToDevice,
  saving,
  resolveCurrentPhotoUri,
  canRequestFullQuality,
  requestFullQuality,
  canReportThis,
  handleReport,
  reporting,
  canDeleteThis,
  handleDelete,
  detailsVisible,
  detailsAnim,
  detailsPanelMaxHeight,
  detailsTranslateY,
  currentPhoto,
  formatDate,
  showUploaderInfo,
  currentUploaderName,
  currentCaption,
  canEditCaption,
  startEditCaption,
  editingCaption,
  setEditingCaption,
  draftCaption,
  setDraftCaption,
  saveCaption,
  captionSaving,
}) {

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
