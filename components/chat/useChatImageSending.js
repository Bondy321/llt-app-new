// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import * as Haptics from '../../services/hapticsService';
import offlineSyncService from '../../services/offlineSyncService';
import * as chatService from '../../services/chatService';
import * as photoService from '../../services/photoService';
import { optimizeSourcePhotoForUpload } from '../../services/imageOptimizationService';
import { maskIdentifier } from '../../services/loggerService';
import { summarizeUri } from '../../services/crashDiagnosticsService';
import { summarizeErrorForDiagnostics } from "./chatShared";
export default function useChatImageSending(context, late) {
  const {
    authUid,
    buildChatSenderInfo,
    canonicalIdentity,
    chatQueueScope,
    clearImageSendResetTimeout,
    imageSendAttemptRef,
    imageSendResetTimeoutRef,
    internalDriverChat,
    isConnected,
    isDriver,
    isImageUploading,
    logSenderIdentityPath,
    passengerStableId,
    principalId,
    refreshQueueStats,
    requiresPassengerStableIdForWrites,
    scrollToBottom,
    setImageSendState,
    setMessages,
    setShowAttachmentMenu,
    showTransientFeedback,
    tourId,
    traceChatImageSend,
    userName
  } = context;
  const handleSendImage = useCallback(async imageUri => {
    if (!imageUri || isImageUploading) return;
    if (internalDriverChat) {
      setShowAttachmentMenu(false);
      showTransientFeedback({
        type: 'info',
        icon: 'image-outline',
        message: 'Photos can be shared in the group chat.'
      });
      return;
    }
    const previousAttempt = imageSendAttemptRef.current;
    const imageMessageId = previousAttempt?.imageUri === imageUri ? previousAttempt.messageId : `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const photoJobId = `chat_photo_upload_${imageMessageId}`;
    const createdAt = new Date().toISOString();
    let imageSendStage = 'preparing';
    let queuedActionCreated = false;
    imageSendAttemptRef.current = {
      imageUri,
      messageId: imageMessageId
    };
    clearImageSendResetTimeout();
    setImageSendState({
      status: 'uploading',
      message: 'Preparing photo...',
      retryUri: imageUri
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    traceChatImageSend('send_requested', {
      imageUri: summarizeUri(imageUri),
      messageIdMasked: maskIdentifier(imageMessageId),
      online: isConnected
    });
    try {
      if (requiresPassengerStableIdForWrites && !passengerStableId) {
        throw new Error('CHAT_IDENTITY_NOT_READY');
      }
      const senderInfo = buildChatSenderInfo();
      logSenderIdentityPath();
      const optimized = await optimizeSourcePhotoForUpload({
        uri: imageUri
      });
      const optimisticMessage = {
        id: imageMessageId,
        idempotencyKey: imageMessageId,
        text: '',
        senderName: userName,
        senderId: senderInfo.principalId || senderInfo.userId,
        ...(senderInfo.stablePassengerId ? {
          senderStableId: senderInfo.stablePassengerId
        } : {}),
        timestamp: createdAt,
        isDriver,
        status: 'queued',
        type: 'image',
        imageUrl: optimized.uploadUri || imageUri,
        thumbnailUrl: imageUri
      };
      setMessages(current => mergeMessagesById(current, [optimisticMessage]));
      scrollToBottom(true);
      imageSendStage = 'queueing';
      const enqueueResult = await offlineSyncService.enqueueAction({
        id: photoJobId,
        type: 'PHOTO_UPLOAD',
        tourId,
        scope: chatQueueScope || {
          tourId,
          principalId,
          role: canonicalIdentity?.principalType === 'driver' ? 'driver' : 'passenger',
          authUid
        },
        createdAt,
        payload: {
          payloadVersion: 2,
          jobId: photoJobId,
          idempotencyKey: `chat_photo_${imageMessageId}`,
          createdAt,
          tourId,
          visibility: 'group',
          ownerId: principalId,
          userId: principalId,
          uploaderName: userName,
          localAssets: {
            sourceUri: optimized.uploadUri || imageUri,
            previewUri: imageUri,
            optimizationMetrics: optimized.metrics || null
          },
          metadata: {
            caption: ''
          },
          chatMessage: {
            tourId,
            messageId: imageMessageId,
            idempotencyKey: imageMessageId,
            caption: '',
            senderInfo,
            createdAt
          },
          attemptCount: 0,
          lastError: null
        }
      });
      if (!enqueueResult?.success) {
        throw new Error('CHAT_PHOTO_QUEUE_FAILED');
      }
      queuedActionCreated = true;
      await refreshQueueStats();
      if (!isConnected) {
        setImageSendState({
          status: 'queued',
          message: 'Photo saved on this device and will send when you are online.',
          retryUri: null
        });
        traceChatImageSend('queued_offline', {
          messageIdMasked: maskIdentifier(imageMessageId)
        });
        return;
      }
      imageSendStage = 'replaying';
      setImageSendState({
        status: 'uploading',
        message: 'Sending photo...',
        retryUri: imageUri
      });
      const replayResult = await offlineSyncService.replayQueue({
        services: {
          chatService,
          photoService
        },
        scope: chatQueueScope || undefined
      });
      const outcome = replayResult?.data?.outcomes?.find(entry => entry.actionId === photoJobId);
      await refreshQueueStats();
      if (replayResult?.success && outcome?.success) {
        setMessages(current => current.map(message => message.id === imageMessageId ? {
          ...message,
          status: 'delivered'
        } : message));
        setImageSendState({
          status: 'success',
          message: 'Photo sent',
          retryUri: null
        });
        imageSendAttemptRef.current = null;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        imageSendResetTimeoutRef.current = setTimeout(() => {
          setImageSendState(previous => previous.status === 'success' ? {
            status: 'idle',
            message: '',
            retryUri: null
          } : previous);
          imageSendResetTimeoutRef.current = null;
        }, 2400);
        traceChatImageSend('send_completed', {
          messageIdMasked: maskIdentifier(imageMessageId)
        });
        return;
      }
      setImageSendState({
        status: 'queued',
        message: 'Photo is safely queued and will retry automatically.',
        retryUri: null
      });
      traceChatImageSend('replay_deferred', {
        messageIdMasked: maskIdentifier(imageMessageId),
        replaySuccess: Boolean(replayResult?.success),
        outcomeSkipped: Boolean(outcome?.skipped)
      });
    } catch (error) {
      traceChatImageSend('send_failed', {
        stage: imageSendStage,
        queuedActionCreated,
        error: summarizeErrorForDiagnostics(error),
        imageUri: summarizeUri(imageUri)
      });
      if (!queuedActionCreated) {
        setMessages(current => current.filter(message => message.id !== imageMessageId));
      }
      setImageSendState(queuedActionCreated ? {
        status: 'queued',
        message: 'Photo is safely queued and will retry automatically.',
        retryUri: null
      } : {
        status: 'failed',
        message: error?.message === 'CHAT_IDENTITY_NOT_READY' ? 'Your chat identity is still syncing. Try again in a moment.' : 'Photo could not be prepared. Try again.',
        retryUri: imageUri
      });
      if (!queuedActionCreated) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [authUid, buildChatSenderInfo, canonicalIdentity?.principalType, chatQueueScope, clearImageSendResetTimeout, imageSendAttemptRef, imageSendResetTimeoutRef, internalDriverChat, isConnected, isDriver, isImageUploading, logSenderIdentityPath, passengerStableId, principalId, refreshQueueStats, requiresPassengerStableIdForWrites, scrollToBottom, setImageSendState, setMessages, setShowAttachmentMenu, showTransientFeedback, tourId, traceChatImageSend, userName]);

  // Image picker handler
  Object.assign(late.current, {
    handleSendImage
  });
  return {
    handleSendImage
  };
}
