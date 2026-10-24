import { collectMessageIdCandidates, resolveReplyTargetIndex, mergeMessagesById } from './chatShared';
// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect, useRef } from 'react';
import { getChatMessageById } from '../../services/chatService';
export default function useChatMessageNavigation(context, late) {
  const {
    authUid,
    principalId,
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
  const scopeKey = `${authUid}:${principalId}:${tourId}:${internalDriverChat}`;
  const currentScopeRef = useRef(scopeKey);
  currentScopeRef.current = scopeKey;
  useEffect(() => () => { currentScopeRef.current = null; }, []);
  const retryMessageMedia = useCallback(async (message) => {
    const captured = scopeKey;
    const isCurrent = () => currentScopeRef.current === captured;
    setMessages(current => current.map(item => item.id === message.id ? { ...item, mediaState: 'loading' } : item));
    const result = await getChatMessageById({ tourId, messageId: message.id,
      scope: internalDriverChat ? 'internal' : 'group', isCurrent });
    if (!isCurrent()) return;
    if (result.success && result.message) setMessages(current => mergeMessagesById(current, [result.message]));
    else setMessages(current => current.map(item => item.id === message.id ? { ...item, mediaState: 'retryable' } : item));
  }, [scopeKey, tourId, internalDriverChat, setMessages]);
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
  const notificationTargetKey = initialMessageId && tourId ? `${scopeKey}:${initialMessageId}` : null;
  useEffect(() => {
    notificationTargetRef.current = {
      key: notificationTargetKey,
      status: 'idle'
    };
  }, [notificationTargetKey, notificationTargetRef]);
  useEffect(() => {
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
      isCurrent: () => currentScopeRef.current === scopeKey && notificationTargetRef.current.key === notificationTargetKey,
      scope: internalDriverChat ? 'internal' : 'group'
    }).then(result => {
      if (currentScopeRef.current !== scopeKey || notificationTargetRef.current.key !== notificationTargetKey) return;
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
    return undefined;
  }, [initialMessageId, internalDriverChat, jumpToMessageById, loading, notificationTargetKey, notificationTargetRef, setMessages, setReplyJumpFeedbackMessage, tourId, scopeKey]);
  Object.assign(late.current, {
    jumpToMessageById,
    retryMessageMedia,
    notificationTargetKey
  });
  return {
    jumpToMessageById,
    notificationTargetKey
  };
}
