// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { setTypingStatus, setOnlinePresence } from '../../services/chatService';
import offlineSyncService from '../../services/offlineSyncService';
const CHAT_PRESENCE_HEARTBEAT_MS = 2 * 60 * 1000;
export default function useChatDraftTypingLifecycle(context, late) {
  const {
    chatQueueScope,
    chatScope,
    draftRestored,
    inputText,
    isAtBottomRef,
    isDriver,
    offlineSessionScope,
    statusActorId,
    scrollToBottom,
    setDraftRestored,
    setInputText,
    setIsKeyboardVisible,
    setKeyboardHeight,
    setQueueStats,
    summarizeChatQueueActions,
    tourId,
    typingTimeoutRef,
    userName
  } = context;
  // Subscribe to offline queue state updates
  useEffect(() => {
    if (!tourId) {
      setQueueStats({
        pending: 0,
        syncing: 0,
        failed: 0,
        total: 0
      });
      return;
    }
    const unsubscribe = offlineSyncService.subscribeQueuedActions(actions => {
      setQueueStats(summarizeChatQueueActions(actions));
    }, chatQueueScope ? {
      scope: chatQueueScope
    } : undefined);
    return () => unsubscribe();
  }, [chatQueueScope, setQueueStats, summarizeChatQueueActions, tourId]);

  // Set online presence on mount/unmount
  // Set online presence on mount/unmount
  useEffect(() => {
    if (!tourId || !statusActorId) return;
    const publishPresence = () => setOnlinePresence(tourId, statusActorId, userName, true, isDriver, undefined, {
      scope: chatScope,
      sessionScope: offlineSessionScope
    });
    publishPresence();
    const heartbeat = setInterval(publishPresence, CHAT_PRESENCE_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      setOnlinePresence(tourId, statusActorId, userName, false, isDriver, undefined, {
        scope: chatScope,
        sessionScope: offlineSessionScope
      });
      setTypingStatus(tourId, statusActorId, userName, false, isDriver, undefined, {
        scope: chatScope,
        sessionScope: offlineSessionScope
      });
    };
  }, [chatScope, tourId, statusActorId, userName, isDriver, offlineSessionScope]);

  // Keyboard listeners
  // Keyboard listeners
  useEffect(() => {
    const keyboardShowEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const keyboardHideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(keyboardShowEvent, event => {
      setIsKeyboardVisible(true);
      const nextKeyboardHeight = event?.endCoordinates?.height || 0;
      setKeyboardHeight(nextKeyboardHeight);
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(true));
      }
    });
    const hideSub = Keyboard.addListener(keyboardHideEvent, () => {
      setIsKeyboardVisible(false);
      setKeyboardHeight(0);
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(true));
      }
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [isAtBottomRef, scrollToBottom, setIsKeyboardVisible, setKeyboardHeight]);

  // Handle typing indicator
  // Handle typing indicator
  const handleTextChange = useCallback(text => {
    if (draftRestored && text !== inputText) {
      setDraftRestored(false);
    }
    setInputText(text);
    if (!tourId || !statusActorId) return;

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set typing status
    if (text.trim().length > 0) {
      setTypingStatus(tourId, statusActorId, userName, true, isDriver, undefined, {
        scope: chatScope,
        sessionScope: offlineSessionScope
      });

      // Clear typing after 3 seconds of inactivity
      typingTimeoutRef.current = setTimeout(() => {
        setTypingStatus(tourId, statusActorId, userName, false, isDriver, undefined, {
          scope: chatScope,
          sessionScope: offlineSessionScope
        });
      }, 3000);
    } else {
      setTypingStatus(tourId, statusActorId, userName, false, isDriver, undefined, {
        scope: chatScope,
        sessionScope: offlineSessionScope
      });
    }
  }, [draftRestored, inputText, setInputText, tourId, statusActorId, typingTimeoutRef, setDraftRestored, userName, isDriver, chatScope, offlineSessionScope]);

  // Send message handler
  Object.assign(late.current, {
    handleTextChange
  });
  return {
    handleTextChange
  };
}
