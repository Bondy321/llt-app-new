// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from '../../services/hapticsService';
import { summarizeImageAssetForDiagnostics } from "./chatShared";
export default function useChatImagePicker(context, late) {
  const {
    handleSendImage,
    imageSendState,
    isImageUploading,
    setShowAttachmentMenu,
    showTransientFeedback,
    traceChatImageSend
  } = context;
  // Image picker handler
  const handlePickImage = useCallback(async () => {
    setShowAttachmentMenu(false);
    traceChatImageSend('gallery_permission_requested');
    const {
      status
    } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    traceChatImageSend('gallery_permission_result', {
      status
    });
    if (status !== 'granted') {
      showTransientFeedback({
        type: 'warning',
        icon: 'image-off-outline',
        message: 'Gallery permission is needed to choose a photo.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8
    });
    traceChatImageSend('gallery_picker_result', {
      canceled: Boolean(result.canceled),
      asset: summarizeImageAssetForDiagnostics(result.assets?.[0])
    });
    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, [handleSendImage, setShowAttachmentMenu, showTransientFeedback, traceChatImageSend]);

  // Camera handler
  // Camera handler
  const handleTakePhoto = useCallback(async () => {
    setShowAttachmentMenu(false);
    traceChatImageSend('camera_permission_requested');
    const {
      status
    } = await ImagePicker.requestCameraPermissionsAsync();
    traceChatImageSend('camera_permission_result', {
      status
    });
    if (status !== 'granted') {
      showTransientFeedback({
        type: 'warning',
        icon: 'camera-off-outline',
        message: 'Camera permission is needed to take a photo.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8
    });
    traceChatImageSend('camera_picker_result', {
      canceled: Boolean(result.canceled),
      asset: summarizeImageAssetForDiagnostics(result.assets?.[0])
    });
    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, [handleSendImage, setShowAttachmentMenu, showTransientFeedback, traceChatImageSend]);
  const handleRetryImageSend = useCallback(() => {
    const retryUri = imageSendState.retryUri;
    if (!retryUri || isImageUploading) return;
    handleSendImage(retryUri);
  }, [handleSendImage, imageSendState.retryUri, isImageUploading]);

  // Handle reaction
  Object.assign(late.current, {
    handlePickImage,
    handleTakePhoto,
    handleRetryImageSend
  });
  return {
    handlePickImage,
    handleTakePhoto,
    handleRetryImageSend
  };
}
