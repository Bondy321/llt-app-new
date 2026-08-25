// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { openChatExternalLink, COLORS, isMessageOwnedByCurrentSession } from "./chatShared";
import { MessageReactions, ImageMessage, LinkPreview, MessageStatus, SwipeToReplyMessageWrapper } from "./ChatMessageActions";
import styles from "./chatStyles";
export default function useChatMessageRenderer(context, late) {
  const {
    activeSearchResultMessageId,
    canRetryFailedMessageForCurrentSession,
    canonicalIdentity,
    chatImageSize,
    currentReactionUserIds,
    formatTime,
    handleMessageLongPress,
    handleReaction,
    handleRetryFailedMessage,
    highlightedReplyTargetMessageId,
    jumpToMessageById,
    parseMessageText,
    realtimeActorId,
    renderHighlightedText,
    replyBubbleMinWidth,
    retryingMessageIds,
    setViewingImage,
    startReplyComposer
  } = context;
  // Render a single message
  const renderMessage = useCallback(msg => {
    const isSelf = isMessageOwnedByCurrentSession(msg, canonicalIdentity);
    const isMsgDriver = !!msg.isDriver;
    const isDeleted = !!msg.deleted;
    const isImage = msg.type === 'image';
    const isSearchMatch = !!activeSearchResultMessageId && activeSearchResultMessageId === msg.id;
    const isReplyJumpTarget = !!highlightedReplyTargetMessageId && highlightedReplyTargetMessageId === msg.id;
    const isRetryEligible = canRetryFailedMessageForCurrentSession(msg);
    const isRetrying = !!retryingMessageIds[msg.id];
    if (isDeleted) {
      return <View key={msg.id} style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
            <View style={[styles.messageBubble, styles.deletedMessageBubble]}>
              <Text style={styles.deletedMessageText}>
                <MaterialCommunityIcons name="cancel" size={14} color={COLORS.secondaryText} />
                {' This message was deleted'}
              </Text>
            </View>
          </View>;
    }
    const textParts = parseMessageText(msg.text);
    const hasLink = textParts.some(part => part.type === 'link');
    const messageBody = <Pressable key={msg.id} onLongPress={() => handleMessageLongPress(msg)} delayLongPress={300}>
          <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
            <View style={[styles.messageBubble, isSelf ? styles.myMessageBubble : styles.theirMessageBubble, isMsgDriver && !isSelf && styles.driverMessageBubble, isImage && styles.imageMessageBubble, msg.replyTo?.messageId && {
          minWidth: replyBubbleMinWidth
        }, isSearchMatch && styles.searchFocusedBubble, isReplyJumpTarget && styles.replyJumpTargetBubble]}>
              {/* Message Header */}
              <View style={styles.messageHeader}>
                <Text style={[styles.senderName, isSelf && styles.mySenderName, isMsgDriver && !isSelf && styles.driverSenderName]}>
                  {msg.senderName || 'Participant'}
                </Text>
                {isMsgDriver && <View style={styles.driverBadge}>
                    <Text style={styles.driverBadgeText}>DRIVER</Text>
                  </View>}
              </View>

              {msg.replyTo?.messageId && <TouchableOpacity activeOpacity={0.85} style={[styles.replyReferenceCard, isSelf && styles.replyReferenceCardSelf]} onPress={() => jumpToMessageById(msg.replyTo.messageId, msg.replyTo.idempotencyKey)}>
                  <View style={styles.replyReferenceAccent} />
                  <View style={styles.replyReferenceContent}>
                    <Text numberOfLines={1} style={[styles.replyReferenceSender, isSelf && styles.replyReferenceSenderSelf]}>
                      {msg.replyTo.senderName || 'Participant'}
                    </Text>
                    <Text numberOfLines={2} style={[styles.replyReferencePreview, isSelf && styles.replyReferencePreviewSelf]}>
                      {msg.replyTo.previewText || 'Message'}
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="arrow-top-right" size={14} color={isSelf ? COLORS.lightBlueAccent : COLORS.secondaryText} />
                </TouchableOpacity>}

              {/* Image Content */}
              {isImage && msg.imageUrl && <ImageMessage imageUrl={msg.imageUrl} onPress={() => setViewingImage(msg.imageUrl)} imageSize={chatImageSize} />}

              {/* Text Content with Link Detection */}
              {msg.text && <Text style={[styles.messageText, isSelf && styles.myMessageText]}>
                  {textParts.map((part, index) => part.type === 'link' ? <Text key={index} style={[styles.linkInMessage, isSelf && styles.linkInMessageSelf]} onPress={() => openChatExternalLink(part.content)}>
                        {part.content}
                      </Text> : <Text key={index}>{renderHighlightedText(part.content, isSelf)}</Text>)}
                </Text>}

              {/* Link Preview */}
              {hasLink && !isSelf && <LinkPreview url={textParts.find(p => p.type === 'link')?.content || ''} />}

              {/* Timestamp and Status */}
              <View style={styles.messageFooter}>
                <Text style={[styles.timestamp, isSelf && styles.myTimestamp]}>
                  {formatTime(msg.timestamp)}
                </Text>
                <MessageStatus status={msg.status} isSelf={isSelf} />
              </View>

              {isRetryEligible && <TouchableOpacity activeOpacity={0.85} style={[styles.failedMessageRetryChip, isRetrying && styles.failedMessageRetryChipDisabled]} onPress={() => handleRetryFailedMessage(msg)} disabled={isRetrying} accessibilityRole="button" accessibilityLabel={isRetrying ? 'Retrying message' : 'Retry sending failed message'}>
                  {isRetrying ? <ActivityIndicator size="small" color={COLORS.white} /> : <MaterialCommunityIcons name="refresh" size={14} color={COLORS.white} />}
                  <Text style={styles.failedMessageRetryText}>
                    {isRetrying ? 'Retrying…' : 'Tap to retry'}
                  </Text>
                </TouchableOpacity>}

              {/* Reactions */}
              <MessageReactions reactions={msg.reactions} onReactionPress={handleReaction} messageId={msg.id} currentUserId={realtimeActorId} currentUserIds={currentReactionUserIds} />
            </View>
          </View>
        </Pressable>;
    return <SwipeToReplyMessageWrapper onSwipeReply={() => startReplyComposer(msg, 'swipe')} disabled={isDeleted}>
          {messageBody}
        </SwipeToReplyMessageWrapper>;
  }, [canonicalIdentity, activeSearchResultMessageId, highlightedReplyTargetMessageId, canRetryFailedMessageForCurrentSession, retryingMessageIds, parseMessageText, replyBubbleMinWidth, chatImageSize, formatTime, handleReaction, realtimeActorId, currentReactionUserIds, handleMessageLongPress, jumpToMessageById, setViewingImage, renderHighlightedText, handleRetryFailedMessage, startReplyComposer]);
  Object.assign(late.current, {
    renderMessage
  });
  return {
    renderMessage
  };
}
