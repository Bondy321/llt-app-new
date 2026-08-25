// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import * as Haptics from '../../services/hapticsService';
import { toggleReaction } from '../../services/chatService';
import { maskIdentifier } from '../../services/loggerService';
import { isRealtimeKeySegment } from '../../services/identityService';
import { normalizeReactionMap, maskReactionDebugIds, summarizeReactionDebugId, rawReactionDebugIds, logChatReactionDebug, applyOptimisticReactionToggle, applyOptimisticReactionAdd } from "./chatShared";
export default function useChatReactions(context, late) {
  const {
    currentReactionUserIds,
    inFlightReactionKeysRef,
    internalDriverChat,
    messagesRef,
    realtimeActorId,
    selectedMessage,
    setMessages,
    setSelectedMessage,
    setShowReactionPicker,
    showReactionFailureFeedback,
    showTransientFeedback,
    tourId
  } = context;
  // Handle reaction
  const handleReaction = useCallback(async (messageId, emoji, options = {}) => {
    if (!realtimeActorId) return;
    if (!messageId || !emoji) return;
    if (internalDriverChat) {
      setShowReactionPicker(false);
      setSelectedMessage(null);
      showTransientFeedback({
        type: 'info',
        icon: 'emoticon-outline',
        message: 'Reactions are available in the group chat.'
      });
      return;
    }
    const forceAction = options?.forceAction === 'add' ? 'add' : null;
    const reactionSource = options?.source || 'manual';
    const selectedMessageAtTap = selectedMessage;
    setShowReactionPicker(false);
    setSelectedMessage(null);
    const lockKey = `${messageId}::${emoji}::${realtimeActorId}`;
    if (inFlightReactionKeysRef.current.has(lockKey)) {
      return;
    }
    inFlightReactionKeysRef.current.add(lockKey);
    const currentMessages = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    const targetMessage = currentMessages.find(message => message?.id === messageId) || (selectedMessageAtTap?.id === messageId ? selectedMessageAtTap : null);
    if (!targetMessage) {
      logChatReactionDebug('chat_reaction_target_message_missing', {
        tourId,
        messageId,
        emoji,
        realtimeActorIdMasked: maskIdentifier(realtimeActorId),
        knownMessageCount: currentMessages.length,
        knownMessageIdsSample: currentMessages.slice(-10).map(message => message?.id).filter(Boolean),
        selectedMessageIdAtTap: selectedMessageAtTap?.id || null
      }, 'warn');
      inFlightReactionKeysRef.current.delete(lockKey);
      return;
    }
    const rollbackReactions = normalizeReactionMap(targetMessage.reactions);
    let reactionActorId = realtimeActorId;
    const existingUserIdsForEmoji = rollbackReactions[emoji] || [];
    const writableExistingActorId = currentReactionUserIds.find(candidateId => existingUserIdsForEmoji.includes(candidateId) && isRealtimeKeySegment(candidateId));
    reactionActorId = writableExistingActorId || realtimeActorId;
    const {
      nextReactions,
      action: optimisticAction,
      matchedUserIds: optimisticMatchedUserIds,
      nextEmojiUserIds: optimisticNextEmojiUserIds
    } = (forceAction === 'add' ? applyOptimisticReactionAdd : applyOptimisticReactionToggle)({
      reactions: targetMessage.reactions,
      emoji,
      userId: reactionActorId,
      userIdAliases: currentReactionUserIds
    });
    setMessages(prevMessages => prevMessages.map(message => message.id === messageId ? {
      ...message,
      reactions: nextReactions
    } : message));
    logChatReactionDebug('chat_reaction_optimistic_applied', {
      tourId,
      messageId,
      emoji,
      realtimeActorIdMasked: maskIdentifier(realtimeActorId),
      chosenReactionActorIdMasked: maskIdentifier(reactionActorId),
      choseExistingSafeActor: reactionActorId !== realtimeActorId,
      aliasCount: currentReactionUserIds.length,
      aliasIdsMasked: maskReactionDebugIds(currentReactionUserIds),
      aliasKeys: rawReactionDebugIds(currentReactionUserIds),
      existingUserCountForEmoji: existingUserIdsForEmoji.length,
      existingUserIdsMasked: maskReactionDebugIds(existingUserIdsForEmoji),
      existingUserKeys: rawReactionDebugIds(existingUserIdsForEmoji),
      matchedCurrentUserIdsMasked: maskReactionDebugIds(optimisticMatchedUserIds),
      matchedCurrentUserKeys: rawReactionDebugIds(optimisticMatchedUserIds),
      optimisticAction,
      forceAction,
      reactionSource,
      nextUserCountForEmoji: optimisticNextEmojiUserIds.length,
      nextUserIdsMasked: maskReactionDebugIds(optimisticNextEmojiUserIds),
      nextUserKeys: rawReactionDebugIds(optimisticNextEmojiUserIds),
      reactionActorKey: summarizeReactionDebugId(reactionActorId)
    });
    try {
      logChatReactionDebug('chat_reaction_service_call_start', {
        tourId,
        messageId,
        emoji,
        reactionActorIdMasked: maskIdentifier(reactionActorId),
        reactionActorKey: summarizeReactionDebugId(reactionActorId),
        reactionActorKeyIsRealtimeSafe: isRealtimeKeySegment(reactionActorId),
        forceAction,
        reactionSource
      });
      const result = await toggleReaction(tourId, messageId, emoji, reactionActorId, undefined, forceAction ? {
        forceAction
      } : undefined);
      if (!result?.success) {
        throw new Error(result?.error || 'Unknown error');
      }
      logChatReactionDebug('chat_reaction_service_call_success', {
        tourId,
        messageId,
        emoji,
        reactionActorIdMasked: maskIdentifier(reactionActorId),
        serviceAction: result.action || null,
        serviceUserCount: Array.isArray(result.users) ? result.users.length : null,
        serviceActorPresent: Array.isArray(result.users) ? result.users.includes(reactionActorId) : null,
        serviceUsersMasked: maskReactionDebugIds(result.users || []),
        serviceUserKeys: rawReactionDebugIds(result.users || []),
        forceAction,
        reactionSource
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      setMessages(prevMessages => prevMessages.map(message => message.id === messageId ? {
        ...message,
        reactions: rollbackReactions || {}
      } : message));
      logChatReactionDebug('chat_reaction_toggle_failed_rolled_back', {
        tourId,
        messageId,
        emoji,
        userId: maskIdentifier(reactionActorId),
        reactionActorKey: summarizeReactionDebugId(reactionActorId),
        reactionActorKeyIsRealtimeSafe: isRealtimeKeySegment(reactionActorId),
        forceAction,
        reactionSource,
        error: error?.message || 'Unknown error'
      }, 'warn');
      showReactionFailureFeedback('Could not update reaction. Check your connection and try again.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      inFlightReactionKeysRef.current.delete(lockKey);
    }
  }, [currentReactionUserIds, inFlightReactionKeysRef, internalDriverChat, messagesRef, realtimeActorId, selectedMessage, setMessages, setSelectedMessage, setShowReactionPicker, showReactionFailureFeedback, showTransientFeedback, tourId]);
  Object.assign(late.current, {
    handleReaction
  });
  return {
    handleReaction
  };
}
