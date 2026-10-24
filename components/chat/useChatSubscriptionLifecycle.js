// screens/ChatScreen.js - Premium Chat Experience
import { useEffect, useRef } from 'react';
import { subscribeToChatMessages, subscribeToInternalDriverChat } from '../../services/chatService';
import logger from '../../services/loggerService';
import { mergeMessagesById, LIVE_CHAT_MESSAGE_LIMIT, normalizeTimestamp, summarizeMessagesForReactionDebug, logChatReactionDebug } from "./chatShared";
export default function useChatSubscriptionLifecycle(context, late) {
  const {
    authUid,
    principalId,
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
  const scopeKey = `${authUid || ''}:${principalId || ''}:${tourId || ''}:${internalDriverChat ? 'internal' : 'group'}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
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
    let previousLive = new Map();
    let active = true;
    const unsubscribe = subscribeFn(tourId, newMessages => {
      if (!active || activeScope.current !== scopeKey) return;
      setChatLoadError('');
      const reactionSummary = summarizeMessagesForReactionDebug(newMessages, currentReactionUserIds);
      logChatReactionDebug('chat_reaction_subscription_received', {
        tourId,
        chatType: internalDriverChat ? 'internal' : 'group',
        ...reactionSummary
      });
      const liveIds = new Set(newMessages.map(message => message.id));
      const oldestLive = [...newMessages].sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))[0];
      const oldestLiveMs = oldestLive ? getMessageTimestamp(oldestLive) : Infinity;
      const retiredIds = new Set([...previousLive].filter(([id, message]) => !liveIds.has(id)
        && (newMessages.length < LIVE_CHAT_MESSAGE_LIMIT || getMessageTimestamp(message) > oldestLiveMs
          || (getMessageTimestamp(message) === oldestLiveMs && String(id) >= String(oldestLive?.id)))).map(([id]) => id));
      previousLive = new Map(newMessages.map(message => [message.id, message]));
      setMessages(prevMessages => mergeMessagesById(prevMessages.filter(message => !retiredIds.has(message.id)), newMessages));
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
        if (!active || activeScope.current !== scopeKey) return;
        logger.warn('ChatScreen', 'Chat live subscription failed', {
          tourId,
          chatType: internalDriverChat ? 'internal' : 'group',
          error: error?.message || String(error)
        });
        setLoading(false);
        setChatLoadError('Messages are temporarily unavailable. Check your connection and retry.');
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [scopeKey, tourId, internalDriverChat, scrollToBottom, getMessageTimestamp, currentReactionUserIds, subscriptionRevision, lastLiveMessageCursorRef, setMessages, setHasMoreHistory, setNewMessagesCount, setLoading, setChatLoadError, isAtBottomRef]);

  // Restore persisted chat draft for this tour/user context
  Object.assign(late.current, {});
  return {};
}
