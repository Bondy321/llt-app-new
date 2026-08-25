// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { MessageRow } from "./ChatTimeline";
export default function useChatTimelineRenderer(context, late) {
  const {
    activeSearchResultMessageId,
    canRetryFailedMessageForCurrentSession,
    chatImageSize,
    currentReactionUserIds,
    formatTime,
    handleHeartReactionDoubleTap,
    handleMessageLongPress,
    handleReaction,
    handleRetryFailedMessage,
    highlightedReplyTargetMessageId,
    internalDriverChat,
    jumpToMessageById,
    parseMessageText,
    realtimeActorId,
    renderHighlightedText,
    replyBubbleMinWidth,
    retryingMessageIds,
    rowOffsetsRef,
    setUnreadAnchorY,
    setViewingImage,
    startReplyComposer,
    unreadAnchorMessageId
  } = context;
  const keyExtractor = useCallback(item => {
    if (item.type === 'message') return item.data?.id ? `message-${item.data.id}` : item.id;
    return item.id;
  }, []);
  const handleMessageRowLayout = useCallback((messageId, layout) => {
    const {
      y,
      height
    } = layout;
    rowOffsetsRef.current[messageId] = height;
    if (messageId === unreadAnchorMessageId) {
      setUnreadAnchorY(y);
    }
  }, [rowOffsetsRef, setUnreadAnchorY, unreadAnchorMessageId]);
  const renderMessageRow = useCallback(({
    item
  }) => {
    return <MessageRow item={item} unreadAnchorMessageId={unreadAnchorMessageId} onRowLayout={handleMessageRowLayout} onSwipeReply={message => startReplyComposer(message, 'swipe')} activeSearchResultMessageId={activeSearchResultMessageId} highlightedReplyTargetMessageId={highlightedReplyTargetMessageId} currentUserId={realtimeActorId} currentUserIds={currentReactionUserIds} reactionsEnabled={!internalDriverChat} canRetry={item.type === 'message' ? canRetryFailedMessageForCurrentSession(item.data) : false} isRetrying={item.type === 'message' ? !!retryingMessageIds[item.data?.id] : false} onRetry={handleRetryFailedMessage} onLongPress={handleMessageLongPress} onReactionPress={handleReaction} onDoubleTapReaction={internalDriverChat ? null : handleHeartReactionDoubleTap} onOpenImage={setViewingImage} onJumpToMessage={jumpToMessageById} renderHighlightedText={renderHighlightedText} formatTime={formatTime} parseMessageText={parseMessageText} chatImageSize={chatImageSize} replyBubbleMinWidth={replyBubbleMinWidth} />;
  }, [unreadAnchorMessageId, handleMessageRowLayout, activeSearchResultMessageId, highlightedReplyTargetMessageId, realtimeActorId, currentReactionUserIds, internalDriverChat, canRetryFailedMessageForCurrentSession, retryingMessageIds, handleRetryFailedMessage, handleMessageLongPress, handleReaction, handleHeartReactionDoubleTap, setViewingImage, jumpToMessageById, renderHighlightedText, formatTime, parseMessageText, chatImageSize, replyBubbleMinWidth, startReplyComposer]);
  Object.assign(late.current, {
    keyExtractor,
    handleMessageRowLayout,
    renderMessageRow
  });
  return {
    keyExtractor,
    handleMessageRowLayout,
    renderMessageRow
  };
}
