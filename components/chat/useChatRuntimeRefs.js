// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect, useRef } from 'react';
import logger from '../../services/loggerService';
import { CATCH_UP_BUBBLE_DISTANCE_THRESHOLD, parseModerationMap } from "./chatShared";
export default function useChatRuntimeRefs(context, late) {
  const {
    hiddenMessagesStorageKey,
    internalDriverChat,
    messages,
    messagesRef,
    moderationStorage,
    mutedSendersStorageKey,
    setHiddenMessageIds,
    setMutedSenderIds,
    setShowAttachmentMenu,
    setShowJumpToUnread,
    setShowReactionPicker
  } = context;
  const currentScrollYRef = useRef(0);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages, messagesRef]);
  useEffect(() => {
    let active = true;
    if (!hiddenMessagesStorageKey) {
      setHiddenMessageIds({});
      return () => {
        active = false;
      };
    }
    moderationStorage.getItemAsync(hiddenMessagesStorageKey).then(storedValue => {
      if (active) setHiddenMessageIds(parseModerationMap(storedValue));
    }).catch(error => {
      logger.warn('ChatScreen', 'Hidden message state restore failed', {
        error: error?.message || String(error)
      });
      if (active) setHiddenMessageIds({});
    });
    return () => {
      active = false;
    };
  }, [hiddenMessagesStorageKey, moderationStorage, setHiddenMessageIds]);
  useEffect(() => {
    let active = true;
    if (!mutedSendersStorageKey) {
      setMutedSenderIds({});
      return () => {
        active = false;
      };
    }
    moderationStorage.getItemAsync(mutedSendersStorageKey).then(storedValue => {
      if (active) setMutedSenderIds(parseModerationMap(storedValue));
    }).catch(error => {
      logger.warn('ChatScreen', 'Muted sender state restore failed', {
        error: error?.message || String(error)
      });
      if (active) setMutedSenderIds({});
    });
    return () => {
      active = false;
    };
  }, [moderationStorage, mutedSendersStorageKey, setMutedSenderIds]);
  const persistModerationMap = useCallback((key, value) => {
    if (!key) return;
    moderationStorage.setItemAsync(key, JSON.stringify(value)).catch(error => {
      logger.warn('ChatScreen', 'Content moderation state persist failed', {
        key,
        error: error?.message || String(error)
      });
    });
  }, [moderationStorage]);
  const hideMessageLocally = useCallback(messageId => {
    if (!messageId) return;
    setHiddenMessageIds(prev => {
      const next = {
        ...prev,
        [messageId]: true
      };
      persistModerationMap(hiddenMessagesStorageKey, next);
      return next;
    });
  }, [hiddenMessagesStorageKey, persistModerationMap, setHiddenMessageIds]);
  const muteSenderLocally = useCallback(senderKey => {
    if (!senderKey) return;
    setMutedSenderIds(prev => {
      const next = {
        ...prev,
        [senderKey]: true
      };
      persistModerationMap(mutedSendersStorageKey, next);
      return next;
    });
  }, [mutedSendersStorageKey, persistModerationMap, setMutedSenderIds]);
  useEffect(() => {
    if (!internalDriverChat) return;
    setShowAttachmentMenu(false);
    setShowReactionPicker(false);
  }, [internalDriverChat, setShowAttachmentMenu, setShowReactionPicker]);
  const updateUnreadJumpVisibility = useCallback((scrollY, anchorY) => {
    if (anchorY == null) {
      setShowJumpToUnread(false);
      return;
    }
    const shouldShow = Math.abs(scrollY - anchorY) > CATCH_UP_BUBBLE_DISTANCE_THRESHOLD;
    setShowJumpToUnread(prev => prev === shouldShow ? prev : shouldShow);
  }, [setShowJumpToUnread]);
  Object.assign(late.current, {
    currentScrollYRef,
    persistModerationMap,
    hideMessageLocally,
    muteSenderLocally,
    updateUnreadJumpVisibility
  });
  return {
    currentScrollYRef,
    persistModerationMap,
    hideMessageLocally,
    muteSenderLocally,
    updateUnreadJumpVisibility
  };
}
