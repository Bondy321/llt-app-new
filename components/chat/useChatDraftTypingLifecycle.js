// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { setTypingStatus, setOnlinePresence } from '../../services/chatService';
import offlineSyncService from '../../services/offlineSyncService';
export default function useChatDraftTypingLifecycle(context, late) {
  const {
    chatQueueScope,
    chatScope,
    draftRestored,
    inputText,
    isAtBottomRef,
    isDriver,
    realtimeActorId,
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
    if (!tourId || !realtimeActorId) return;
    setOnlinePresence(tourId, realtimeActorId, userName, true, isDriver, undefined, {
      scope: chatScope
    });
    return () => {
      setOnlinePresence(tourId, realtimeActorId, userName, false, isDriver, undefined, {
        scope: chatScope
      });
      setTypingStatus(tourId, realtimeActorId, userName, false, isDriver, undefined, {
        scope: chatScope
      });
    };
  }, [chatScope, tourId, realtimeActorId, userName, isDriver]);

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
    if (!tourId || !realtimeActorId) return;

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set typing status
    if (text.trim().length > 0) {
      setTypingStatus(tourId, realtimeActorId, userName, true, isDriver, undefined, {
        scope: chatScope
      });

      // Clear typing after 3 seconds of inactivity
      typingTimeoutRef.current = setTimeout(() => {
        setTypingStatus(tourId, realtimeActorId, userName, false, isDriver, undefined, {
          scope: chatScope
        });
      }, 3000);
    } else {
      setTypingStatus(tourId, realtimeActorId, userName, false, isDriver, undefined, {
        scope: chatScope
      });
    }
  }, [draftRestored, inputText, setInputText, tourId, realtimeActorId, typingTimeoutRef, setDraftRestored, userName, isDriver, chatScope]);

  // Send message handler
  Object.assign(late.current, {
    handleTextChange
  });
  return {
    handleTextChange
  };
}
