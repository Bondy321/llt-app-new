// screens/ChatScreen.js - Premium Chat Experience
import React, { useCallback, useRef } from 'react';
import { ActivityIndicator, Platform, Pressable, FlatList, RefreshControl, Text, TextInput, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { DOUBLE_TAP_REACTION_DELAY_MS, HEART_REACTION, COLORS, openChatExternalLink, DateSeparator, UnreadSeparator } from "./chatShared";
import { ImageMessage, LinkPreview, MessageStatus, MessageReactions, SwipeToReplyMessageWrapper } from "./ChatMessageActions";
import { ChatLoadingSkeleton, LoadOlderControl } from "./ChatChrome";
import styles from "./chatStyles";
export const MessageBubble = React.memo(({
  message,
  presentation,
  activeSearchResultMessageId,
  highlightedReplyTargetMessageId,
  currentUserId,
  currentUserIds,
  reactionsEnabled = true,
  canRetry,
  isRetrying,
  onRetry,
  onLongPress,
  onReactionPress,
  onDoubleTapReaction,
  onOpenImage,
  onJumpToMessage,
  renderHighlightedText,
  formatTime,
  parseMessageText,
  chatImageSize,
  replyBubbleMinWidth
}) => {
  const isSelf = Boolean(presentation?.isOwnMessage);
  const isMsgDriver = !!message?.isDriver;
  const isDeleted = !!message?.deleted;
  const isImage = message?.type === 'image';
  const isSearchMatch = !!activeSearchResultMessageId && activeSearchResultMessageId === message?.id;
  const isReplyJumpTarget = !!highlightedReplyTargetMessageId && highlightedReplyTargetMessageId === message?.id;
  const lastTapAtRef = useRef(0);
  const longPressTriggeredRef = useRef(false);
  const handlePress = useCallback(() => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      lastTapAtRef.current = 0;
      return;
    }
    if (!onDoubleTapReaction || !message?.id) return;
    const now = Date.now();
    if (now - lastTapAtRef.current <= DOUBLE_TAP_REACTION_DELAY_MS) {
      lastTapAtRef.current = 0;
      onDoubleTapReaction(message.id, HEART_REACTION);
      return;
    }
    lastTapAtRef.current = now;
  }, [message?.id, onDoubleTapReaction]);
  const handleLongPress = useCallback(() => {
    longPressTriggeredRef.current = true;
    lastTapAtRef.current = 0;
    onLongPress(message);
  }, [message, onLongPress]);
  if (isDeleted) {
    return <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
        <View style={[styles.messageBubble, styles.deletedMessageBubble]}>
          <Text style={styles.deletedMessageText}>
            <MaterialCommunityIcons name="cancel" size={14} color={COLORS.secondaryText} />
            {' This message was deleted'}
          </Text>
        </View>
      </View>;
  }
  const textParts = parseMessageText(message?.text);
  const hasLink = textParts.some(part => part.type === 'link');
  const clusterPosition = presentation?.clusterPosition || 'single';
  const showSender = Boolean(presentation?.showSender);
  const hasReplyReference = Boolean(message?.replyTo?.messageId);
  return <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={300}>
      <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
        <View style={[styles.messageBubble, isSelf ? styles.myMessageBubble : styles.theirMessageBubble, isSelf && clusterPosition === 'first' && styles.myMessageBubbleClusterFirst, isSelf && clusterPosition === 'middle' && styles.myMessageBubbleClusterMiddle, isSelf && clusterPosition === 'last' && styles.myMessageBubbleClusterLast, !isSelf && clusterPosition === 'first' && styles.theirMessageBubbleClusterFirst, !isSelf && clusterPosition === 'middle' && styles.theirMessageBubbleClusterMiddle, !isSelf && clusterPosition === 'last' && styles.theirMessageBubbleClusterLast, isMsgDriver && !isSelf && styles.driverMessageBubble, isImage && styles.imageMessageBubble, hasReplyReference && {
        minWidth: replyBubbleMinWidth
      }, isSearchMatch && styles.searchFocusedBubble, isReplyJumpTarget && styles.replyJumpTargetBubble]}>
          {showSender && <View style={styles.messageHeader}>
              <Text numberOfLines={1} style={[styles.senderName, isMsgDriver && !isSelf && styles.driverSenderName]}>
                {message?.senderName || 'Participant'}
              </Text>
              {isMsgDriver && <View style={styles.driverBadge}>
                  <Text style={styles.driverBadgeText}>DRIVER</Text>
                </View>}
            </View>}

          {message?.replyTo?.messageId && <TouchableOpacity activeOpacity={0.85} style={[styles.replyReferenceCard, isSelf && styles.replyReferenceCardSelf]} onPress={() => onJumpToMessage(message.replyTo.messageId, message.replyTo.idempotencyKey)}>
              <View style={styles.replyReferenceAccent} />
              <View style={styles.replyReferenceContent}>
                <Text numberOfLines={1} style={[styles.replyReferenceSender, isSelf && styles.replyReferenceSenderSelf]}>
                  {message.replyTo.senderName || 'Participant'}
                </Text>
                <Text numberOfLines={2} style={[styles.replyReferencePreview, isSelf && styles.replyReferencePreviewSelf]}>
                  {message.replyTo.previewText || 'Message'}
                </Text>
              </View>
              <MaterialCommunityIcons name="arrow-top-right" size={14} color={isSelf ? COLORS.lightBlueAccent : COLORS.secondaryText} />
            </TouchableOpacity>}

          {isImage && message?.imageUrl && <ImageMessage imageUrl={message.imageUrl} onPress={() => onOpenImage(message.imageUrl)} imageSize={chatImageSize} />}

          {!!message?.text && <Text style={[styles.messageText, isSelf && styles.myMessageText]}>
              {textParts.map((part, index) => part.type === 'link' ? <Text key={`${message.id}-link-${index}`} style={[styles.linkInMessage, isSelf && styles.linkInMessageSelf]} onPress={() => openChatExternalLink(part.content)}>
                    {part.content}
                  </Text> : <Text key={`${message.id}-text-${index}`}>{renderHighlightedText(part.content, isSelf)}</Text>)}
            </Text>}

          {hasLink && !isSelf && <LinkPreview url={textParts.find(p => p.type === 'link')?.content || ''} />}

          <View style={styles.messageFooter}>
            <Text style={[styles.timestamp, isSelf && styles.myTimestamp]}>
              {formatTime(message?.timestamp)}
            </Text>
            <MessageStatus status={message?.status} isSelf={isSelf} />
          </View>

          {canRetry && <TouchableOpacity activeOpacity={0.85} style={[styles.failedMessageRetryChip, isRetrying && styles.failedMessageRetryChipDisabled]} onPress={() => onRetry(message)} disabled={isRetrying} accessibilityRole="button" accessibilityLabel={isRetrying ? 'Retrying message' : 'Retry sending failed message'}>
              {isRetrying ? <ActivityIndicator size="small" color={COLORS.white} /> : <MaterialCommunityIcons name="refresh" size={14} color={COLORS.white} />}
              <Text style={styles.failedMessageRetryText}>
                {isRetrying ? 'Retrying...' : 'Tap to retry'}
              </Text>
            </TouchableOpacity>}

          {reactionsEnabled && <MessageReactions reactions={message?.reactions} onReactionPress={onReactionPress} messageId={message?.id} currentUserId={currentUserId} currentUserIds={currentUserIds} />}
        </View>
      </View>
    </Pressable>;
});
export const MessageRow = React.memo(({
  item,
  unreadAnchorMessageId,
  onRowLayout,
  onSwipeReply,
  ...bubbleProps
}) => {
  if (item.type === 'date') return <DateSeparator date={item.date} />;
  if (item.type === 'unread-separator') return <UnreadSeparator />;
  const messageId = item.data?.id;
  return <View onLayout={event => {
    if (!messageId) return;
    onRowLayout(messageId, event.nativeEvent.layout);
  }}>
      <SwipeToReplyMessageWrapper onSwipeReply={() => onSwipeReply(item.data)} disabled={!!item.data?.deleted}>
        <MessageBubble message={item.data} presentation={item.presentation} {...bubbleProps} />
      </SwipeToReplyMessageWrapper>
    </View>;
});
export const ChatTimeline = React.memo(({
  loading,
  messageListRef,
  groupedMessages,
  keyExtractor,
  renderMessageRow,
  renderEmptyMessages,
  listBottomSpacerHeight,
  onLayout,
  onContentSizeChange,
  onScroll,
  onScrollBeginDrag,
  onScrollToIndexFailed,
  refreshing,
  onRefresh,
  hasMoreHistory,
  loadingOlderMessages,
  onLoadOlderMessages
}) => {
  if (loading) {
    return <ChatLoadingSkeleton />;
  }
  return <FlatList ref={messageListRef} contentContainerStyle={styles.messagesScrollContainer} data={groupedMessages} keyExtractor={keyExtractor} renderItem={renderMessageRow} ListEmptyComponent={renderEmptyMessages} ListHeaderComponent={<LoadOlderControl visible={hasMoreHistory && groupedMessages.length > 0} loading={loadingOlderMessages} onPress={onLoadOlderMessages} />} removeClippedSubviews={Platform.OS === 'android'} initialNumToRender={20} maxToRenderPerBatch={12} updateCellsBatchingPeriod={24} windowSize={7} onLayout={onLayout} onContentSizeChange={onContentSizeChange} ListFooterComponent={<View style={{
    height: listBottomSpacerHeight
  }} />} onScroll={onScroll} onScrollBeginDrag={onScrollBeginDrag} scrollEventThrottle={16} keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} onScrollToIndexFailed={onScrollToIndexFailed} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[COLORS.primaryBlue]} tintColor={COLORS.primaryBlue} />} />;
});
export const ChatComposer = React.memo(({
  composerBottomInset,
  inputHeight,
  inputText,
  sending,
  replyingToMessage,
  showAttachmentMenu,
  attachmentsEnabled = true,
  onComposerLayout,
  onCancelReply,
  onToggleAttachments,
  onTextChange,
  onInputContentSizeChange,
  onSendMessage
}) => <View style={[styles.inputDock, {
  paddingBottom: composerBottomInset
}]} onLayout={onComposerLayout}>
    <View style={styles.inputArea}>
      {replyingToMessage?.messageId && <View style={styles.replyComposerCard}>
          <View style={styles.replyComposerAccent} />
          <View style={styles.replyComposerBody}>
            <Text numberOfLines={1} style={styles.replyComposerTitle}>
              Replying to {replyingToMessage.senderName || 'Participant'}
            </Text>
            <Text numberOfLines={1} style={styles.replyComposerPreview}>
              {replyingToMessage.previewText || 'Message'}
            </Text>
          </View>
          <TouchableOpacity style={styles.replyComposerClose} onPress={onCancelReply} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Cancel reply">
            <MaterialCommunityIcons name="close" size={16} color={COLORS.secondaryText} />
          </TouchableOpacity>
        </View>}

      <View style={styles.composerInputRow}>
        {attachmentsEnabled && <TouchableOpacity style={styles.attachButton} onPress={onToggleAttachments} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={showAttachmentMenu ? 'Close attachments' : 'Open attachments'}>
            <MaterialCommunityIcons name={showAttachmentMenu ? 'close' : 'plus-circle'} size={28} color={showAttachmentMenu ? COLORS.secondaryText : COLORS.primaryBlue} />
          </TouchableOpacity>}

        <TextInput style={[styles.textInput, {
        height: Math.min(Math.max(44, inputHeight), 120)
      }]} placeholder="Type your message..." placeholderTextColor={COLORS.tertiaryText} value={inputText} onChangeText={onTextChange} multiline onContentSizeChange={onInputContentSizeChange} selectionColor={COLORS.primaryBlue} editable blurOnSubmit={false} />

        <TouchableOpacity style={[styles.sendButton, (sending || !inputText.trim()) && styles.sendButtonDisabled]} onPress={onSendMessage} activeOpacity={0.7} disabled={sending || !inputText.trim()} accessibilityRole="button" accessibilityLabel="Send message">
          {sending ? <ActivityIndicator size="small" color={COLORS.sendButtonColor} /> : <MaterialCommunityIcons name="send-circle" size={38} color={inputText.trim() === '' ? COLORS.tertiaryText : COLORS.sendButtonColor} />}
        </TouchableOpacity>
      </View>
    </View>
  </View>);

// ==================== MAIN CHAT SCREEN ====================
