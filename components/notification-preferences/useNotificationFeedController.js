import { useEffect, useRef, useState } from 'react';

import logger from '../../services/loggerService';
import {
  acknowledgeCurrentNotices,
  acknowledgeCurrentNotice,
  subscribeToNotificationFeed,
} from '../../services/notificationInboxService';
import { parseTimestampMs } from '../../services/timeUtils';

const formatTimestamp = (isoDate) => {
  const parsedMs = parseTimestampMs(isoDate);
  if (!Number.isFinite(parsedMs)) return '';
  return new Date(parsedMs).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function useNotificationFeedController({
  appSession,
  cacheOwnerId,
  isOnboarding,
  mountedRef,
  onNavigate,
  tourId,
  userId,
}) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const scopeKey = `${userId || ''}:${appSession?.sessionId || ''}:${appSession?.principalId || ''}:${tourId || ''}`;
  const contextRef = useRef(null);
  const feedScopeRef = useRef(null);
  contextRef.current = { authUid: userId, appSession, scopeKey };

  useEffect(() => {
    feedScopeRef.current = null;
    setItems([]); setUnreadCount(0); setBusy(false);
    const isCurrent = () => mountedRef.current && contextRef.current.scopeKey === scopeKey;
    if (isOnboarding || !tourId || !userId) {
      setItems([]);
      setUnreadCount(0);
      setLoading(false);
      setError('');
      setStale(false);
      return undefined;
    }

    setLoading(true);
    setError('');
    try {
      return subscribeToNotificationFeed({
        tourId,
        userId,
        cacheOwnerId,
        readStateOwnerId: appSession?.principalId,
        onUpdate: ({ items: nextItems, unreadCount: nextUnreadCount, stale: nextStale = false }) => {
          if (!isCurrent()) return;
          feedScopeRef.current = scopeKey;
          setItems(nextItems);
          setUnreadCount(nextUnreadCount);
          setLoading(false);
          setError('');
          setStale(nextStale);
        },
        onError: (feedError, recovery = {}) => {
          if (!isCurrent()) return;
          logger.warn('NotificationPreferences', 'Tour update feed failed', {
            error: feedError?.message || String(feedError),
          });
          setLoading(false);
          setStale(recovery.stale === true && recovery.hasItems === true);
          setError(recovery.hasPersistedCache
            ? 'Live updates could not be refreshed. Saved updates are still shown below.'
            : recovery.hasItems
              ? 'Live updates could not be refreshed. Your current updates remain shown below.'
              : 'Tour updates could not be refreshed. Your alert preferences are still available below.');
        },
      });
    } catch (feedError) {
      logger.warn('NotificationPreferences', 'Tour update feed could not start', {
        error: feedError?.message || String(feedError),
      });
      setLoading(false);
      setError('Tour updates are temporarily unavailable.');
      return undefined;
    }
  }, [appSession?.principalId, scopeKey, cacheOwnerId, isOnboarding, mountedRef, retryKey, tourId, userId]);

  const retry = () => {
    setLoading(true);
    setError('');
    setRetryKey((value) => value + 1);
  };

  const open = async (item) => {
    if (!item || feedScopeRef.current !== scopeKey) return;
    onNavigate?.(item.screen, {
      tourId: item.tourId,
      noticeId: item.noticeId,
      messageId: item.messageId,
      departureKey: item.departureKey,
      revision: item.revision,
      changedSections: item.changedSections,
      critical: item.critical === true,
      requiresAcknowledgement: item.requiresAcknowledgement === true,
      fromNotification: true,
    });
    if (!item.isRead) {
      try {
        await acknowledgeCurrentNotice({ getContext: () => contextRef.current,
          tourId: item.tourId, noticeId: item.noticeId });
      } catch (readError) {
        logger.warn('NotificationPreferences', 'Tour update read state could not be saved', {
          noticeType: item.type,
          error: readError?.message || String(readError),
        });
        if (mountedRef.current && contextRef.current.scopeKey === scopeKey) setError('The update opened, but could not be marked as read. Reconnect and open it again.');
      }
    }
  };

  const markAllRead = async () => {
    if (busy || unreadCount === 0 || feedScopeRef.current !== scopeKey) return;
    setBusy(true);
    try {
      await acknowledgeCurrentNotices({
        getContext: () => contextRef.current,
        tourId,
        noticeIds: items.filter((item) => !item.isRead).map((item) => item.noticeId),
      });
    } catch (markError) {
      logger.warn('NotificationPreferences', 'Mark-all-read failed', {
        error: markError?.message || String(markError),
      });
      if (contextRef.current.scopeKey === scopeKey) setError('Updates could not be marked as read. Please retry.');
    } finally {
      if (mountedRef.current && contextRef.current.scopeKey === scopeKey) setBusy(false);
    }
  };

  return { busy, error, formatTimestamp, items, loading, markAllRead, open, retry, stale, unreadCount };
}
