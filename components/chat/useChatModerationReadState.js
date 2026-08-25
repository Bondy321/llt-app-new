// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect, useMemo } from 'react';
import { markChatAsRead, markInternalChatAsRead } from '../../services/chatService';
import logger, { maskIdentifier } from '../../services/loggerService';
import { SCROLL_BOTTOM_THRESHOLD, normalizeTimestamp, isMessageOwnedByCurrentSession, getMessageModerationSenderKey } from "./chatShared";
export default function useChatModerationReadState(context, late) {
  const {
    canonicalIdentity,
    composerHeight,
    currentScrollYRef,
    hiddenMessageIds,
    identityBinding,
    identityBindingSource,
    internalDriverChat,
    isAtBottom,
    isAtBottomRef,
    lastReadMarkAtRef,
    lastSeenTimestamp,
    listBottomSpacerHeight,
    listContentHeightRef,
    listViewportHeightRef,
    messageListRef,
    messages,
    mutedSenderIds,
    passengerStableId,
    principalId,
    readStateRestored,
    readStateStorage,
    readStateStorageKey,
    realtimeActorId,
    setIsAtBottom,
    setLastSeenTimestamp,
    setNewMessagesCount,
    setUnreadAnchorY,
    tourId,
    unreadAnchorY,
    updateUnreadJumpVisibility
  } = context;
  useEffect(() => {
    logger.info('ChatScreen', 'identity_binding_source_selected', {
      source: identityBindingSource,
      hasStableBinding: Boolean(identityBinding?.stablePassengerId),
      tourId,
      principalId: maskIdentifier(principalId),
      passengerStableId: maskIdentifier(passengerStableId)
    });
  }, [identityBinding?.stablePassengerId, identityBindingSource, passengerStableId, principalId, tourId]);
  const canRetryFailedMessageForCurrentSession = useCallback(message => {
    if (!isMessageOwnedByCurrentSession(message, canonicalIdentity)) return false;
    if (!message || typeof message !== 'object') return false;
    if (message.deleted) return false;
    if (message.status !== 'failed') return false;
    if ((message.type || 'text') !== 'text') return false;
    if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
    return true;
  }, [canonicalIdentity]);
  const getMessageTimestamp = useCallback(message => {
    if (!message) return null;
    return normalizeTimestamp(message.timestamp);
  }, []);
  const visibleMessages = useMemo(() => messages.filter(message => {
    if (!message?.id) return true;
    if (hiddenMessageIds[message.id]) return false;
    if (isMessageOwnedByCurrentSession(message, canonicalIdentity)) return true;
    const senderKey = getMessageModerationSenderKey(message);
    return !senderKey || mutedSenderIds[senderKey] !== true;
  }), [canonicalIdentity, hiddenMessageIds, messages, mutedSenderIds]);
  const markActiveChatRead = useCallback(async ({
    force = false
  } = {}) => {
    if (!tourId || !realtimeActorId || !readStateRestored) return;
    if (!force && !isAtBottomRef.current) return;
    const latestMessage = messages[messages.length - 1];
    const latestTimestamp = getMessageTimestamp(latestMessage);
    if (!Number.isFinite(latestTimestamp)) return;
    if (Number.isFinite(lastSeenTimestamp) && latestTimestamp <= lastSeenTimestamp) return;
    const now = Date.now();
    if (!force && now - lastReadMarkAtRef.current < 3000) return;
    lastReadMarkAtRef.current = now;
    const markReadFn = internalDriverChat ? markInternalChatAsRead : markChatAsRead;
    const result = await markReadFn(tourId, realtimeActorId);
    if (result?.success && readStateStorageKey) {
      setLastSeenTimestamp(latestTimestamp);
      setUnreadAnchorY(null);
      await readStateStorage.setItemAsync(readStateStorageKey, String(latestTimestamp));
    }
  }, [tourId, realtimeActorId, readStateRestored, isAtBottomRef, messages, getMessageTimestamp, lastSeenTimestamp, lastReadMarkAtRef, internalDriverChat, readStateStorageKey, setLastSeenTimestamp, setUnreadAnchorY, readStateStorage]);

  // Scroll to bottom helper
  // Scroll to bottom helper
  const scrollToBottom = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      const viewportHeight = listViewportHeightRef.current || 0;
      const contentHeight = listContentHeightRef.current || 0;
      const targetOffset = Math.max(contentHeight - viewportHeight, 0);
      messageListRef.current?.scrollToOffset({
        offset: targetOffset,
        animated
      });
    });
  }, [listContentHeightRef, listViewportHeightRef, messageListRef]);
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom(false);
    }
  }, [composerHeight, isAtBottom, listBottomSpacerHeight, scrollToBottom]);

  // Handle scroll position tracking
  // Handle scroll position tracking
  const handleScroll = useCallback(event => {
    const {
      layoutMeasurement,
      contentOffset,
      contentSize
    } = event.nativeEvent;
    listViewportHeightRef.current = layoutMeasurement.height;
    listContentHeightRef.current = contentSize.height;
    currentScrollYRef.current = contentOffset.y;
    const isBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - SCROLL_BOTTOM_THRESHOLD;
    isAtBottomRef.current = isBottom;
    setIsAtBottom(prev => prev === isBottom ? prev : isBottom);
    updateUnreadJumpVisibility(contentOffset.y, unreadAnchorY);
    if (isBottom) {
      setNewMessagesCount(0);
      markActiveChatRead({
        force: true
      });
    }
  }, [currentScrollYRef, isAtBottomRef, listContentHeightRef, listViewportHeightRef, markActiveChatRead, setIsAtBottom, setNewMessagesCount, unreadAnchorY, updateUnreadJumpVisibility]);
  Object.assign(late.current, {
    canRetryFailedMessageForCurrentSession,
    getMessageTimestamp,
    visibleMessages,
    markActiveChatRead,
    scrollToBottom,
    handleScroll
  });
  return {
    canRetryFailedMessageForCurrentSession,
    getMessageTimestamp,
    visibleMessages,
    markActiveChatRead,
    scrollToBottom,
    handleScroll
  };
}
