// screens/ChatScreen.js - Premium Chat Experience
import { useEffect } from 'react';
import { subscribeToChatMessages, subscribeToInternalDriverChat } from '../../services/chatService';
import logger from '../../services/loggerService';
import { LIVE_CHAT_MESSAGE_LIMIT, normalizeTimestamp, summarizeMessagesForReactionDebug, logChatReactionDebug } from "./chatShared";
export default function useChatSubscriptionLifecycle(context, late) {
  const {
    currentReactionUserIds,
    getMessageTimestamp,
    internalDriverChat,
    isAtBottomRef,
    lastLiveMessageCursorRef,
    scrollToBottom,
    setChatLoadError,
    setHasMoreHistory,
    setLoading,
    setMessages,
    setNewMessagesCount,
    subscriptionRevision,
    tourId
  } = context;
  // Subscribe to messages
  useEffect(() => {
    if (!tourId) {
      lastLiveMessageCursorRef.current = null;
      setMessages([]);
      setHasMoreHistory(false);
      setNewMessagesCount(0);
      setLoading(false);
      return;
    }
    lastLiveMessageCursorRef.current = null;
    setMessages([]);
    setHasMoreHistory(false);
    setNewMessagesCount(0);
    setLoading(true);
    setChatLoadError('');
    const subscribeFn = internalDriverChat ? subscribeToInternalDriverChat : subscribeToChatMessages;
    const unsubscribe = subscribeFn(tourId, newMessages => {
      setChatLoadError('');
      const reactionSummary = summarizeMessagesForReactionDebug(newMessages, currentReactionUserIds);
      logChatReactionDebug('chat_reaction_subscription_received', {
        tourId,
        chatType: internalDriverChat ? 'internal' : 'group',
        ...reactionSummary
      });
      setMessages(prevMessages => mergeMessagesById(prevMessages, newMessages));
      setHasMoreHistory(newMessages.length >= LIVE_CHAT_MESSAGE_LIMIT);
      setLoading(false);
      const latestMessage = newMessages[newMessages.length - 1] || null;
      const latestCursor = latestMessage ? `${latestMessage.id || 'unknown'}:${latestMessage.timestamp ?? latestMessage.timestampMs ?? ''}` : null;
      const previousCursor = lastLiveMessageCursorRef.current;
      if (!isAtBottomRef.current && previousCursor && latestCursor && latestCursor !== previousCursor) {
        const previousTimestamp = previousCursor.split(':').slice(1).join(':');
        const previousMs = normalizeTimestamp(previousTimestamp);
        const incomingCount = Number.isFinite(previousMs) ? newMessages.filter(message => {
          const messageTs = getMessageTimestamp(message);
          return Number.isFinite(messageTs) && messageTs > previousMs;
        }).length : 1;
        setNewMessagesCount(prev => prev + Math.max(incomingCount, 1));
      }
      lastLiveMessageCursorRef.current = latestCursor;

      // Auto-scroll if at bottom
      if (isAtBottomRef.current) {
        scrollToBottom(true);
      }
    }, undefined, {
      limit: LIVE_CHAT_MESSAGE_LIMIT,
      onError: error => {
        logger.warn('ChatScreen', 'Chat live subscription failed', {
          tourId,
          chatType: internalDriverChat ? 'internal' : 'group',
          error: error?.message || String(error)
        });
        setLoading(false);
        setChatLoadError('Messages are temporarily unavailable. Check your connection and retry.');
      }
    });
    return () => unsubscribe();
  }, [tourId, internalDriverChat, scrollToBottom, getMessageTimestamp, currentReactionUserIds, subscriptionRevision, lastLiveMessageCursorRef, setMessages, setHasMoreHistory, setNewMessagesCount, setLoading, setChatLoadError, isAtBottomRef]);

  // Restore persisted chat draft for this tour/user context
  Object.assign(late.current, {});
  return {};
}
