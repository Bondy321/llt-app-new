import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as offlineSyncService from '../../services/offlineSyncService';
import * as photoService from '../../services/photoService';
import { checkTextForObjectionableContent } from '../../services/contentModerationService';
import { optimizeSourcePhotoForUpload, formatBytes } from '../../services/imageOptimizationService';
import logger, { maskIdentifier } from '../../services/loggerService';

export const createGroupPhotoUploadActions = ({
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
}) => {
  const requestCameraPermission = async () => {
    logger.info('GroupPhotobook', 'Camera permission requested', { tourId });
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        logger.warn('GroupPhotobook', 'Camera permission denied', { tourId, status });
        Alert.alert('Camera access needed', 'Allow camera access in your device settings to take a photo.');
        return false;
      }
      logger.info('GroupPhotobook', 'Camera permission granted', { tourId });
      return true;
    } catch (error) {
      logger.warn('GroupPhotobook', 'Camera permission request failed', { tourId, error: error?.message || String(error) });
      Alert.alert('Camera unavailable', 'We could not open the camera permission prompt. Try again or check your device settings.');
      return false;
    }
  };

  const requestGalleryPermission = async () => {
    logger.info('GroupPhotobook', 'Gallery permission requested', { tourId });
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        logger.warn('GroupPhotobook', 'Gallery permission denied', { tourId, status });
        Alert.alert('Photo access needed', 'Allow photo access in your device settings to choose a photo.');
        return false;
      }
      logger.info('GroupPhotobook', 'Gallery permission granted', { tourId });
      return true;
    } catch (error) {
      logger.warn('GroupPhotobook', 'Gallery permission request failed', { tourId, error: error?.message || String(error) });
      Alert.alert('Photos unavailable', 'We could not open the photo permission prompt. Try again or check your device settings.');
      return false;
    }
  };

  const handleTakePhoto = async () => {
    logger.info('GroupPhotobook', 'Take photo flow started', { tourId });
    const hasPermission = await requestCameraPermission();
    if (!hasPermission) return;

    let result;
    try {
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
    } catch (error) {
      logger.warn('GroupPhotobook', 'Camera launch failed', { tourId, error: error?.message || String(error) });
      Alert.alert('Camera unavailable', 'We could not open the camera. Please try again.');
      return;
    }

    if (!result.canceled && result.assets?.[0]) {
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
      logger.info('GroupPhotobook', 'Camera image selected', {
        tourId,
        assetCount: result.assets.length,
        hasUri: Boolean(result.assets[0]?.uri),
        width: result.assets[0]?.width || null,
        height: result.assets[0]?.height || null,
      });
    } else {
      logger.info('GroupPhotobook', 'Take photo flow cancelled', { tourId });
    }
  };

  const handlePickFromGallery = async () => {
    logger.info('GroupPhotobook', 'Gallery picker flow started', { tourId });
    const hasPermission = await requestGalleryPermission();
    if (!hasPermission) return;

    let result;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
    } catch (error) {
      logger.warn('GroupPhotobook', 'Photo library launch failed', { tourId, error: error?.message || String(error) });
      Alert.alert('Photos unavailable', 'We could not open your photo library. Please try again.');
      return;
    }

    if (!result.canceled && result.assets?.[0]) {
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
      logger.info('GroupPhotobook', 'Gallery image selected', {
        tourId,
        assetCount: result.assets.length,
        hasUri: Boolean(result.assets[0]?.uri),
        width: result.assets[0]?.width || null,
        height: result.assets[0]?.height || null,
      });
    } else {
      logger.info('GroupPhotobook', 'Gallery picker flow cancelled', { tourId });
    }
  };

  const showUploadOptions = () => {
    logger.info('GroupPhotobook', 'Upload options opened', {
      tourId,
      visiblePhotoCount: visiblePhotos.length,
      queuedCount: photoQueueItems.length,
      mineOnly,
      sortMode,
    });
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
    if (uploading) return;

    if (!pendingImage?.uri) {
      logger.warn('GroupPhotobook', 'Upload blocked without pending image', { tourId });
      return;
    }

    const moderationResult = checkTextForObjectionableContent(caption);
    if (!moderationResult.allowed) {
      Alert.alert('Caption needs editing', moderationResult.message);
      return;
    }

    setUploading(true);
    try {
      logger.info('GroupPhotobook', 'Group photo enqueue started', {
        tourId,
        userId: maskIdentifier(principalId),
        hasCaption: Boolean(caption.trim()),
        captionLength: caption.trim().length,
      });
      const optimized = await optimizeSourcePhotoForUpload(pendingImage);
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
        scope: {
          tourId,
          principalId,
          role: canonicalIdentity?.principalType === 'driver' ? 'driver' : 'passenger',
          authUid: canonicalIdentity?.authUid || null,
        },
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
      });
      if (!enqueueResult.success) {
        logger.warn('GroupPhotobook', 'Group photo enqueue failed', {
          tourId,
          jobId,
          error: enqueueResult.error || 'unknown',
        });
        Alert.alert('Upload queue failed', 'Could not queue upload. Please try again.');
        return;
      }
      logger.info('GroupPhotobook', 'Group photo enqueued', {
        tourId,
        jobId,
        optimized: Boolean(optimized.metrics),
        originalSizeBytes: optimized.metrics?.originalSizeBytes || null,
        optimizedSizeBytes: optimized.metrics?.optimizedSizeBytes || null,
      });

      setShowUploadModal(false);
      setPendingImage(null);
      setCaption('');
      offlineSyncService.replayQueue({ services: { photoService } }).then((result) => {
        logger.info('GroupPhotobook', 'Group photo replay requested after enqueue completed', {
          tourId,
          jobId,
          success: Boolean(result?.success),
          processed: result?.data?.processed ?? null,
          failed: result?.data?.failed ?? null,
        });
      }).catch((error) => {
        logger.warn('GroupPhotobook', 'Group photo replay after enqueue failed', {
          tourId,
          jobId,
          error: error?.message || String(error),
        });
      });

      if (optimized.metrics?.originalSizeBytes && optimized.metrics?.optimizedSizeBytes) {
        Alert.alert(
          'Photo optimized',
          `Saved ${formatBytes(optimized.metrics.originalSizeBytes - optimized.metrics.optimizedSizeBytes)} before upload.`
        );
      }
    } catch (error) {
      logger.error('GroupPhotobook', 'Group photo preparation failed', {
        tourId,
        error: error?.message || String(error),
      });
      Alert.alert('Image preparation failed', 'Could not optimize this image. Please try a different photo.');
    } finally {
      setUploading(false);
    }
  };

  const retryUpload = async (pending) => {
    logger.info('GroupPhotobook', 'Group photo retry requested', {
      tourId,
      actionId: pending?.id || null,
      previousStatus: pending?.status || null,
    });
    await offlineSyncService.updateAction(pending.id, {
      status: 'retrying',
      nextAttemptAt: null,
      lastError: null,
    });
    await offlineSyncService.replayQueue({ services: { photoService } });
  };

  const discardUpload = async (pending) => {
    if (!pending?.id) return;
    logger.info('GroupPhotobook', 'Group photo discard requested', {
      tourId,
      actionId: pending.id,
      previousStatus: pending.status || null,
    });
    const result = await offlineSyncService.removeAction(pending.id);
    if (!result.success) {
      logger.warn('GroupPhotobook', 'Group photo discard failed', {
        tourId,
        actionId: pending.id,
        error: result.error || 'unknown',
      });
      Alert.alert('Discard failed', 'Could not remove this photo from the upload queue.');
      return;
    }
    logger.info('GroupPhotobook', 'Group photo discarded', { tourId, actionId: pending.id });
    setPhotoQueueItems((items) => items.filter((item) => item.id !== pending.id));
  };

  const cancelUpload = () => {
    if (uploading) return;
    logger.info('GroupPhotobook', 'Upload modal cancelled', {
      tourId,
      hadPendingImage: Boolean(pendingImage?.uri),
      captionLength: caption.length,
    });
    setShowUploadModal(false);
    setPendingImage(null);
    setCaption('');
  };


  return {
    cancelUpload,
    discardUpload,
    handlePickFromGallery,
    handleTakePhoto,
    handleUpload,
    retryUpload,
    showUploadOptions,
  };
};
