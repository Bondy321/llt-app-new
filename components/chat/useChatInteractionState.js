// screens/ChatScreen.js - Premium Chat Experience
import { useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCurrentAuthUser } from '../../services/authStateService';
import { getCanonicalIdentity } from '../../services/identityService';
import { SPACING } from '../../theme';
import { DEFAULT_CHAT_WINDOW_WIDTH } from "./chatShared";
export default function useChatInteractionState(context, late) {
  const {
    bookingData,
    canonicalIdentityProp,
    identityBindingProp,
    internalDriverChat
  } = context;
  const [viewingImage, setViewingImage] = useState(null);
  const [hiddenMessageIds, setHiddenMessageIds] = useState({});
  const [mutedSenderIds, setMutedSenderIds] = useState({});
  const [reactionFeedbackMessage, setReactionFeedbackMessage] = useState('');
  const [replyJumpFeedbackMessage, setReplyJumpFeedbackMessage] = useState('');
  const [highlightedReplyTargetMessageId, setHighlightedReplyTargetMessageId] = useState(null);
  const insets = useSafeAreaInsets();
  const {
    width: windowWidth
  } = useWindowDimensions();
  const resolvedWindowWidth = windowWidth || DEFAULT_CHAT_WINDOW_WIDTH;
  const chatImageSize = useMemo(() => Math.max(120, Math.min(260, resolvedWindowWidth * 0.55)), [resolvedWindowWidth]);
  const replyBubbleMinWidth = useMemo(() => Math.max(120, Math.min(260, resolvedWindowWidth * 0.58)), [resolvedWindowWidth]);
  const fullScreenImageStyle = useMemo(() => {
    const size = Math.max(1, resolvedWindowWidth);
    return {
      width: size,
      height: size
    };
  }, [resolvedWindowWidth]);
  const composerBottomInset = insets.bottom > 0 ? Math.max(insets.bottom, SPACING.md) : SPACING.md;
  const currentUser = getCurrentAuthUser();
  const {
    identityBinding,
    identityBindingSource
  } = useMemo(() => {
    const hasIdentityBindingProp = identityBindingProp && typeof identityBindingProp === 'object';
    const sourceBinding = hasIdentityBindingProp ? identityBindingProp : bookingData?.identityBinding && typeof bookingData.identityBinding === 'object' ? bookingData.identityBinding : {};
    const rawStablePassengerId = sourceBinding?.stablePassengerId || bookingData?.stablePassengerId || null;
    const normalizedStablePassengerId = typeof rawStablePassengerId === 'string' ? rawStablePassengerId.trim() : '';
    return {
      identityBinding: {
        ...sourceBinding,
        stablePassengerId: normalizedStablePassengerId || null
      },
      identityBindingSource: hasIdentityBindingProp ? 'prop' : 'bookingData'
    };
  }, [identityBindingProp, bookingData?.identityBinding, bookingData?.stablePassengerId]);
  const isDriver = bookingData?.isDriver === true;
  const chatScope = internalDriverChat ? 'internal' : 'group';
  const canonicalIdentity = useMemo(() => canonicalIdentityProp || getCanonicalIdentity({
    authUser: currentUser,
    bookingData,
    identityBinding
  }), [canonicalIdentityProp, currentUser, bookingData, identityBinding]);
  const principalId = canonicalIdentity?.principalId || 'anonymous';
  const passengerStableId = canonicalIdentity?.stablePassengerId || null;
  Object.assign(late.current, {
    viewingImage,
    setViewingImage,
    hiddenMessageIds,
    setHiddenMessageIds,
    mutedSenderIds,
    setMutedSenderIds,
    reactionFeedbackMessage,
    setReactionFeedbackMessage,
    replyJumpFeedbackMessage,
    setReplyJumpFeedbackMessage,
    highlightedReplyTargetMessageId,
    setHighlightedReplyTargetMessageId,
    insets,
    windowWidth,
    resolvedWindowWidth,
    chatImageSize,
    replyBubbleMinWidth,
    fullScreenImageStyle,
    composerBottomInset,
    currentUser,
    identityBinding,
    identityBindingSource,
    isDriver,
    chatScope,
    canonicalIdentity,
    principalId,
    passengerStableId
  });
  return {
    viewingImage,
    setViewingImage,
    hiddenMessageIds,
    setHiddenMessageIds,
    mutedSenderIds,
    setMutedSenderIds,
    reactionFeedbackMessage,
    setReactionFeedbackMessage,
    replyJumpFeedbackMessage,
    setReplyJumpFeedbackMessage,
    highlightedReplyTargetMessageId,
    setHighlightedReplyTargetMessageId,
    insets,
    windowWidth,
    resolvedWindowWidth,
    chatImageSize,
    replyBubbleMinWidth,
    fullScreenImageStyle,
    composerBottomInset,
    currentUser,
    identityBinding,
    identityBindingSource,
    isDriver,
    chatScope,
    canonicalIdentity,
    principalId,
    passengerStableId
  };
}
