// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { getChatMessagesPage } from '../../services/chatService';
import offlineSyncService from '../../services/offlineSyncService';
import * as chatService from '../../services/chatService';
import * as photoService from '../../services/photoService';
import { CHAT_PAGE_MESSAGE_LIMIT } from "./chatShared";
export default function useChatHistory(context, late) {
  const {
    chatQueueScope,
    currentScrollYRef,
    getChatQueueStats,
    internalDriverChat,
    isConnected,
    listContentHeightRef,
    loadingOlderMessages,
    messages,
    preserveScrollAfterPrependRef,
    refreshQueueStats,
    setHasMoreHistory,
    setLoadingOlderMessages,
    setMessages,
    setRefreshing,
    showQueueSyncOutcome,
    showSyncBanner,
    showTransientFeedback,
    tourId
  } = context;
  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const beforeStats = await getChatQueueStats();
      if (!isConnected) {
        showSyncBanner({
          contract: offlineSyncService.UNIFIED_SYNC_STATES.OFFLINE_NO_NETWORK,
          outcomeText: beforeStats.total > 0 ? `${beforeStats.total} chat item${beforeStats.total === 1 ? '' : 's'} safely queued` : 'Showing the latest messages saved on this device',
          autoDismissMs: 5500
        });
        return;
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
          error: error?.message || 'Unable to refresh chat right now.'
        },
        fallbackErrorMessage: 'Unable to refresh chat right now.'
      });
    } finally {
      setRefreshing(false);
    }
  }, [chatQueueScope, getChatQueueStats, internalDriverChat, isConnected, refreshQueueStats, setRefreshing, showQueueSyncOutcome, showSyncBanner]);
  const handleLoadOlderMessages = useCallback(async () => {
    if (!tourId || loadingOlderMessages || messages.length === 0) return;
    const cursor = getOldestMessageCursor(messages);
    if (!cursor) {
      setHasMoreHistory(false);
      return;
    }
    preserveScrollAfterPrependRef.current = {
      previousContentHeight: listContentHeightRef.current,
      previousScrollY: currentScrollYRef.current
    };
    setLoadingOlderMessages(true);
    try {
      const result = await getChatMessagesPage({
        tourId,
        scope: internalDriverChat ? 'internal' : 'group',
        beforeTimestamp: cursor.beforeTimestamp,
        beforeMessageId: cursor.beforeMessageId,
        limit: CHAT_PAGE_MESSAGE_LIMIT
      });
      if (!result?.success) {
        preserveScrollAfterPrependRef.current = null;
        showTransientFeedback({
          type: 'warning',
          icon: 'cloud-alert-outline',
          message: 'Older messages could not be loaded right now.'
        });
        return;
      }
      setHasMoreHistory(Boolean(result.hasMore));
      if (Array.isArray(result.messages) && result.messages.length > 0) {
        setMessages(prevMessages => mergeMessagesById(result.messages, prevMessages));
      } else {
        preserveScrollAfterPrependRef.current = null;
      }
    } catch (_error) {
      preserveScrollAfterPrependRef.current = null;
      showTransientFeedback({
        type: 'warning',
        icon: 'cloud-alert-outline',
        message: 'Older messages could not be loaded right now.'
      });
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [currentScrollYRef, internalDriverChat, listContentHeightRef, loadingOlderMessages, messages, preserveScrollAfterPrependRef, setHasMoreHistory, setLoadingOlderMessages, setMessages, showTransientFeedback, tourId]);

  // Format time helper
  // Format time helper
  const formatTime = useCallback(timestamp => {
    return formatChatTimestamp(timestamp);
  }, []);

  // Parse message text for links
  Object.assign(late.current, {
    handleRefresh,
    handleLoadOlderMessages,
    formatTime
  });
  return {
    handleRefresh,
    handleLoadOlderMessages,
    formatTime
  };
}
