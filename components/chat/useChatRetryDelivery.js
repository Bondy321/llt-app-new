// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import * as Haptics from '../../services/hapticsService';
import { sendInternalDriverMessage, sendMessage } from '../../services/chatService';
import logger, { maskIdentifier } from '../../services/loggerService';
export default function useChatRetryDelivery(context, late) {
  const {
    buildChatSenderInfo,
    canRetryFailedMessageForCurrentSession,
    internalDriverChat,
    isConnected,
    logSenderIdentityPath,
    passengerStableId,
    principalId,
    refreshQueueStats,
    requiresPassengerStableIdForWrites,
    retryingMessageIds,
    setMessages,
    setRetryingMessageIds,
    showTransientFeedback,
    tourId
  } = context;
  const handleRetryFailedMessage = useCallback(async message => {
    if (!canRetryFailedMessageForCurrentSession(message)) return;
    if (!tourId || !principalId) return;
    if (retryingMessageIds[message.id]) return;
    const trimmed = message.text.trim();
    if (!trimmed) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRetryingMessageIds(prev => ({
      ...prev,
      [message.id]: true
    }));
    setMessages(prev => prev.map(msg => msg.id === message.id ? {
      ...msg,
      status: 'sending',
      retryAttemptedAt: new Date().toISOString()
    } : msg));
    if (requiresPassengerStableIdForWrites && !passengerStableId) {
      setMessages(prev => prev.map(msg => msg.id === message.id ? {
        ...msg,
        status: 'failed'
      } : msg));
      setRetryingMessageIds(prev => {
        const next = {
          ...prev
        };
        delete next[message.id];
        return next;
      });
      showTransientFeedback({
        type: 'warning',
        icon: 'account-alert-outline',
        message: 'Your chat identity is still syncing. Try again in a moment.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      logger.warn('ChatScreen', 'chat_retry_blocked_missing_sender_stable_id', {
        tourId,
        principalId: maskIdentifier(principalId),
        messageId: maskIdentifier(message.id)
      });
      return;
    }
    const senderInfo = buildChatSenderInfo();
    logSenderIdentityPath();
    logger.info('ChatScreen', 'chat_retry_requested', {
      tourId,
      chatScope: internalDriverChat ? 'internal' : 'group',
      failedMessageId: maskIdentifier(message.id),
      textLength: trimmed.length,
      hasReply: Boolean(message.replyTo),
      senderPrincipalType: senderInfo.principalType,
      senderId: maskIdentifier(senderInfo.principalId || senderInfo.userId),
      senderStableId: maskIdentifier(senderInfo.stablePassengerId || senderInfo.senderStableId)
    });
    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo, undefined, {
        messageId: message.id,
        idempotencyKey: message.idempotencyKey || message.id,
        replyTo: message.replyTo || undefined,
        online: isConnected
      });
      if (!result?.success || !result?.message) {
        logger.warn('ChatScreen', 'chat_retry_result_failed', {
          tourId,
          chatScope: internalDriverChat ? 'internal' : 'group',
          failedMessageId: maskIdentifier(message.id),
          error: result?.error || null,
          queued: Boolean(result?.queued)
        });
        setMessages(prev => prev.map(msg => msg.id === message.id ? {
          ...msg,
          status: 'failed'
        } : msg));
        showTransientFeedback({
          type: 'warning',
          icon: 'message-alert-outline',
          message: 'Message could not be retried. Please try again.'
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      const confirmedMessage = {
        ...result.message,
        status: result.queued ? 'queued' : 'sent'
      };
      logger.info('ChatScreen', 'chat_retry_result_success', {
        tourId,
        chatScope: internalDriverChat ? 'internal' : 'group',
        previousMessageId: maskIdentifier(message.id),
        messageId: maskIdentifier(confirmedMessage.id),
        queued: Boolean(result.queued),
        status: confirmedMessage.status
      });
      setMessages(prev => mergeMessagesById(prev.filter(msg => msg.id !== message.id), [confirmedMessage]));
      if (!result.queued && result.serverPromise?.finally) {
        result.serverPromise.then(() => {
          logger.info('ChatScreen', 'chat_retry_server_delivery_confirmed', {
            tourId,
            chatScope: internalDriverChat ? 'internal' : 'group',
            messageId: maskIdentifier(confirmedMessage.id)
          });
          setMessages(prev => prev.map(msg => msg.id === confirmedMessage.id ? {
            ...msg,
            status: 'delivered'
          } : msg));
        }).catch(deliveryError => {
          logger.warn('ChatScreen', 'chat_retry_server_delivery_failed', {
            tourId,
            chatScope: internalDriverChat ? 'internal' : 'group',
            messageId: maskIdentifier(confirmedMessage.id),
            error: deliveryError?.message,
            code: deliveryError?.code || null
          });
          setMessages(prev => prev.map(msg => msg.id === confirmedMessage.id ? {
            ...msg,
            status: 'failed'
          } : msg));
        });
      }
      if (result.queued) {
        await refreshQueueStats();
      }
    } catch (error) {
      logger.error('ChatScreen', 'chat_retry_threw', {
        tourId,
        chatScope: internalDriverChat ? 'internal' : 'group',
        failedMessageId: maskIdentifier(message.id),
        error: error?.message,
        code: error?.code || null
      });
      setMessages(prev => prev.map(msg => msg.id === message.id ? {
        ...msg,
        status: 'failed'
      } : msg));
      showTransientFeedback({
        type: 'warning',
        icon: 'message-alert-outline',
        message: 'Message could not be retried. Please try again.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setRetryingMessageIds(prev => {
        const next = {
          ...prev
        };
        delete next[message.id];
        return next;
      });
      await refreshQueueStats();
    }
  }, [canRetryFailedMessageForCurrentSession, tourId, principalId, retryingMessageIds, setRetryingMessageIds, setMessages, requiresPassengerStableIdForWrites, passengerStableId, buildChatSenderInfo, logSenderIdentityPath, internalDriverChat, showTransientFeedback, isConnected, refreshQueueStats]);
  Object.assign(late.current, {
    handleRetryFailedMessage
  });
  return {
    handleRetryFailedMessage
  };
}
