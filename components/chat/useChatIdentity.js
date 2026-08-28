// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect, useMemo } from 'react';
import offlineSyncService from '../../services/offlineSyncService';
import { maskIdentifier } from '../../services/loggerService';
import { isRealtimeKeySegment, resolveChatStatusActorId, resolveRealtimeActorId, toRealtimeKeySegment } from '../../services/identityService';
import { maskReactionDebugIds, summarizeReactionDebugId, rawReactionDebugIds, logChatReactionDebug } from "./chatShared";
export default function useChatIdentity(context, late) {
  const {
    bookingData,
    canonicalIdentity,
    currentUser,
    internalDriverChat,
    isDriver,
    offlineSessionScope,
    passengerStableId,
    principalId,
    tourId
  } = context;
  const authUid = canonicalIdentity?.authUid || currentUser?.uid || null;
  const realtimeActorId = useMemo(() => {
    // Message, reaction, and read-state compatibility keeps the established
    // actor key. Presence and typing use statusActorId below instead.
    if (internalDriverChat && isDriver && principalId.startsWith('driver:')) {
      return isRealtimeKeySegment(principalId) ? principalId : toRealtimeKeySegment(principalId);
    }
    return resolveRealtimeActorId({
      authUid,
      principalId
    }) || principalId;
  }, [authUid, internalDriverChat, isDriver, principalId]);
  const statusActorId = useMemo(() => resolveChatStatusActorId({
    sessionScope: offlineSessionScope
  }), [offlineSessionScope]);
  const currentReactionUserIds = useMemo(() => {
    const candidates = [realtimeActorId, principalId, passengerStableId, authUid, toRealtimeKeySegment(principalId), toRealtimeKeySegment(passengerStableId)];
    return Array.from(new Set(candidates.filter(Boolean)));
  }, [authUid, passengerStableId, principalId, realtimeActorId]);
  const userName = bookingData?.passengerNames?.[0] || 'Tour Participant';
  const chatQueueScope = useMemo(() => offlineSyncService.normalizeSessionScope(offlineSessionScope) || offlineSyncService.normalizeSessionScope({
    tourId,
    principalId,
    role: canonicalIdentity?.principalType === 'driver' ? 'driver' : 'passenger',
    authUid,
    cacheOwnerId: bookingData?.id || principalId
  }), [authUid, bookingData?.id, canonicalIdentity?.principalType, offlineSessionScope, principalId, tourId]);
  const chatQueueActionTypes = useMemo(() => new Set(internalDriverChat ? ['INTERNAL_CHAT_MESSAGE'] : ['CHAT_MESSAGE', 'PHOTO_UPLOAD']), [internalDriverChat]);
  const summarizeChatQueueActions = useCallback((actions = []) => (Array.isArray(actions) ? actions : []).reduce((summary, action) => {
    if (!chatQueueActionTypes.has(action?.type) || action?.status === 'completed') return summary;
    if (action.status === 'uploading' || action.status === 'syncing') summary.syncing += 1;else if (action.status === 'failed') summary.failed += 1;else summary.pending += 1;
    summary.total += 1;
    return summary;
  }, {
    pending: 0,
    syncing: 0,
    failed: 0,
    total: 0
  }), [chatQueueActionTypes]);
  useEffect(() => {
    logChatReactionDebug('chat_reaction_actor_context', {
      tourId,
      principalIdMasked: maskIdentifier(principalId),
      passengerStableIdMasked: maskIdentifier(passengerStableId),
      authUidMasked: maskIdentifier(authUid),
      realtimeActorIdMasked: maskIdentifier(realtimeActorId),
      realtimeActorDiffersFromPrincipal: realtimeActorId !== principalId,
      principalKeyIsRealtimeSafe: isRealtimeKeySegment(principalId),
      stableKeyIsRealtimeSafe: passengerStableId ? isRealtimeKeySegment(passengerStableId) : null,
      realtimeActorKeyIsRealtimeSafe: isRealtimeKeySegment(realtimeActorId),
      aliasCount: currentReactionUserIds.length,
      aliasIdsMasked: maskReactionDebugIds(currentReactionUserIds),
      aliasKeys: rawReactionDebugIds(currentReactionUserIds),
      principalKey: summarizeReactionDebugId(principalId),
      stablePassengerKey: summarizeReactionDebugId(passengerStableId),
      reactionActorKey: summarizeReactionDebugId(realtimeActorId)
    });
  }, [authUid, currentReactionUserIds, passengerStableId, principalId, realtimeActorId, tourId]);
  const requiresPassengerStableIdForWrites = !isDriver && canonicalIdentity?.principalType === 'passenger' && principalId !== 'anonymous';
  Object.assign(late.current, {
    authUid,
    realtimeActorId,
    statusActorId,
    currentReactionUserIds,
    userName,
    chatQueueScope,
    chatQueueActionTypes,
    summarizeChatQueueActions,
    requiresPassengerStableIdForWrites
  });
  return {
    authUid,
    realtimeActorId,
    statusActorId,
    currentReactionUserIds,
    userName,
    chatQueueScope,
    chatQueueActionTypes,
    summarizeChatQueueActions,
    requiresPassengerStableIdForWrites
  };
}
