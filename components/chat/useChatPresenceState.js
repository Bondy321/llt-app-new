// screens/ChatScreen.js - Premium Chat Experience
import { useState } from 'react';
export default function useChatPresenceState(context, late) {
  const {} = context;
  const [presenceInfo, setPresenceInfo] = useState({
    onlineCount: 0,
    totalCount: 0,
    users: []
  });
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [imageSendState, setImageSendState] = useState({
    status: 'idle',
    message: '',
    retryUri: null
  });
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState(null);
  const [sessionUnreadBoundaryTimestamp, setSessionUnreadBoundaryTimestamp] = useState(null);
  const [readStateRestored, setReadStateRestored] = useState(false);
  const [unreadAnchorY, setUnreadAnchorY] = useState(null);
  const [showJumpToUnread, setShowJumpToUnread] = useState(false);
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState('all');
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [showSwipeReplyHint, setShowSwipeReplyHint] = useState(false);
  const [retryingMessageIds, setRetryingMessageIds] = useState({});

  // Modal state
  // Modal state
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  Object.assign(late.current, {
    presenceInfo,
    setPresenceInfo,
    newMessagesCount,
    setNewMessagesCount,
    isAtBottom,
    setIsAtBottom,
    showAttachmentMenu,
    setShowAttachmentMenu,
    imageSendState,
    setImageSendState,
    lastSeenTimestamp,
    setLastSeenTimestamp,
    sessionUnreadBoundaryTimestamp,
    setSessionUnreadBoundaryTimestamp,
    readStateRestored,
    setReadStateRestored,
    unreadAnchorY,
    setUnreadAnchorY,
    showJumpToUnread,
    setShowJumpToUnread,
    replyingToMessage,
    setReplyingToMessage,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    searchFilter,
    setSearchFilter,
    activeSearchResultIndex,
    setActiveSearchResultIndex,
    showSwipeReplyHint,
    setShowSwipeReplyHint,
    retryingMessageIds,
    setRetryingMessageIds,
    selectedMessage,
    setSelectedMessage,
    showActionMenu,
    setShowActionMenu,
    showReactionPicker,
    setShowReactionPicker
  });
  return {
    presenceInfo,
    setPresenceInfo,
    newMessagesCount,
    setNewMessagesCount,
    isAtBottom,
    setIsAtBottom,
    showAttachmentMenu,
    setShowAttachmentMenu,
    imageSendState,
    setImageSendState,
    lastSeenTimestamp,
    setLastSeenTimestamp,
    sessionUnreadBoundaryTimestamp,
    setSessionUnreadBoundaryTimestamp,
    readStateRestored,
    setReadStateRestored,
    unreadAnchorY,
    setUnreadAnchorY,
    showJumpToUnread,
    setShowJumpToUnread,
    replyingToMessage,
    setReplyingToMessage,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    searchFilter,
    setSearchFilter,
    activeSearchResultIndex,
    setActiveSearchResultIndex,
    showSwipeReplyHint,
    setShowSwipeReplyHint,
    retryingMessageIds,
    setRetryingMessageIds,
    selectedMessage,
    setSelectedMessage,
    showActionMenu,
    setShowActionMenu,
    showReactionPicker,
    setShowReactionPicker
  };
}
