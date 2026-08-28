// screens/ChatScreen.js - Premium Chat Experience
import { useEffect } from 'react';
import { subscribeToTypingIndicators, subscribeToPresence } from '../../services/chatService';
export default function useChatPersistenceLifecycle(context, late) {
  const {
    chatScope,
    draftStorage,
    draftStorageKey,
    inputText,
    markActiveChatRead,
    statusActorId,
    setDraftRestored,
    setInputText,
    setPresenceInfo,
    setShowSwipeReplyHint,
    setTypingUsers,
    swipeReplyHintStorageKey,
    tourId,
    uxHintStorage
  } = context;
  // Restore persisted chat draft for this tour/user context
  useEffect(() => {
    let active = true;
    if (!draftStorageKey) {
      setInputText('');
      setDraftRestored(false);
      return;
    }
    setDraftRestored(false);
    const restoreDraft = async () => {
      try {
        const savedDraft = await draftStorage.getItemAsync(draftStorageKey);
        if (!active || typeof savedDraft !== 'string') return;
        if (savedDraft.trim().length > 0) {
          setInputText(savedDraft);
          setDraftRestored(true);
        } else {
          setInputText('');
          setDraftRestored(false);
        }
      } catch (_error) {
        setInputText('');
        setDraftRestored(false);
      }
    };
    restoreDraft();
    return () => {
      active = false;
    };
  }, [draftStorage, draftStorageKey, setDraftRestored, setInputText]);

  // Persist draft while the user is typing
  // Persist draft while the user is typing
  useEffect(() => {
    if (!draftStorageKey) return;
    const timeout = setTimeout(() => {
      if (inputText.trim().length === 0) {
        draftStorage.deleteItemAsync(draftStorageKey);
      } else {
        draftStorage.setItemAsync(draftStorageKey, inputText);
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [draftStorage, draftStorageKey, inputText]);
  useEffect(() => {
    let active = true;
    if (!swipeReplyHintStorageKey) {
      setShowSwipeReplyHint(false);
      return;
    }
    const restoreHintState = async () => {
      try {
        const seenValue = await uxHintStorage.getItemAsync(swipeReplyHintStorageKey);
        if (!active) return;
        setShowSwipeReplyHint(seenValue !== '1');
      } catch (_error) {
        if (active) setShowSwipeReplyHint(true);
      }
    };
    restoreHintState();
    return () => {
      active = false;
    };
  }, [setShowSwipeReplyHint, swipeReplyHintStorageKey, uxHintStorage]);

  // Mark chat as read when screen opens with a valid user/tour context
  // Mark chat as read when screen opens with a valid user/tour context
  useEffect(() => {
    markActiveChatRead();
  }, [markActiveChatRead]);

  // Subscribe to typing indicators
  // Subscribe to typing indicators
  useEffect(() => {
    if (!tourId || !statusActorId) return;
    const unsubscribe = subscribeToTypingIndicators(tourId, statusActorId, setTypingUsers, undefined, {
      scope: chatScope
    });
    return () => unsubscribe();
  }, [chatScope, tourId, statusActorId, setTypingUsers]);

  // Subscribe to presence
  // Subscribe to presence
  useEffect(() => {
    if (!tourId) return;
    const unsubscribe = subscribeToPresence(tourId, setPresenceInfo, undefined, {
      scope: chatScope
    });
    return () => unsubscribe();
  }, [chatScope, setPresenceInfo, tourId]);
  Object.assign(late.current, {});
  return {};
}
