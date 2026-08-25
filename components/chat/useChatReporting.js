// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { Alert } from 'react-native';
import * as Haptics from '../../services/hapticsService';
import { REPORT_REASON_OPTIONS, createContentReport } from '../../services/contentModerationService';
import { getCurrentAuthUser } from '../../services/authStateService';
import { getMessageModerationSenderKey, buildReplyPreviewText } from "./chatShared";
export default function useChatReporting(context, late) {
  const {
    authUid,
    hideMessageLocally,
    internalDriverChat,
    principalId,
    selectedMessage,
    setSelectedMessage,
    setShowActionMenu,
    showTransientFeedback,
    tourId,
    userName
  } = context;
  const submitSelectedMessageReport = useCallback(async reason => {
    const message = selectedMessage;
    if (!message?.id) return;
    setShowActionMenu(false);
    setSelectedMessage(null);
    const chatScopeForReport = internalDriverChat ? 'internal' : 'group';
    const reportResult = await createContentReport({
      tourId,
      contentType: 'chat_message',
      contentId: message.id,
      chatScope: chatScopeForReport,
      reason,
      reporterId: principalId,
      reporterAuthUid: authUid || getCurrentAuthUser()?.uid || principalId,
      reporterName: userName,
      contentOwnerId: getMessageModerationSenderKey(message) || message.senderId || '',
      contentOwnerName: message.senderName || 'Tour participant',
      contentPreview: buildReplyPreviewText(message),
      sourcePath: `${chatScopeForReport === 'internal' ? 'internal_chats' : 'chats'}/${tourId}/messages/${message.id}`
    });
    if (reportResult.success) {
      hideMessageLocally(message.id);
      showTransientFeedback({
        type: 'success',
        icon: 'flag-checkered',
        message: 'Report sent to Loch Lomond Travel operations.'
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    showTransientFeedback({
      type: 'warning',
      icon: 'flag-remove-outline',
      message: 'Report could not be sent. Please try again or contact support.'
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, [authUid, hideMessageLocally, internalDriverChat, principalId, selectedMessage, setSelectedMessage, setShowActionMenu, showTransientFeedback, tourId, userName]);
  const handleReportMessage = useCallback(() => {
    if (!selectedMessage?.id) return;
    Alert.alert('Report message', 'Send this message to Loch Lomond Travel operations for review.', [...REPORT_REASON_OPTIONS.map(option => ({
      text: option.label,
      onPress: () => submitSelectedMessageReport(option.key)
    })), {
      text: 'Cancel',
      style: 'cancel'
    }]);
  }, [selectedMessage, submitSelectedMessageReport]);
  Object.assign(late.current, {
    submitSelectedMessageReport,
    handleReportMessage
  });
  return {
    submitSelectedMessageReport,
    handleReportMessage
  };
}
