// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import * as Haptics from '../../services/hapticsService';
import { sendInternalDriverMessage, sendMessage, setTypingStatus } from '../../services/chatService';
import { checkTextForObjectionableContent } from '../../services/contentModerationService';
import logger, { maskIdentifier } from '../../services/loggerService';
export default function useChatTextSending(context, late) {
  const {
    authUid,
    buildChatSenderInfo,
    chatScope,
    inputText,
    internalDriverChat,
    isConnected,
    isDriver,
    logSenderIdentityPath,
    passengerStableId,
    principalId,
    realtimeActorId,
    refreshQueueStats,
    replyingToMessage,
    requiresPassengerStableIdForWrites,
    scrollToBottom,
    sending,
    setInputText,
    setMessages,
    setReplyingToMessage,
    setSending,
    showTransientFeedback,
    tourId,
    typingTimeoutRef,
    userName
  } = context;
  // Send message handler
  const handleSendMessage = useCallback(async () => {
    if (sending) return;
    const trimmed = inputText.trim();
    if (!trimmed) return;
    const moderationResult = checkTextForObjectionableContent(trimmed);
    if (!moderationResult.allowed) {
      showTransientFeedback({
        type: 'warning',
        icon: 'shield-alert-outline',
        message: moderationResult.message
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const pendingReply = replyingToMessage;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSending(true);
    setInputText('');
    setReplyingToMessage(null);

    // Clear typing status
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    setTypingStatus(tourId, realtimeActorId, userName, false, isDriver, undefined, {
      scope: chatScope
    });
    if (requiresPassengerStableIdForWrites && !passengerStableId) {
      setInputText(trimmed);
      setReplyingToMessage(pendingReply);
      setSending(false);
      showTransientFeedback({
        type: 'warning',
        icon: 'account-alert-outline',
        message: 'Your chat identity is still syncing. Try again in a moment.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      logger.warn('ChatScreen', 'chat_send_blocked_missing_sender_stable_id', {
        tourId,
        principalId: maskIdentifier(principalId),
        hasAuthUid: Boolean(authUid)
      });
      return;
    }
    const senderInfo = buildChatSenderInfo();
    logSenderIdentityPath();
    const optimisticTimestamp = new Date().toISOString();
    const optimisticId = `${internalDriverChat ? 'int' : 'msg'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      id: optimisticId,
      idempotencyKey: optimisticId,
      text: trimmed,
      senderName: userName,
      senderId: senderInfo.userId,
      ...(passengerStableId ? {
        senderStableId: passengerStableId
      } : {}),
      timestamp: optimisticTimestamp,
      isDriver,
      status: 'sending',
      type: 'text',
      ...(pendingReply ? {
        replyTo: pendingReply
      } : {})
    };
    setMessages(prev => [...prev, optimisticMessage]);
    scrollToBottom(true);
    logger.info('ChatScreen', 'chat_send_requested', {
      tourId,
      chatScope: internalDriverChat ? 'internal' : 'group',
      messageId: maskIdentifier(optimisticId),
      textLength: trimmed.length,
      hasReply: Boolean(pendingReply),
      senderPrincipalType: senderInfo.principalType,
      senderId: maskIdentifier(senderInfo.principalId || senderInfo.userId),
      senderStableId: maskIdentifier(senderInfo.stablePassengerId || senderInfo.senderStableId)
    });
    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo, undefined, {
        messageId: optimisticId,
        idempotencyKey: optimisticId,
        replyTo: pendingReply || undefined,
        online: isConnected
      });
      if (!result?.success || !result?.message) {
        logger.warn('ChatScreen', 'chat_send_result_failed', {
          tourId,
          chatScope: internalDriverChat ? 'internal' : 'group',
          messageId: maskIdentifier(optimisticId),
          error: result?.error || null,
          queued: Boolean(result?.queued)
        });
        setMessages(prev => prev.filter(msg => msg.id !== optimisticId));
        setInputText(trimmed);
        setReplyingToMessage(pendingReply);
        showTransientFeedback({
          type: 'warning',
          icon: 'message-alert-outline',
          message: 'Message could not be sent. Please try again.'
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        const confirmedMessage = {
          ...result.message,
          status: result.queued ? 'queued' : 'sent'
        };
        logger.info('ChatScreen', 'chat_send_result_success', {
          tourId,
          chatScope: internalDriverChat ? 'internal' : 'group',
          optimisticId: maskIdentifier(optimisticId),
          messageId: maskIdentifier(confirmedMessage.id),
          queued: Boolean(result.queued),
          status: confirmedMessage.status
        });
        setMessages(prev => mergeMessagesById(prev, [confirmedMessage]));
        if (!result.queued && result.serverPromise?.finally) {
          result.serverPromise.then(() => {
            logger.info('ChatScreen', 'chat_send_server_delivery_confirmed', {
              tourId,
              chatScope: internalDriverChat ? 'internal' : 'group',
              messageId: maskIdentifier(confirmedMessage.id)
            });
            setMessages(prev => prev.map(msg => msg.id === confirmedMessage.id ? {
              ...msg,
              status: 'delivered'
            } : msg));
          }).catch(deliveryError => {
            logger.warn('ChatScreen', 'chat_send_server_delivery_failed', {
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
      }
    } catch (error) {
      logger.error('ChatScreen', 'chat_send_threw', {
        tourId,
        chatScope: internalDriverChat ? 'internal' : 'group',
        messageId: maskIdentifier(optimisticId),
        error: error?.message,
        code: error?.code || null
      });
      setMessages(prev => prev.filter(msg => msg.id !== optimisticId));
      setInputText(trimmed);
      setReplyingToMessage(pendingReply);
      showTransientFeedback({
        type: 'warning',
        icon: 'message-alert-outline',
        message: 'Message could not be sent. Please try again.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      await refreshQueueStats();
    }
    setSending(false);
  }, [sending, inputText, replyingToMessage, setSending, setInputText, setReplyingToMessage, typingTimeoutRef, tourId, realtimeActorId, userName, isDriver, chatScope, requiresPassengerStableIdForWrites, passengerStableId, buildChatSenderInfo, logSenderIdentityPath, internalDriverChat, setMessages, scrollToBottom, showTransientFeedback, principalId, authUid, isConnected, refreshQueueStats]);
  Object.assign(late.current, {
    handleSendMessage
  });
  return {
    handleSendMessage
  };
}
