// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import offlineSyncService from '../../services/offlineSyncService';
import * as chatService from '../../services/chatService';
import * as photoService from '../../services/photoService';
export default function useChatManualSync(context, late) {
  const {
    chatQueueScope,
    getChatQueueStats,
    internalDriverChat,
    isConnected,
    queueStats,
    refreshQueueStats,
    showQueueSyncOutcome,
    showSyncBanner,
    tourId
  } = context;
  const handleManualSync = useCallback(async ({
    retryFailedOnly = false
  } = {}) => {
    if (!isConnected) {
      showSyncBanner({
        contract: offlineSyncService.UNIFIED_SYNC_STATES.OFFLINE_NO_NETWORK,
        outcomeText: queueStats.total > 0 ? `${queueStats.total} chat item${queueStats.total === 1 ? '' : 's'} safely queued` : 'No chat items waiting to sync',
        autoDismissMs: 5500
      });
      return;
    }
    try {
      const beforeStats = await getChatQueueStats();
      if (retryFailedOnly) {
        await offlineSyncService.retryFailedActions({
          types: internalDriverChat ? ['INTERNAL_CHAT_MESSAGE'] : ['CHAT_MESSAGE', 'PHOTO_UPLOAD'],
          tourId,
          scope: chatQueueScope || undefined
        });
      }
      const replayResult = await offlineSyncService.replayQueue({
        services: internalDriverChat ? {
          chatService
        } : {
          chatService,
          photoService
        },
        scope: chatQueueScope || undefined
      });
      const afterStats = await refreshQueueStats();
      showQueueSyncOutcome({
        replayResult,
        beforeStats,
        afterStats
      });
    } catch (error) {
      showQueueSyncOutcome({
        replayResult: {
          success: false,
          error: error?.message || 'Unable to flush queued chat actions.'
        },
        fallbackErrorMessage: 'Unable to flush queued chat actions.'
      });
    }
  }, [chatQueueScope, getChatQueueStats, internalDriverChat, isConnected, queueStats.total, refreshQueueStats, showQueueSyncOutcome, showSyncBanner, tourId]);
  Object.assign(late.current, {
    handleManualSync
  });
  return {
    handleManualSync
  };
}
