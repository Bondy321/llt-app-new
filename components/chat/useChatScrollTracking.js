// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import { Keyboard } from 'react-native';
export default function useChatScrollTracking(context, late) {
  const {
    isKeyboardVisible,
    readStateStorage,
    readStateStorageKey,
    setLastSeenTimestamp,
    setReadStateRestored,
    setSessionUnreadBoundaryTimestamp
  } = context;
  const handleScrollBeginDrag = useCallback(() => {
    if (isKeyboardVisible) {
      Keyboard.dismiss();
    }
  }, [isKeyboardVisible]);
  useEffect(() => {
    let active = true;
    setReadStateRestored(false);
    setLastSeenTimestamp(null);
    setSessionUnreadBoundaryTimestamp(null);
    if (!readStateStorageKey) {
      setReadStateRestored(true);
      return;
    }
    const restoreReadState = async () => {
      try {
        const storedTimestamp = await readStateStorage.getItemAsync(readStateStorageKey);
        if (!active) return;
        const parsed = Number(storedTimestamp);
        const restoredTimestamp = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        setLastSeenTimestamp(restoredTimestamp);
        setSessionUnreadBoundaryTimestamp(restoredTimestamp);
        setReadStateRestored(true);
      } catch (_error) {
        if (active) {
          setLastSeenTimestamp(null);
          setSessionUnreadBoundaryTimestamp(null);
          setReadStateRestored(true);
        }
      }
    };
    restoreReadState();
    return () => {
      active = false;
    };
  }, [readStateStorage, readStateStorageKey, setLastSeenTimestamp, setReadStateRestored, setSessionUnreadBoundaryTimestamp]);

  // Subscribe to messages
  Object.assign(late.current, {
    handleScrollBeginDrag
  });
  return {
    handleScrollBeginDrag
  };
}
