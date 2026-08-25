// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import offlineSyncService from '../../services/offlineSyncService';
export default function useChatQueueStatus(context, late) {
  const {
    chatQueueScope,
    imageSendResetTimeoutRef,
    reactionFailureTimeoutRef,
    setQueueStats,
    setReactionFeedbackMessage,
    setSyncBannerContract,
    setSyncBannerOutcomeText,
    setTransientFeedback,
    summarizeChatQueueActions,
    syncBannerTimeoutRef,
    transientFeedbackTimeoutRef
  } = context;
  const getChatQueueStats = useCallback(async () => {
    const actionsResult = await offlineSyncService.getQueuedActions({
      scope: chatQueueScope || undefined
    });
    if (actionsResult?.success && Array.isArray(actionsResult.data)) {
      return summarizeChatQueueActions(actionsResult.data);
    }
    return {
      pending: 0,
      syncing: 0,
      failed: 0,
      total: 0
    };
  }, [chatQueueScope, summarizeChatQueueActions]);
  const refreshQueueStats = useCallback(async () => {
    const stats = await getChatQueueStats();
    setQueueStats(stats);
    return stats;
  }, [getChatQueueStats, setQueueStats]);
  const clearSyncBannerTimeout = useCallback(() => {
    if (syncBannerTimeoutRef.current) {
      clearTimeout(syncBannerTimeoutRef.current);
      syncBannerTimeoutRef.current = null;
    }
  }, [syncBannerTimeoutRef]);
  const clearReactionFailureTimeout = useCallback(() => {
    if (reactionFailureTimeoutRef.current) {
      clearTimeout(reactionFailureTimeoutRef.current);
      reactionFailureTimeoutRef.current = null;
    }
  }, [reactionFailureTimeoutRef]);
  const clearTransientFeedbackTimeout = useCallback(() => {
    if (transientFeedbackTimeoutRef.current) {
      clearTimeout(transientFeedbackTimeoutRef.current);
      transientFeedbackTimeoutRef.current = null;
    }
  }, [transientFeedbackTimeoutRef]);
  const clearImageSendResetTimeout = useCallback(() => {
    if (imageSendResetTimeoutRef.current) {
      clearTimeout(imageSendResetTimeoutRef.current);
      imageSendResetTimeoutRef.current = null;
    }
  }, [imageSendResetTimeoutRef]);
  const showTransientFeedback = useCallback(({
    type = 'info',
    message = '',
    icon = 'information-outline',
    autoDismissMs = 3600
  } = {}) => {
    if (!message) return;
    clearTransientFeedbackTimeout();
    setTransientFeedback({
      type,
      message,
      icon
    });
    if (autoDismissMs > 0) {
      transientFeedbackTimeoutRef.current = setTimeout(() => {
        setTransientFeedback(null);
      }, autoDismissMs);
    }
  }, [clearTransientFeedbackTimeout, setTransientFeedback, transientFeedbackTimeoutRef]);
  const showReactionFailureFeedback = useCallback((message = 'Could not update reaction. Please try again.') => {
    clearReactionFailureTimeout();
    setReactionFeedbackMessage(message);
    reactionFailureTimeoutRef.current = setTimeout(() => {
      setReactionFeedbackMessage('');
    }, 3200);
  }, [clearReactionFailureTimeout, reactionFailureTimeoutRef, setReactionFeedbackMessage]);
  const showSyncBanner = useCallback(({
    contract,
    outcomeText = '',
    autoDismissMs = 4500
  }) => {
    clearSyncBannerTimeout();
    setSyncBannerContract(contract);
    setSyncBannerOutcomeText(outcomeText);
    if (autoDismissMs > 0) {
      syncBannerTimeoutRef.current = setTimeout(() => {
        setSyncBannerContract(null);
        setSyncBannerOutcomeText('');
      }, autoDismissMs);
    }
  }, [clearSyncBannerTimeout, setSyncBannerContract, setSyncBannerOutcomeText, syncBannerTimeoutRef]);
  Object.assign(late.current, {
    getChatQueueStats,
    refreshQueueStats,
    clearSyncBannerTimeout,
    clearReactionFailureTimeout,
    clearTransientFeedbackTimeout,
    clearImageSendResetTimeout,
    showTransientFeedback,
    showReactionFailureFeedback,
    showSyncBanner
  });
  return {
    getChatQueueStats,
    refreshQueueStats,
    clearSyncBannerTimeout,
    clearReactionFailureTimeout,
    clearTransientFeedbackTimeout,
    clearImageSendResetTimeout,
    showTransientFeedback,
    showReactionFailureFeedback,
    showSyncBanner
  };
}
