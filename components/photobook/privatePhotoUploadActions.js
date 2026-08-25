import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as offlineSyncService from '../../services/offlineSyncService';
import * as photoService from '../../services/photoService';
import { checkTextForObjectionableContent } from '../../services/contentModerationService';
import { optimizeSourcePhotoForUpload, formatBytes } from '../../services/imageOptimizationService';
import logger, { maskIdentifier } from '../../services/loggerService';
import { summarizeQueueAction, summarizeUri } from '../../services/crashDiagnosticsService';
import { verifyQueuedUploadSource } from './privatePhotoModel';

export const createPrivatePhotoUploadActions = ({
  canonicalIdentity,
  caption,
  pendingImage,
  principalId,
  privatePhotoOwnerKey,
  setCaption,
  setPendingImage,
  setPhotoQueueItems,
  setShowUploadModal,
  setUploading,
  tourId,
  tracePrivatePhotos,
  uploading,
}) => {
  const requestCameraPermission = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Camera access needed', 'Allow camera access in your device settings to take a photo.');
        return false;
      }
      return true;
    } catch (error) {
      logger.warn('Photobook', 'Camera permission request failed', { error: error?.message || String(error) });
      Alert.alert('Camera unavailable', 'We could not open the camera permission prompt. Try again or check your device settings.');
      return false;
    }
  };

  const requestGalleryPermission = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Photo access needed', 'Allow photo access in your device settings to choose a photo.');
        return false;
      }
      return true;
    } catch (error) {
      logger.warn('Photobook', 'Photo permission request failed', { error: error?.message || String(error) });
      Alert.alert('Photos unavailable', 'We could not open the photo permission prompt. Try again or check your device settings.');
      return false;
    }
  };

  const handleTakePhoto = async () => {
    tracePrivatePhotos('take_photo_pressed');
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
      logger.warn('Photobook', 'Camera launch failed', { error: error?.message || String(error) });
      Alert.alert('Camera unavailable', 'We could not open the camera. Please try again.');
      return;
    }

    if (!result.canceled && result.assets?.[0]) {
      tracePrivatePhotos('take_photo_selected', {
        asset: {
          uri: summarizeUri(result.assets[0]?.uri),
          width: result.assets[0]?.width || null,
          height: result.assets[0]?.height || null,
          fileSize: result.assets[0]?.fileSize || null,
          mimeType: result.assets[0]?.mimeType || null,
        },
      });
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
    }
  };

  const handlePickFromGallery = async () => {
    tracePrivatePhotos('pick_from_gallery_pressed');
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
      logger.warn('Photobook', 'Photo library launch failed', { error: error?.message || String(error) });
      Alert.alert('Photos unavailable', 'We could not open your photo library. Please try again.');
      return;
    }

    if (!result.canceled && result.assets?.[0]) {
      tracePrivatePhotos('gallery_photo_selected', {
        asset: {
          uri: summarizeUri(result.assets[0]?.uri),
          width: result.assets[0]?.width || null,
          height: result.assets[0]?.height || null,
          fileSize: result.assets[0]?.fileSize || null,
          mimeType: result.assets[0]?.mimeType || null,
        },
      });
      setPendingImage(result.assets[0]);
      setShowUploadModal(true);
    }
  };

  const showUploadOptions = () => {
    Alert.alert(
      'Add Photo',
      'Choose how you want to add a photo',
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
    if (uploading || !pendingImage?.uri) return;

    const moderationResult = checkTextForObjectionableContent(caption);
    if (!moderationResult.allowed) {
      Alert.alert('Caption needs editing', moderationResult.message);
      return;
    }

    setUploading(true);
    try {
      tracePrivatePhotos('upload_prepare_start', {
        pendingImage: {
          uri: summarizeUri(pendingImage.uri),
          width: pendingImage.width || null,
          height: pendingImage.height || null,
          fileSize: pendingImage.fileSize || null,
          mimeType: pendingImage.mimeType || null,
        },
      }, { remote: true });
      const optimized = await optimizeSourcePhotoForUpload(pendingImage);
      tracePrivatePhotos('upload_optimized', {
        uploadUri: summarizeUri(optimized?.uploadUri),
        metrics: optimized?.metrics || null,
      }, { remote: true });
      await ensurePrivatePhotoOwnerAccess();
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
          visibility: 'private',
          ownerId: principalId,
          userId: principalId,
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
      tracePrivatePhotos('upload_enqueued', {
        success: enqueueResult.success,
        error: enqueueResult.error || null,
        action: summarizeQueueAction(enqueueResult.data),
        ownerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
      }, { flush: true });
      if (!enqueueResult.success) {
        Alert.alert('Upload queue failed', 'Could not queue upload. Please try again.');
        return;
      }
      setShowUploadModal(false);
      setPendingImage(null);
      setCaption('');
      offlineSyncService.replayQueue({ services: { photoService } })
        .then((replayResult) => {
          tracePrivatePhotos('upload_replay_result', {
            success: Boolean(replayResult?.success),
            data: replayResult?.data || null,
            error: replayResult?.error || null,
            actionId: jobId,
            ownerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
          }, { flush: true });

          if (!replayResult?.success || replayResult?.data?.failed > 0) {
            logger.warn('PhotoDiagnostics', 'Private photo replay did not complete cleanly', {
              actionId: jobId,
              tourId,
              replayResult,
              ownerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
              principalId: maskIdentifier(principalId),
            });
          }
        })
        .catch((replayError) => {
          tracePrivatePhotos('upload_replay_error', {
            error: replayError?.message,
            code: replayError?.code || null,
            stack: replayError?.stack,
            actionId: jobId,
            ownerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
          }, { flush: true });
          logger.error('PhotoDiagnostics', 'Private photo replay threw', {
            error: replayError?.message,
            code: replayError?.code || null,
            actionId: jobId,
            tourId,
            ownerKey: summarizeRealtimeKey(privatePhotoOwnerKey),
            principalId: maskIdentifier(principalId),
          });
        });
      tracePrivatePhotos('upload_replay_requested');

      if (optimized.metrics?.originalSizeBytes && optimized.metrics?.optimizedSizeBytes) {
        Alert.alert(
          'Photo optimized',
          `Saved ${formatBytes(optimized.metrics.originalSizeBytes - optimized.metrics.optimizedSizeBytes)} before upload.`
        );
      }
    } catch (error) {
      tracePrivatePhotos('upload_prepare_error', {
        error: error?.message,
        stack: error?.stack,
      }, { flush: true });
      Alert.alert('Image preparation failed', 'Could not optimize this image. Please try a different photo.');
    } finally {
      setUploading(false);
    }
  };

  const retryUpload = async (pending) => {
    tracePrivatePhotos('retry_upload_pressed', {
      action: summarizeQueueAction(pending),
    }, { remote: true });
    const sourceStatus = await verifyQueuedUploadSource(pending);
    if (!sourceStatus.recoverable) {
      if (pending?.id) {
        await offlineSyncService.removeAction(pending.id);
      }
      Alert.alert('Upload removed', 'That photo is no longer available on this device, so it cannot be retried.');
      return;
    }

    await offlineSyncService.updateAction(pending.id, {
      status: 'retrying',
      nextAttemptAt: null,
      lastError: null,
    });
    tracePrivatePhotos('retry_upload_replay_requested', {
      actionId: pending?.id,
    });
    await offlineSyncService.replayQueue({ services: { photoService } });
  };

  const discardUpload = async (pending) => {
    if (!pending?.id) return;
    tracePrivatePhotos('discard_upload_pressed', {
      action: summarizeQueueAction(pending),
    }, { flush: true });
    await offlineSyncService.removeAction(pending.id);
    setPhotoQueueItems((items) => items.filter((item) => item.id !== pending.id));
  };

  const cancelUpload = () => {
    if (uploading) return;
    setShowUploadModal(false);
    setPendingImage(null);
    setCaption('');
  };


  return { cancelUpload, discardUpload, handlePickFromGallery, handleTakePhoto, handleUpload, retryUpload, showUploadOptions };
};
