// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import { getChatMessageById } from '../../services/chatService';
export default function useChatMessageNavigation(context, late) {
  const {
    groupedMessages,
    initialMessageId,
    internalDriverChat,
    loading,
    messageListRef,
    notificationTargetRef,
    pendingJumpIndexRef,
    replyTargetIndex,
    setHighlightedReplyTargetMessageId,
    setMessages,
    setReplyJumpFeedbackMessage,
    tourId
  } = context;
  const jumpToMessageById = useCallback((messageId, fallbackId = null, {
    showMissingFeedback = true
  } = {}) => {
    const targetCandidates = [...collectMessageIdCandidates(messageId), ...collectMessageIdCandidates(fallbackId)];
    const uniqueCandidates = Array.from(new Set(targetCandidates));
    let targetIndex = -1;
    uniqueCandidates.some(candidate => {
      const resolved = resolveReplyTargetIndex(candidate, replyTargetIndex);
      if (resolved < 0) return false;
      targetIndex = resolved;
      return true;
    });
    if (targetIndex < 0 && uniqueCandidates.length > 0) {
      targetIndex = groupedMessages.findIndex(item => {
        if (item?.type !== 'message') return false;
        const messageData = item.data || {};
        const candidatePool = [...collectMessageIdCandidates(messageData.id), ...collectMessageIdCandidates(messageData.idempotencyKey)];
        return uniqueCandidates.some(candidate => candidatePool.includes(candidate));
      });
    }
    if (targetIndex < 0) {
      if (showMissingFeedback) {
        setReplyJumpFeedbackMessage('Could not find the original message in this chat history.');
      }
      return false;
    }
    pendingJumpIndexRef.current = targetIndex;
    setReplyJumpFeedbackMessage('');
    const targetMessageId = groupedMessages[targetIndex]?.data?.id;
    if (targetMessageId) {
      setHighlightedReplyTargetMessageId(targetMessageId);
    }
    messageListRef.current?.scrollToIndex({
      index: targetIndex,
      animated: true,
      viewPosition: 0.45
    });
    return true;
  }, [groupedMessages, messageListRef, pendingJumpIndexRef, replyTargetIndex, setHighlightedReplyTargetMessageId, setReplyJumpFeedbackMessage]);
  const notificationTargetKey = initialMessageId && tourId ? `${internalDriverChat ? 'internal' : 'group'}:${tourId}:${initialMessageId}` : null;
  useEffect(() => {
    notificationTargetRef.current = {
      key: notificationTargetKey,
      status: 'idle'
    };
  }, [notificationTargetKey, notificationTargetRef]);
  useEffect(() => {
    let active = true;
    if (!notificationTargetKey || loading) return undefined;
    const targetState = notificationTargetRef.current;
    if (targetState.key !== notificationTargetKey || targetState.status === 'complete' || targetState.status === 'fetching' || targetState.status === 'missing') {
      return undefined;
    }
    if (jumpToMessageById(initialMessageId, null, {
      showMissingFeedback: false
    })) {
      notificationTargetRef.current = {
        key: notificationTargetKey,
        status: 'complete'
      };
      return undefined;
    }
    if (targetState.status === 'loaded') {
      notificationTargetRef.current = {
        key: notificationTargetKey,
        status: 'missing'
      };
      setReplyJumpFeedbackMessage('This notification message is no longer available in the chat.');
      return undefined;
    }
    notificationTargetRef.current = {
      key: notificationTargetKey,
      status: 'fetching'
    };
    getChatMessageById({
      tourId,
      messageId: initialMessageId,
      scope: internalDriverChat ? 'internal' : 'group'
    }).then(result => {
      if (!active || notificationTargetRef.current.key !== notificationTargetKey) return;
      if (!result?.success || !result.message) {
        notificationTargetRef.current = {
          key: notificationTargetKey,
          status: 'missing'
        };
        setReplyJumpFeedbackMessage('This notification message is no longer available in the chat.');
        return;
      }
      notificationTargetRef.current = {
        key: notificationTargetKey,
        status: 'loaded'
      };
      setMessages(current => mergeMessagesById(current, [result.message]));
    });
    return () => {
      active = false;
    };
  }, [initialMessageId, internalDriverChat, jumpToMessageById, loading, notificationTargetKey, notificationTargetRef, setMessages, setReplyJumpFeedbackMessage, tourId]);
  Object.assign(late.current, {
    jumpToMessageById,
    notificationTargetKey
  });
  return {
    jumpToMessageById,
    notificationTargetKey
  };
}
