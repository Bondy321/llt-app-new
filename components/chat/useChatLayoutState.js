// screens/ChatScreen.js - Premium Chat Experience
import { useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { SPACING } from '../../theme';
export default function useChatLayoutState(context, late) {
  const {
    composerBottomInset,
    composerHeight,
    imageSendState,
    isKeyboardVisible,
    keyboardHeight
  } = context;
  const floatingUiBottomInset = useMemo(() => {
    const safeComposerHeight = composerHeight > 0 ? composerHeight : 72 + composerBottomInset;
    const keyboardLift = Platform.OS === 'android' && isKeyboardVisible ? Math.max(keyboardHeight - composerBottomInset, 0) : 0;
    return safeComposerHeight + keyboardLift + SPACING.sm;
  }, [composerHeight, composerBottomInset, isKeyboardVisible, keyboardHeight]);
  const isImageUploading = imageSendState.status === 'uploading';

  // Refs
  // Refs
  const messageListRef = useRef(null);
  const messagesRef = useRef([]);
  const typingTimeoutRef = useRef(null);
  const syncBannerTimeoutRef = useRef(null);
  const transientFeedbackTimeoutRef = useRef(null);
  const lastLiveMessageCursorRef = useRef(null);
  const lastReadMarkAtRef = useRef(0);
  const rowOffsetsRef = useRef({});
  const listViewportHeightRef = useRef(0);
  const listContentHeightRef = useRef(0);
  const preserveScrollAfterPrependRef = useRef(null);
  const reactionFailureTimeoutRef = useRef(null);
  const imageSendResetTimeoutRef = useRef(null);
  const imageSendAttemptRef = useRef(null);
  const inFlightReactionKeysRef = useRef(new Set());
  const pendingJumpIndexRef = useRef(null);
  const notificationTargetRef = useRef({
    key: null,
    status: 'idle'
  });
  const isAtBottomRef = useRef(true);
  Object.assign(late.current, {
    floatingUiBottomInset,
    isImageUploading,
    messageListRef,
    messagesRef,
    typingTimeoutRef,
    syncBannerTimeoutRef,
    transientFeedbackTimeoutRef,
    lastLiveMessageCursorRef,
    lastReadMarkAtRef,
    rowOffsetsRef,
    listViewportHeightRef,
    listContentHeightRef,
    preserveScrollAfterPrependRef,
    reactionFailureTimeoutRef,
    imageSendResetTimeoutRef,
    imageSendAttemptRef,
    inFlightReactionKeysRef,
    pendingJumpIndexRef,
    notificationTargetRef,
    isAtBottomRef
  });
  return {
    floatingUiBottomInset,
    isImageUploading,
    messageListRef,
    messagesRef,
    typingTimeoutRef,
    syncBannerTimeoutRef,
    transientFeedbackTimeoutRef,
    lastLiveMessageCursorRef,
    lastReadMarkAtRef,
    rowOffsetsRef,
    listViewportHeightRef,
    listContentHeightRef,
    preserveScrollAfterPrependRef,
    reactionFailureTimeoutRef,
    imageSendResetTimeoutRef,
    imageSendAttemptRef,
    inFlightReactionKeysRef,
    pendingJumpIndexRef,
    notificationTargetRef,
    isAtBottomRef
  };
}
