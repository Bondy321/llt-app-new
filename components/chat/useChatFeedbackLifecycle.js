// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import offlineSyncService from '../../services/offlineSyncService';
export default function useChatFeedbackLifecycle(context, late) {
  const {
    clearImageSendResetTimeout,
    clearReactionFailureTimeout,
    clearSyncBannerTimeout,
    clearTransientFeedbackTimeout,
    lastSuccessfulSyncAt,
    setLastSuccessfulSyncAt,
    showSyncBanner
  } = context;
  const showQueueSyncOutcome = useCallback(({
    replayResult,
    beforeStats = {},
    afterStats = {},
    fallbackErrorMessage = 'Unable to flush queued chat actions.'
  }) => {
    const safeBeforeStats = {
      pending: beforeStats?.pending || 0,
      failed: beforeStats?.failed || 0,
      syncing: beforeStats?.syncing || 0,
      total: beforeStats?.total || 0
    };
    const safeAfterStats = {
      pending: afterStats?.pending || 0,
      failed: afterStats?.failed || 0,
      syncing: afterStats?.syncing || 0,
      total: afterStats?.total || 0
    };
    const processed = replayResult?.data?.processed || 0;
    const syncOutcome = offlineSyncService.formatSyncOutcome({
      syncedCount: processed,
      pendingCount: safeAfterStats.pending,
      failedCount: safeAfterStats.failed,
      source: 'manual-refresh'
    });
    const unifiedStatus = offlineSyncService.deriveUnifiedSyncStatus({
      network: {
        isOnline: true
      },
      backend: {
        isReachable: replayResult?.success !== false,
        isDegraded: !replayResult?.success
      },
      queue: safeAfterStats,
      lastSyncAt: lastSuccessfulSyncAt,
      syncSummary: {
        syncedCount: processed,
        pendingCount: safeAfterStats.pending,
        failedCount: safeAfterStats.failed,
        source: 'manual-refresh'
      }
    });
    if (!replayResult?.success) {
      showSyncBanner({
        contract: {
          ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED,
          canRetry: true,
          description: fallbackErrorMessage || offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED.description
        },
        outcomeText: syncOutcome,
        autoDismissMs: 7000
      });
      return;
    }
    showSyncBanner({
      contract: {
        label: unifiedStatus.label,
        description: unifiedStatus.description,
        icon: unifiedStatus.icon,
        severity: unifiedStatus.severity,
        canRetry: unifiedStatus.canRetry,
        showLastSync: unifiedStatus.showLastSync
      },
      outcomeText: syncOutcome,
      autoDismissMs: safeAfterStats.failed > 0 ? 7000 : safeAfterStats.pending > 0 ? 5500 : 3000
    });
    if (safeAfterStats.failed === 0 && (processed > 0 || safeBeforeStats.total > 0 || safeAfterStats.total > 0)) {
      offlineSyncService.getLastSuccessAt().then(result => {
        if (result?.success) setLastSuccessfulSyncAt(result.data);
      });
    }
  }, [lastSuccessfulSyncAt, showSyncBanner, setLastSuccessfulSyncAt]);
  useEffect(() => {
    let mounted = true;
    offlineSyncService.getLastSuccessAt().then(result => {
      if (mounted && result?.success) {
        setLastSuccessfulSyncAt(result.data);
      }
    });
    return () => {
      mounted = false;
    };
  }, [setLastSuccessfulSyncAt]);
  useEffect(() => {
    return () => {
      clearSyncBannerTimeout();
      clearReactionFailureTimeout();
      clearTransientFeedbackTimeout();
      clearImageSendResetTimeout();
    };
  }, [clearImageSendResetTimeout, clearReactionFailureTimeout, clearSyncBannerTimeout, clearTransientFeedbackTimeout]);

  // Subscribe to offline queue state updates
  Object.assign(late.current, {
    showQueueSyncOutcome
  });
  return {
    showQueueSyncOutcome
  };
}
