// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { Alert } from 'react-native';
import * as Haptics from '../../services/hapticsService';
import { deleteMessage } from '../../services/chatService';
import { isMessageOwnedByCurrentSession, getMessageModerationSenderKey } from "./chatShared";
export default function useChatModerationActions(context, late) {
  const {
    canonicalIdentity,
    internalDriverChat,
    isDriver,
    muteSenderLocally,
    principalId,
    selectedMessage,
    setSelectedMessage,
    setShowActionMenu,
    showTransientFeedback,
    tourId
  } = context;
  const handleMuteSender = useCallback(() => {
    if (!selectedMessage?.id) return;
    const senderKey = getMessageModerationSenderKey(selectedMessage);
    if (!senderKey || isMessageOwnedByCurrentSession(selectedMessage, canonicalIdentity)) {
      setShowActionMenu(false);
      setSelectedMessage(null);
      showTransientFeedback({
        type: 'info',
        icon: 'account-alert-outline',
        message: 'This sender cannot be muted from this message.'
      });
      return;
    }
    Alert.alert('Mute sender?', 'Future messages from this sender will be hidden on this device. Loch Lomond Travel can still review reports you submit.', [{
      text: 'Cancel',
      style: 'cancel'
    }, {
      text: 'Mute sender',
      style: 'destructive',
      onPress: () => {
        muteSenderLocally(senderKey);
        setShowActionMenu(false);
        setSelectedMessage(null);
        showTransientFeedback({
          type: 'info',
          icon: 'account-cancel-outline',
          message: 'Sender muted on this device.'
        });
      }
    }]);
  }, [canonicalIdentity, muteSenderLocally, selectedMessage, setSelectedMessage, setShowActionMenu, showTransientFeedback]);

  // Handle delete message
  // Handle delete message
  const handleDeleteMessage = useCallback(async () => {
    if (internalDriverChat) {
      setShowActionMenu(false);
      setSelectedMessage(null);
      showTransientFeedback({
        type: 'info',
        icon: 'delete-outline',
        message: 'Internal driver chat messages cannot be deleted here.'
      });
      return;
    }
    if (selectedMessage) {
      const result = await deleteMessage(tourId, selectedMessage.id, principalId, isDriver);
      if (result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        showTransientFeedback({
          type: 'warning',
          icon: 'delete-alert-outline',
          message: 'Message could not be deleted. Please try again.'
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [internalDriverChat, isDriver, principalId, selectedMessage, setSelectedMessage, setShowActionMenu, showTransientFeedback, tourId]);

  // Handle refresh
  Object.assign(late.current, {
    handleMuteSender,
    handleDeleteMessage
  });
  return {
    handleMuteSender,
    handleDeleteMessage
  };
}
