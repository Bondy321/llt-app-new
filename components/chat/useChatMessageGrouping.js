// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect, useMemo } from 'react';
import { URL_REGEX, isMessageOwnedByCurrentSession } from "./chatShared";
export default function useChatMessageGrouping(context, late) {
  const {
    canonicalIdentity,
    currentScrollYRef,
    getMessageTimestamp,
    lastSeenTimestamp,
    messageListRef,
    searchQuery,
    sessionUnreadBoundaryTimestamp,
    setShowJumpToUnread,
    unreadAnchorY,
    updateUnreadJumpVisibility,
    visibleMessages
  } = context;
  // Parse message text for links
  const parseMessageText = useCallback(text => {
    if (!text) return [{
      type: 'text',
      content: ''
    }];
    const parts = [];
    let lastIndex = 0;
    let match;
    const regex = new RegExp(URL_REGEX);
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.substring(lastIndex, match.index)
        });
      }
      parts.push({
        type: 'link',
        content: match[0]
      });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.substring(lastIndex)
      });
    }
    return parts.length > 0 ? parts : [{
      type: 'text',
      content: text
    }];
  }, []);
  const unreadAnchorMessageId = useMemo(() => {
    if (!lastSeenTimestamp) return null;
    const unreadMessage = visibleMessages.find(message => {
      const timestamp = getMessageTimestamp(message);
      return timestamp && timestamp > lastSeenTimestamp && !isMessageOwnedByCurrentSession(message, canonicalIdentity);
    });
    return unreadMessage?.id || null;
  }, [visibleMessages, lastSeenTimestamp, getMessageTimestamp, canonicalIdentity]);
  const groupedMessages = useMemo(() => {
    return buildChatTimelineItems(visibleMessages, {
      lastSeenTimestamp: sessionUnreadBoundaryTimestamp,
      isMessageOwned: message => isMessageOwnedByCurrentSession(message, canonicalIdentity)
    });
  }, [visibleMessages, sessionUnreadBoundaryTimestamp, canonicalIdentity]);
  const unreadAnchorIndex = useMemo(() => {
    if (!unreadAnchorMessageId) return -1;
    return groupedMessages.findIndex(item => item.type === 'message' && item.data?.id === unreadAnchorMessageId);
  }, [groupedMessages, unreadAnchorMessageId]);
  const replyTargetIndex = useMemo(() => buildReplyTargetIndex(groupedMessages), [groupedMessages]);
  useEffect(() => {
    if (!unreadAnchorMessageId || unreadAnchorY == null) {
      setShowJumpToUnread(false);
      return;
    }
    updateUnreadJumpVisibility(currentScrollYRef.current, unreadAnchorY);
  }, [currentScrollYRef, setShowJumpToUnread, unreadAnchorMessageId, unreadAnchorY, updateUnreadJumpVisibility]);
  const jumpToUnread = useCallback(() => {
    if (unreadAnchorIndex >= 0) {
      messageListRef.current?.scrollToIndex({
        index: unreadAnchorIndex,
        animated: true,
        viewOffset: 80
      });
      return;
    }
    if (unreadAnchorY == null) return;
    messageListRef.current?.scrollToOffset({
      offset: Math.max(unreadAnchorY - 80, 0),
      animated: true
    });
  }, [messageListRef, unreadAnchorIndex, unreadAnchorY]);
  const unreadSummary = useMemo(() => buildUnreadSummary(visibleMessages.filter(message => !isMessageOwnedByCurrentSession(message, canonicalIdentity)), {
    lastSeenTimestamp,
    currentUserId: null
  }), [visibleMessages, lastSeenTimestamp, canonicalIdentity]);
  const searchResults = useMemo(() => buildChatSearchResults(visibleMessages, searchQuery), [visibleMessages, searchQuery]);
  const messageLookupById = useMemo(() => new Map(visibleMessages.map(entry => [entry?.id, entry])), [visibleMessages]);
  Object.assign(late.current, {
    parseMessageText,
    unreadAnchorMessageId,
    groupedMessages,
    unreadAnchorIndex,
    replyTargetIndex,
    jumpToUnread,
    unreadSummary,
    searchResults,
    messageLookupById
  });
  return {
    parseMessageText,
    unreadAnchorMessageId,
    groupedMessages,
    unreadAnchorIndex,
    replyTargetIndex,
    jumpToUnread,
    unreadSummary,
    searchResults,
    messageLookupById
  };
}
