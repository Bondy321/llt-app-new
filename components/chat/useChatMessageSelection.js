// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from '../../services/hapticsService';
import { getMessageTextForCopy } from '../../services/chatService';
import { HEART_REACTION, openChatExternalLink, URL_REGEX, buildReplyPreviewText } from "./chatShared";
export default function useChatMessageSelection(context, late) {
  const {
    handleReaction,
    internalDriverChat,
    selectedMessage,
    setReplyingToMessage,
    setSelectedMessage,
    setShowActionMenu,
    setShowSwipeReplyHint,
    swipeReplyHintStorageKey,
    uxHintStorage
  } = context;
  const handleHeartReactionDoubleTap = useCallback(messageId => {
    if (internalDriverChat) return;
    handleReaction(messageId, HEART_REACTION, {
      forceAction: 'add',
      source: 'double_tap'
    });
  }, [handleReaction, internalDriverChat]);

  // Handle message long press
  // Handle message long press
  const handleMessageLongPress = useCallback(message => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedMessage(message);
    setShowActionMenu(true);
  }, [setSelectedMessage, setShowActionMenu]);
  const dismissSwipeReplyHint = useCallback(async () => {
    setShowSwipeReplyHint(false);
    if (!swipeReplyHintStorageKey) return;
    try {
      await uxHintStorage.setItemAsync(swipeReplyHintStorageKey, '1');
    } catch (_error) {
      // no-op: hint persistence failures should not break chat UX
    }
  }, [setShowSwipeReplyHint, swipeReplyHintStorageKey, uxHintStorage]);
  const startReplyComposer = useCallback((message, source = 'menu') => {
    if (!message) return;
    setReplyingToMessage({
      messageId: message.id,
      ...(message.idempotencyKey ? {
        idempotencyKey: message.idempotencyKey
      } : {}),
      senderName: message.senderName || 'Participant',
      previewText: buildReplyPreviewText(message)
    });
    if (source === 'swipe') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      dismissSwipeReplyHint();
    }
  }, [dismissSwipeReplyHint, setReplyingToMessage]);
  const handleReplyToMessage = useCallback(() => {
    if (!selectedMessage) return;
    startReplyComposer(selectedMessage, 'menu');
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [selectedMessage, setSelectedMessage, setShowActionMenu, startReplyComposer]);

  // Handle copy message
  // Handle copy message
  const handleCopyMessage = useCallback(() => {
    if (selectedMessage) {
      Clipboard.setString(getMessageTextForCopy(selectedMessage));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [selectedMessage, setSelectedMessage, setShowActionMenu]);
  const getSelectedMessageFirstLink = useCallback(() => {
    if (!selectedMessage || typeof selectedMessage.text !== 'string') return null;
    const matches = selectedMessage.text.match(URL_REGEX);
    return matches?.[0] || null;
  }, [selectedMessage]);
  const handleCopyFirstLink = useCallback(() => {
    const firstLink = getSelectedMessageFirstLink();
    if (!firstLink) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    Clipboard.setString(firstLink);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [getSelectedMessageFirstLink, setSelectedMessage, setShowActionMenu]);
  const handleOpenFirstLink = useCallback(async () => {
    const firstLink = getSelectedMessageFirstLink();
    if (!firstLink) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    try {
      const opened = await openChatExternalLink(firstLink);
      if (!opened) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (_error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setShowActionMenu(false);
      setSelectedMessage(null);
    }
  }, [getSelectedMessageFirstLink, setSelectedMessage, setShowActionMenu]);
  Object.assign(late.current, {
    handleHeartReactionDoubleTap,
    handleMessageLongPress,
    dismissSwipeReplyHint,
    startReplyComposer,
    handleReplyToMessage,
    handleCopyMessage,
    getSelectedMessageFirstLink,
    handleCopyFirstLink,
    handleOpenFirstLink
  });
  return {
    handleHeartReactionDoubleTap,
    handleMessageLongPress,
    dismissSwipeReplyHint,
    startReplyComposer,
    handleReplyToMessage,
    handleCopyMessage,
    getSelectedMessageFirstLink,
    handleCopyFirstLink,
    handleOpenFirstLink
  };
}
