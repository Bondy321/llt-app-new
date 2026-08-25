// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useMemo } from 'react';
import { createPersistenceProvider } from '../../services/persistenceProvider';
import logger, { maskIdentifier } from '../../services/loggerService';
import { recordBreadcrumb } from '../../services/crashDiagnosticsService';
import { isRealtimeKeySegment } from '../../services/identityService';
import { SPACING } from '../../theme';
import { SWIPE_REPLY_HINT_KEY_PREFIX } from "./chatShared";
export default function useChatSenderIdentity(context, late) {
  const {
    authUid,
    canonicalIdentity,
    currentUser,
    identityBindingSource,
    internalDriverChat,
    isDriver,
    passengerStableId,
    principalId,
    requiresPassengerStableIdForWrites,
    showAttachmentMenu,
    tourId,
    userName
  } = context;
  const logSenderIdentityPath = useCallback(() => {
    if (canonicalIdentity?.principalType === 'driver') {
      logger.info('ChatScreen', 'chat_sender_driver_principal_used', {
        tourId,
        source: identityBindingSource
      });
      return;
    }
    if (passengerStableId) {
      logger.info('ChatScreen', 'chat_sender_stable_id_used', {
        tourId,
        source: identityBindingSource
      });
      return;
    }
    logger.warn('ChatScreen', 'chat_sender_identity_missing', {
      tourId,
      source: identityBindingSource,
      currentUserUidPresent: Boolean(currentUser?.uid)
    });
  }, [canonicalIdentity?.principalType, passengerStableId, tourId, identityBindingSource, currentUser?.uid]);
  const buildChatSenderInfo = useCallback(() => ({
    name: userName,
    userId: principalId,
    principalId,
    principalType: canonicalIdentity?.principalType || (isDriver ? 'driver' : 'passenger'),
    isDriver,
    ...(authUid ? {
      authUid
    } : {}),
    ...(passengerStableId ? {
      stablePassengerId: passengerStableId,
      senderStableId: passengerStableId
    } : {})
  }), [authUid, canonicalIdentity?.principalType, isDriver, passengerStableId, principalId, userName]);
  const traceChatImageSend = useCallback((event, data = {}) => {
    recordBreadcrumb('ChatImage', event, {
      tourId,
      chatScope: internalDriverChat ? 'internal' : 'group',
      principalType: canonicalIdentity?.principalType || (isDriver ? 'driver' : 'passenger'),
      isDriver,
      hasAuthUid: Boolean(authUid),
      authUidMasked: maskIdentifier(authUid),
      principalIdMasked: maskIdentifier(principalId),
      passengerStableIdMasked: maskIdentifier(passengerStableId),
      hasPassengerStableId: Boolean(passengerStableId),
      requiresPassengerStableIdForWrites,
      principalKeyIsRealtimeSafe: isRealtimeKeySegment(principalId),
      stableKeyIsRealtimeSafe: passengerStableId ? isRealtimeKeySegment(passengerStableId) : null,
      ...data
    }, {
      remote: true,
      reason: `ChatImage:${event}`
    });
  }, [authUid, canonicalIdentity?.principalType, internalDriverChat, isDriver, passengerStableId, principalId, requiresPassengerStableIdForWrites, tourId]);
  const draftStorage = useMemo(() => createPersistenceProvider({
    namespace: 'LLT_CHAT_DRAFTS'
  }), []);
  const readStateStorage = useMemo(() => createPersistenceProvider({
    namespace: 'LLT_CHAT_READ_STATE'
  }), []);
  const uxHintStorage = useMemo(() => createPersistenceProvider({
    namespace: 'LLT_CHAT_UX_HINTS'
  }), []);
  const moderationStorage = useMemo(() => createPersistenceProvider({
    namespace: 'LLT_CONTENT_MODERATION'
  }), []);
  const draftStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `draft_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const readStateStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `last_seen_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const swipeReplyHintStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `${SWIPE_REPLY_HINT_KEY_PREFIX}_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const hiddenMessagesStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `hidden_messages_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const mutedSendersStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `muted_senders_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const listBottomSpacerHeight = useMemo(() => {
    const attachmentMenuLift = showAttachmentMenu ? SPACING.sm : 0;
    return SPACING.sm + attachmentMenuLift;
  }, [showAttachmentMenu]);
  Object.assign(late.current, {
    logSenderIdentityPath,
    buildChatSenderInfo,
    traceChatImageSend,
    draftStorage,
    readStateStorage,
    uxHintStorage,
    moderationStorage,
    draftStorageKey,
    readStateStorageKey,
    swipeReplyHintStorageKey,
    hiddenMessagesStorageKey,
    mutedSendersStorageKey,
    listBottomSpacerHeight
  });
  return {
    logSenderIdentityPath,
    buildChatSenderInfo,
    traceChatImageSend,
    draftStorage,
    readStateStorage,
    uxHintStorage,
    moderationStorage,
    draftStorageKey,
    readStateStorageKey,
    swipeReplyHintStorageKey,
    hiddenMessagesStorageKey,
    mutedSendersStorageKey,
    listBottomSpacerHeight
  };
}
